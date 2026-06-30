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
export * from './backends/codex.js';
export * from './acp/connection.js';

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
  closeSession(agentSessionId: string): Promise<void>;
}
