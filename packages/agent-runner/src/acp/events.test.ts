import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { mapSessionUpdate, opForToolKind, stopReasonToTurnEnd } from './events.js';

describe('mapSessionUpdate', () => {
  it('maps agent message and thought chunks to text events', () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      } as SessionUpdate),
    ).toEqual({ type: 'message', text: 'hello' });

    expect(
      mapSessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      } as SessionUpdate),
    ).toEqual({ type: 'thought', text: 'thinking' });
  });

  it('drops empty and non-text chunks', () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
      } as SessionUpdate),
    ).toBeNull();
    expect(
      mapSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'x', mimeType: 'image/png' },
      } as SessionUpdate),
    ).toBeNull();
  });

  it('maps an execute tool call to command_run using rawInput', () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'run tests',
        kind: 'execute',
        rawInput: { command: 'pnpm test' },
      } as SessionUpdate),
    ).toEqual({ type: 'command_run', cmd: 'pnpm test' });
  });

  it('maps a diff in a tool call to file_edit regardless of kind', () => {
    const ev = mapSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'edit file',
      kind: 'edit',
      content: [{ type: 'diff', path: 'src/a.ts', newText: 'export const a = 1;\n' }],
    } as SessionUpdate);
    expect(ev?.type).toBe('file_edit');
    expect(ev).toMatchObject({ path: 'src/a.ts' });
    expect((ev as { diff: string }).diff).toContain('export const a = 1;');
    expect((ev as { diff: string }).diff).toContain('/dev/null'); // new file (no oldText)
  });

  it('maps a non-execute, non-diff tool call to a generic tool_call', () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't3',
        title: 'search',
        kind: 'search',
        rawInput: { query: 'foo' },
      } as SessionUpdate),
    ).toEqual({ type: 'tool_call', name: 'search', args: { query: 'foo' } });
  });

  it('maps terminal tool_call_update statuses to tool_result', () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'run tests',
        status: 'completed',
      } as SessionUpdate),
    ).toEqual({ type: 'tool_result', name: 'run tests', ok: true, summary: 'run tests' });

    expect(
      mapSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'failed',
      } as SessionUpdate),
    ).toEqual({ type: 'tool_result', name: 't1', ok: false, summary: 't1' });
  });

  it('drops in-progress updates and unmodeled update kinds', () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'in_progress',
      } as SessionUpdate),
    ).toBeNull();
    expect(
      mapSessionUpdate({ sessionUpdate: 'plan', entries: [] } as unknown as SessionUpdate),
    ).toBeNull();
    expect(
      mapSessionUpdate({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'echo' },
      } as SessionUpdate),
    ).toBeNull();
  });
});

describe('opForToolKind', () => {
  it('maps tool kinds onto guarded ops', () => {
    expect(opForToolKind('edit')).toBe('file_write');
    expect(opForToolKind('delete')).toBe('file_write');
    expect(opForToolKind('move')).toBe('file_write');
    expect(opForToolKind('fetch')).toBe('network');
    expect(opForToolKind('execute')).toBe('command_run');
    expect(opForToolKind(undefined)).toBe('command_run');
  });
});

describe('stopReasonToTurnEnd', () => {
  it('maps cancelled to aborted and everything else to completed', () => {
    expect(stopReasonToTurnEnd('cancelled')).toBe('aborted');
    expect(stopReasonToTurnEnd('end_turn')).toBe('completed');
    expect(stopReasonToTurnEnd('max_tokens')).toBe('completed');
    expect(stopReasonToTurnEnd('refusal')).toBe('completed');
  });
});
