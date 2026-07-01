import { describe, expect, it } from 'vitest';
import type { AgentEvent, RenderCommand } from '@devspace/contracts';
import { renderAgentEvent, messageCommand, statusCommand } from './render.js';
import { SecretRegistry } from './secrets.js';

const CID = 'conv_1';

describe('renderAgentEvent', () => {
  const reg = new SecretRegistry();

  it('drops thoughts and renders messages', () => {
    expect(renderAgentEvent(CID, { type: 'thought', text: 'hmm' }, reg)).toEqual([]);
    expect(renderAgentEvent(CID, { type: 'message', text: 'hi' }, reg)).toEqual([
      { type: 'post_message', conversationId: CID, text: 'hi' },
    ]);
  });

  it('maps a permission_request to approve/deny actions', () => {
    const out = renderAgentEvent(
      CID,
      { type: 'permission_request', requestId: 'r9', op: 'git_push', details: 'push to main' },
      reg,
    );
    expect(out[0]).toMatchObject({
      type: 'post_actions',
      actions: [
        { actionId: 'approve:r9', label: 'Approve' },
        { actionId: 'deny:r9', label: 'Deny' },
      ],
    });
  });

  it('maps turn_end to a status', () => {
    expect(renderAgentEvent(CID, { type: 'turn_end', reason: 'completed' }, reg)).toEqual([
      { type: 'update_status', conversationId: CID, state: 'completed', text: 'Turn complete.' },
    ]);
  });

  it('redacts registered secrets in every text-bearing variant', () => {
    const r = new SecretRegistry();
    r.register('supersecrettoken');
    const variants: AgentEvent[] = [
      { type: 'message', text: 'key=supersecrettoken' },
      { type: 'tool_call', name: 'supersecrettoken', args: {} },
      { type: 'tool_result', name: 'run', ok: true, summary: 'got supersecrettoken' },
      { type: 'command_run', cmd: 'echo supersecrettoken' },
      { type: 'permission_request', requestId: 'r', op: 'network', details: 'supersecrettoken' },
    ];
    for (const v of variants) {
      const cmds: RenderCommand[] = renderAgentEvent(CID, v, r);
      const text = JSON.stringify(cmds);
      expect(text).not.toContain('supersecrettoken');
      expect(text).toContain('«redacted»');
    }
  });
});

describe('helper commands', () => {
  it('redacts message and status text', () => {
    const r = new SecretRegistry();
    r.register('leakvalue');
    expect(messageCommand(CID, 'x leakvalue', r).text).toBe('x «redacted»');
    expect(statusCommand(CID, 'READY', 'leakvalue ok', r)).toEqual({
      type: 'update_status',
      conversationId: CID,
      state: 'READY',
      text: '«redacted» ok',
    });
  });
});
