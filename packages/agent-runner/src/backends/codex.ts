/**
 * Codex backend (first ACP target).
 *
 * An AgentBackend isolates everything agent-specific behind two concerns:
 *  - launchCommand(): how to start the ACP agent process INSIDE the sandbox
 *  - mapEvent():      how to translate raw ACP session updates -> AgentEvent
 *
 * A second agent is a new backend, not a rewrite of the runner. codex-acp speaks
 * standard ACP, so `mapEvent` delegates to the shared `mapSessionUpdate`; a
 * non-conforming agent would override it here.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentEvent, ExecRequest } from '@devspace/contracts';
import { mapSessionUpdate } from '../acp/events.js';

export interface AgentBackend {
  readonly kind: string;
  /**
   * Command to run the ACP agent inside the env. Uses the self-contained Node
   * shipped in the mounted agent-runtime volume so the base image needs no Node.
   */
  launchCommand(opts: LaunchOptions): ExecRequest;
  /** Map a raw ACP session update (shape varies by agent) into a normalized event. */
  mapEvent(update: unknown): AgentEvent | null;
}

export interface LaunchOptions {
  workspacePath: string;
  model?: string;
  /**
   * Resolved LLM API key. The orchestrator resolves the opaque `llmKeyRef` to a
   * real value and hands it here; it is injected as a process env var on exec and
   * never written to the workspace disk or logged.
   */
  apiKey?: string;
}

export const AGENT_RUNTIME_PATH = '/opt/agent-runtime';

export const codexBackend: AgentBackend = {
  kind: 'codex',
  launchCommand({ workspacePath, model, apiKey }) {
    const env: Record<string, string> = {};
    if (model) env.CODEX_MODEL = model;
    if (apiKey) env.OPENAI_API_KEY = apiKey;
    return {
      cmd: [`${AGENT_RUNTIME_PATH}/bin/node`, `${AGENT_RUNTIME_PATH}/codex-acp`],
      cwd: workspacePath,
      env,
      tty: false,
    };
  },
  mapEvent(update) {
    return mapSessionUpdate(update as SessionUpdate);
  },
};
