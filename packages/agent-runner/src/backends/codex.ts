/**
 * Codex backend (first ACP target).
 *
 * An AgentBackend isolates everything agent-specific behind two concerns:
 *  - launchCommand(): how to start the ACP agent process INSIDE the sandbox
 *  - mapEvent():      how to translate raw ACP session updates -> AgentEvent
 *
 * A second agent is a new backend, not a rewrite of the runner.
 */
import type { AgentEvent } from '@devspace/contracts';
import type { ExecRequest } from '@devspace/contracts';

export interface AgentBackend {
  readonly kind: string;
  /**
   * Command to run the ACP agent inside the env. Uses the self-contained Node
   * shipped in the mounted agent-runtime volume so the base image needs no Node.
   */
  launchCommand(opts: { workspacePath: string; model?: string }): ExecRequest;
  /** Map a raw ACP notification (shape varies by agent) into a normalized event. */
  mapEvent(raw: unknown): AgentEvent | null;
}

export const AGENT_RUNTIME_PATH = '/opt/agent-runtime';

export const codexBackend: AgentBackend = {
  kind: 'codex',
  launchCommand({ workspacePath, model }) {
    const env: Record<string, string> = {};
    if (model) env.CODEX_MODEL = model;
    return {
      cmd: [`${AGENT_RUNTIME_PATH}/bin/node`, `${AGENT_RUNTIME_PATH}/codex-acp`],
      cwd: workspacePath,
      env,
      tty: false,
    };
  },
  mapEvent(raw) {
    // M2: translate codex-acp's session/update JSON-RPC notifications.
    // Skeleton recognizes a minimal normalized shape for wiring/tests.
    if (typeof raw === 'object' && raw !== null && 'type' in raw) {
      const t = (raw as { type: unknown }).type;
      if (t === 'message' && 'text' in raw) {
        return { type: 'message', text: String((raw as { text: unknown }).text) };
      }
    }
    return null;
  },
};
