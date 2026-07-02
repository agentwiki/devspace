/**
 * @devspace/agent-runner
 *
 * Owns agent execution + the harness. Receives "run a turn" jobs, launches the
 * agent inside the target env (via sandbox-core exec), speaks ACP, applies
 * deterministic guardrails to every requested operation, and emits a normalized
 * AgentEvent stream. It depends DOWN on sandbox-core only; it never imports the
 * chat gateway — chat capabilities reach the agent as orchestrator-mediated tools.
 */
export * from './guardrails.js';
export * from './budget.js';
export * from './backends/codex.js';
export * from './acp/connection.js';
export * from './acp/events.js';
export * from './acp/client.js';
export * from './acp/stream-adapter.js';
export * from './acp/async-queue.js';
export * from './acp/loopback.js';
export * from './runner.js';

import type {
  AgentEvent,
  CreateAgentSessionRequest,
  PermissionDecision,
  TurnRequest,
} from '@devspace/contracts';

export interface AgentRunner {
  createSession(req: CreateAgentSessionRequest): Promise<{ agentSessionId: string }>;
  runTurn(agentSessionId: string, req: TurnRequest): AsyncIterable<AgentEvent>;
  decidePermission(agentSessionId: string, decision: PermissionDecision): Promise<void>;
  /**
   * Hard-stop an in-flight turn (M5): protocol cancel + in-container kill.
   * Optional — the default runner self-aborts on budget breaches, so callers
   * only need this for an explicit user-driven stop.
   */
  abortTurn?(agentSessionId: string): Promise<void>;
  closeSession(agentSessionId: string): Promise<void>;
}
