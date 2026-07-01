/**
 * The concrete AgentRunner.
 *
 * It composes three things and owns none of them:
 *  - an ExecProvider (sandbox-core, exec only — the single DOWN dependency),
 *  - an AgentBackend (codex today), which knows how to launch the agent and map
 *    its ACP updates, and
 *  - `connectAgent`, which speaks the protocol over the exec stream.
 *
 * Per session it launches the agent process inside the target env, performs the
 * ACP handshake, and then just forwards turns and permission decisions. It never
 * imports the chat gateway; chat reaches the agent only as orchestrator-mediated
 * tools. Secret resolution (opaque `llmKeyRef` -> real key) is injected so the
 * runner never embeds a key store.
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  CreateAgentSessionRequest,
  ExecRequest,
  MountSpec,
  PermissionDecision,
  TurnRequest,
} from '@devspace/contracts';
import type { ExecStream } from '@devspace/sandbox-core';
import type { AcpSession } from './acp/connection.js';
import { connectAgent } from './acp/connection.js';
import type { AgentBackend } from './backends/codex.js';
import { AGENT_RUNTIME_PATH, codexBackend } from './backends/codex.js';
import type { AgentRunner } from './index.js';

/** The exact slice of sandbox-core the runner needs: launch a process, get a stream. */
export interface ExecProvider {
  exec(envId: string, req: ExecRequest): Promise<ExecStream>;
}

/** Resolve an opaque llmKeyRef to a real API key (orchestrator-provided). */
export type SecretResolver = (ref: string) => Promise<string | undefined>;

export interface AgentRunnerDeps {
  exec: ExecProvider;
  /** Backends by AgentKind. Defaults to `{ codex }`. */
  backends?: Record<string, AgentBackend>;
  /** Resolve `llmKeyRef` -> key. When omitted, the key is assumed pre-injected. */
  resolveSecret?: SecretResolver;
  onLog?: (line: string) => void;
}

interface SessionRecord {
  envId: string;
  session: AcpSession;
}

/**
 * Standard mount entry that delivers the agent runtime into an env. The
 * orchestrator adds this to `CreateEnvironmentRequest.mounts` before provisioning
 * (ADR-0003). To sandbox-core it is an opaque read-only volume mount.
 */
export function agentRuntimeMount(source = 'devspace-agent-runtime'): MountSpec {
  return { source, target: AGENT_RUNTIME_PATH, ro: true };
}

export class DefaultAgentRunner implements AgentRunner {
  private readonly exec: ExecProvider;
  private readonly backends: Record<string, AgentBackend>;
  private readonly resolveSecret?: SecretResolver;
  private readonly onLog: (line: string) => void;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(deps: AgentRunnerDeps) {
    this.exec = deps.exec;
    this.backends = deps.backends ?? { [codexBackend.kind]: codexBackend };
    this.resolveSecret = deps.resolveSecret;
    this.onLog = deps.onLog ?? (() => {});
  }

  async createSession(req: CreateAgentSessionRequest): Promise<{ agentSessionId: string }> {
    const backend = this.backends[req.agentKind];
    if (!backend) throw new Error(`no backend for agent kind "${req.agentKind}"`);

    const apiKey = this.resolveSecret ? await this.resolveSecret(req.llmKeyRef) : undefined;
    const stream = await this.exec.exec(
      req.envId,
      backend.launchCommand({ workspacePath: req.workspacePath, model: req.model, apiKey }),
    );

    const session = await connectAgent(stream, backend, {
      workspacePath: req.workspacePath,
      onLog: this.onLog,
    });

    const agentSessionId = `agent_${randomUUID()}`;
    this.sessions.set(agentSessionId, { envId: req.envId, session });
    return { agentSessionId };
  }

  runTurn(agentSessionId: string, req: TurnRequest): AsyncIterable<AgentEvent> {
    const record = this.require(agentSessionId);
    return record.session.runTurn(req.prompt);
  }

  async decidePermission(agentSessionId: string, decision: PermissionDecision): Promise<void> {
    const record = this.require(agentSessionId);
    if (!record.session.decide(decision)) {
      throw new Error(`no pending permission request "${decision.requestId}"`);
    }
  }

  async closeSession(agentSessionId: string): Promise<void> {
    const record = this.sessions.get(agentSessionId);
    if (!record) return;
    this.sessions.delete(agentSessionId);
    await record.session.close();
  }

  private require(agentSessionId: string): SessionRecord {
    const record = this.sessions.get(agentSessionId);
    if (!record) throw new Error(`unknown agent session "${agentSessionId}"`);
    return record;
  }
}
