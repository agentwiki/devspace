/**
 * The permission gate's M5 guardrail auto-deny: policy-denied operations are
 * rejected immediately (no parked request, no approval buttons), while
 * allowed-but-gated operations park exactly as before.
 */
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type { AgentEvent } from '@devspace/contracts';
import { describe, expect, it } from 'vitest';
import { codexBackend } from '../backends/codex.js';
import { DevspaceAcpClient } from './client.js';

const OPTIONS: PermissionOption[] = [
  { optionId: 'y', name: 'Yes', kind: 'allow_once' },
  { optionId: 'n', name: 'No', kind: 'reject_once' },
];

function permissionRequest(
  toolCall: Partial<RequestPermissionRequest['toolCall']> & { toolCallId: string },
): RequestPermissionRequest {
  return { sessionId: 's1', toolCall, options: OPTIONS } as RequestPermissionRequest;
}

function clientWithSink(): { client: DevspaceAcpClient; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const client = new DevspaceAcpClient(codexBackend);
  client.setSink((e) => events.push(e));
  return { client, events };
}

describe('guardrail auto-deny at the permission gate', () => {
  it('rejects a denied command immediately without parking', async () => {
    const { client, events } = clientWithSink();
    const res = await client.requestPermission(
      permissionRequest({
        toolCallId: 'tc1',
        kind: 'execute',
        title: 'rm -rf /',
        rawInput: { command: 'rm -rf /' },
      }),
    );
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'n' } });
    expect(client.hasPendingPermission).toBe(false);
    // A message explains the denial; NO permission_request (no buttons).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'message', text: expect.stringContaining('denied') });
  });

  it('rejects a protected-path write immediately', async () => {
    const { client, events } = clientWithSink();
    const res = await client.requestPermission(
      permissionRequest({
        toolCallId: 'tc2',
        kind: 'edit',
        title: 'edit /etc/passwd',
        locations: [{ path: '/etc/passwd' }],
      }),
    );
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'n' } });
    expect(events[0]?.type).toBe('message');
    expect(client.hasPendingPermission).toBe(false);
  });

  it('parks an allowed command for a human decision as before', async () => {
    const { client, events } = clientWithSink();
    const parked = client.requestPermission(
      permissionRequest({
        toolCallId: 'tc3',
        kind: 'execute',
        title: 'npm test',
        rawInput: { command: 'npm test' },
      }),
    );
    expect(client.hasPendingPermission).toBe(true);
    expect(events[0]).toMatchObject({ type: 'permission_request', op: 'command_run' });

    const requestId = (events[0] as Extract<AgentEvent, { type: 'permission_request' }>).requestId;
    expect(client.decide({ requestId, decision: 'allow', scope: 'once' })).toBe(true);
    await expect(parked).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'y' } });
  });

  it('parks a workspace write (allowed path) rather than auto-denying', async () => {
    const { client, events } = clientWithSink();
    void client.requestPermission(
      permissionRequest({
        toolCallId: 'tc4',
        kind: 'edit',
        title: 'edit src/index.ts',
        locations: [{ path: '/workspace/src/index.ts' }],
      }),
    );
    expect(client.hasPendingPermission).toBe(true);
    expect(events[0]?.type).toBe('permission_request');
    client.cancelAllPending();
  });

  it('parks when the operation cannot be evaluated (no command, no path)', async () => {
    const { client, events } = clientWithSink();
    void client.requestPermission(permissionRequest({ toolCallId: 'tc5', kind: 'other' }));
    expect(client.hasPendingPermission).toBe(true);
    expect(events[0]?.type).toBe('permission_request');
    client.cancelAllPending();
  });
});
