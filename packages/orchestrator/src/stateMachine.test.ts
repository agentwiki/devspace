import { describe, expect, it } from 'vitest';
import { createInMemoryRepositories } from '@devspace/db';
import { classifyAction, WorkUnitMachine } from './stateMachine.js';

describe('classifyAction', () => {
  it('separates deterministic, agent, and approval actions', () => {
    expect(classifyAction('view-pr')).toEqual({ kind: 'deterministic', op: 'view-pr' });
    expect(classifyAction('create-pr')).toEqual({ kind: 'agent', op: 'create-pr' });
    expect(classifyAction('approve:req-42')).toEqual({
      kind: 'approval',
      requestId: 'req-42',
      decision: 'allow',
    });
    expect(classifyAction('deny:req-42').kind).toBe('approval');
    expect(classifyAction('mystery')).toEqual({ kind: 'unknown', actionId: 'mystery' });
  });
});

describe('WorkUnitMachine', () => {
  it('applies legal transitions via the repo', async () => {
    const repos = createInMemoryRepositories();
    const conv = await repos.conversations.create({
      platform: 'discord',
      externalChannelId: 'c',
      userId: 'u',
    });
    const wu = await repos.workUnits.create({ conversationId: conv.id });
    const machine = new WorkUnitMachine(repos.workUnits);

    expect(machine.canTransition('CREATED', 'repoChoice')).toBe(true);
    expect(machine.canTransition('CREATED', 'prCreated')).toBe(false);

    const next = await machine.apply(wu.id, 'repoChoice');
    expect(next.state).toBe('PROVISIONING');
  });
});
