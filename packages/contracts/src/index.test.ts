import { describe, expect, it } from 'vitest';
import {
  AgentEventSchema,
  ApplySecretsRequestSchema,
  ChatEventSchema,
  CreateEnvironmentRequestSchema,
  ExecFrameSchema,
  nextWorkState,
  RenderCommandSchema,
  WORK_TRANSITIONS,
  WorkStateSchema,
} from './index.js';

describe('contract round-trips', () => {
  it('parses a create-environment request and applies defaults', () => {
    const parsed = CreateEnvironmentRequestSchema.parse({
      repoUrl: 'https://github.com/acme/widgets',
    });
    expect(parsed.resources.cpu).toBe(2);
    expect(parsed.mounts).toEqual([]);
    expect(parsed.secrets).toEqual([]);
  });

  it('accepts apply-secrets requests but never an empty one', () => {
    expect(() =>
      ApplySecretsRequestSchema.parse({
        secrets: [{ name: 'GH_TOKEN', value: 'v', target: 'env' }],
      }),
    ).not.toThrow();
    expect(() => ApplySecretsRequestSchema.parse({ secrets: [] })).toThrow();
  });

  it('round-trips an exec frame through JSON', () => {
    const frame = { kind: 'stdout', data: 'aGVsbG8=' } as const;
    const restored = ExecFrameSchema.parse(JSON.parse(JSON.stringify(frame)));
    expect(restored).toEqual(frame);
  });

  it('validates the normalized agent event union', () => {
    expect(() =>
      AgentEventSchema.parse({ type: 'file_edit', path: 'src/a.ts', diff: '@@' }),
    ).not.toThrow();
    expect(() => AgentEventSchema.parse({ type: 'nope' })).toThrow();
  });

  it('validates inbound chat events and outbound render commands', () => {
    expect(() =>
      ChatEventSchema.parse({
        type: 'action.invoked',
        conversationId: 'c1',
        userId: 'u1',
        actionId: 'create-pr',
      }),
    ).not.toThrow();
    expect(() =>
      RenderCommandSchema.parse({
        type: 'update_status',
        conversationId: 'c1',
        state: 'READY',
        text: 'ready',
      }),
    ).not.toThrow();
  });
});

describe('work-unit FSM', () => {
  it('follows the happy path to PR_OPEN', () => {
    expect(nextWorkState('CREATED', 'repoChoice')).toBe('PROVISIONING');
    expect(nextWorkState('PROVISIONING', 'envReady')).toBe('READY');
    expect(nextWorkState('READY', 'firstMessage')).toBe('WORKING');
    expect(nextWorkState('WORKING', 'committedAndPushed')).toBe('PRE_PR');
    expect(nextWorkState('PRE_PR', 'prCreated')).toBe('PR_OPEN');
  });

  it('rejects illegal transitions', () => {
    expect(nextWorkState('CREATED', 'prCreated')).toBeNull();
    expect(nextWorkState('TORN_DOWN', 'repoChoice')).toBeNull();
  });

  it('resume and suspend cycle work through review (M19)', () => {
    // Resume re-opens work on an open PR; the WORKING self-loop persists the
    // resumed session's lazily created agent session id.
    expect(nextWorkState('PR_OPEN', 'resume')).toBe('WORKING');
    expect(nextWorkState('WORKING', 'resume')).toBe('WORKING');
    // Suspend is the reaper's way back — never from a terminal state.
    expect(nextWorkState('WORKING', 'suspend')).toBe('PR_OPEN');
    expect(nextWorkState('PRE_PR', 'suspend')).toBe('PR_OPEN');
    expect(nextWorkState('READY', 'resume')).toBeNull();
    expect(nextWorkState('PR_MERGED', 'resume')).toBeNull();
    expect(nextWorkState('PR_OPEN', 'suspend')).toBeNull();
    expect(nextWorkState('TORN_DOWN', 'resume')).toBeNull();
  });

  it('every state has a transition entry', () => {
    for (const state of WorkStateSchema.options) {
      expect(WORK_TRANSITIONS[state]).toBeDefined();
    }
  });
});
