/**
 * Work-unit FSM driver + chat-action classification.
 *
 * This module is what breaks the Chat<->Agent dependency cycle: chat actions
 * arrive as opaque `action.invoked` events and the orchestrator alone decides
 * whether each is an AGENT task or a DETERMINISTIC task. Providers never call
 * each other across the cycle.
 */
import type { WorkEvent, WorkUnit } from '@devspace/contracts';
import { nextWorkState } from '@devspace/contracts';
import type { WorkUnitRepo } from '@devspace/db';
import { IllegalTransitionError } from '@devspace/db';

export type ActionClass =
  | { kind: 'deterministic'; op: 'view-pr' }
  // "hybrid": the agent finalizes commits, then the DETERMINISTIC host-side
  // GitWrapper pushes + opens the PR. The tag no longer implies a pure
  // AgentRunner dispatch (it isn't one).
  | { kind: 'hybrid'; op: 'create-pr' }
  | { kind: 'approval'; requestId: string; decision: 'allow' | 'deny' }
  // M6: expose a container port through the preview proxy. Adapters normalize
  // their own ergonomics (`!port 3000`) onto this id (m6-plan Decision 6).
  | { kind: 'expose-port'; port: number }
  // M19: re-open work on a PR_OPEN unit — re-provision the env from the PR
  // branch when it was released, then PR_OPEN --resume--> WORKING.
  | { kind: 'resume' }
  | { kind: 'unknown'; actionId: string };

/** Classify a chat button click. "create-pr" is a hybrid task; "view-pr" is not. */
export function classifyAction(actionId: string): ActionClass {
  if (actionId === 'view-pr') return { kind: 'deterministic', op: 'view-pr' };
  if (actionId === 'create-pr') return { kind: 'hybrid', op: 'create-pr' };
  if (actionId === 'resume-work') return { kind: 'resume' };
  const m = /^(approve|deny):(.+)$/.exec(actionId);
  if (m)
    return { kind: 'approval', requestId: m[2]!, decision: m[1] === 'approve' ? 'allow' : 'deny' };
  const p = /^expose-port:(\d{1,5})$/.exec(actionId);
  if (p) {
    const port = Number(p[1]);
    if (port > 0 && port <= 65535) return { kind: 'expose-port', port };
  }
  return { kind: 'unknown', actionId };
}

/** Thin wrapper that enforces legal transitions and is the single state writer. */
export class WorkUnitMachine {
  constructor(private readonly repo: WorkUnitRepo) {}

  canTransition(state: WorkUnit['state'], event: WorkEvent): boolean {
    return nextWorkState(state, event) !== null;
  }

  async apply(workUnitId: string, event: WorkEvent, patch?: Partial<WorkUnit>): Promise<WorkUnit> {
    try {
      return await this.repo.transition(workUnitId, event, patch);
    } catch (err) {
      if (err instanceof IllegalTransitionError) throw err;
      throw err;
    }
  }
}
