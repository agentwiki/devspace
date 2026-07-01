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
  | { kind: 'agent'; op: 'create-pr' }
  | { kind: 'approval'; requestId: string; decision: 'allow' | 'deny' }
  | { kind: 'unknown'; actionId: string };

/** Classify a chat button click. "create-pr" is an agent task; "view-pr" is not. */
export function classifyAction(actionId: string): ActionClass {
  if (actionId === 'view-pr') return { kind: 'deterministic', op: 'view-pr' };
  if (actionId === 'create-pr') return { kind: 'agent', op: 'create-pr' };
  const m = /^(approve|deny):(.+)$/.exec(actionId);
  if (m) return { kind: 'approval', requestId: m[2]!, decision: m[1] === 'approve' ? 'allow' : 'deny' };
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
