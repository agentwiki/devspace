/**
 * End-to-end ACP round-trip, no Docker.
 *
 * A REAL `AgentSideConnection` (the SDK's agent half) plays codex-acp on one end
 * of an in-memory loopback; our `connectAgent` client drives it from the other.
 * This exercises the whole M2 vertical for real: the stream adapter, ndJsonStream
 * framing, the initialize/newSession handshake, session/update -> AgentEvent
 * mapping, the prompt turn lifecycle, and the permission gate — the same code
 * paths a live codex-acp process would hit, minus the container.
 */
import {
  AgentSideConnection,
  type Agent,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import type { AgentEvent } from '@devspace/contracts';
import { describe, expect, it } from 'vitest';
import { codexBackend } from '../backends/codex.js';
import { connectAgent } from './connection.js';
import { createAcpLoopback } from './loopback.js';

/** A scripted fake codex-acp agent built on the real SDK agent side. */
function startFakeAgent(
  agentStream: ConstructorParameters<typeof AgentSideConnection>[1],
  script: (conn: AgentSideConnection, params: PromptRequest) => Promise<PromptResponse>,
): AgentSideConnection {
  return new AgentSideConnection(
    (conn): Agent => ({
      async initialize(_p: InitializeRequest) {
        return { protocolVersion: 1, agentCapabilities: {} };
      },
      async newSession(_p: NewSessionRequest) {
        return { sessionId: 'sess-loopback-1' };
      },
      async authenticate(_p: AuthenticateRequest) {
        return {};
      },
      async prompt(p: PromptRequest) {
        return script(conn, p);
      },
      async cancel(_p: CancelNotification) {
        /* no-op */
      },
    }),
    agentStream,
  );
}

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('ACP round-trip', () => {
  it('runs a full turn and normalizes updates into AgentEvents', async () => {
    const { execStream, agentStream } = createAcpLoopback();
    startFakeAgent(agentStream, async (conn, params) => {
      const sessionId = params.sessionId;
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'planning' },
        },
      });
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc1',
          title: 'write file',
          kind: 'edit',
          content: [{ type: 'diff', path: 'README.md', newText: '# hi\n' }],
        },
      });
      await conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      });
      return { stopReason: 'end_turn' };
    });

    const session = await connectAgent(execStream, codexBackend, { workspacePath: '/workspace' });
    // The prompt content reaches the agent; assert the fake got it too.
    const events = await drain(session.runTurn('make a readme'));

    expect(events).toEqual([
      { type: 'thought', text: 'planning' },
      { type: 'file_edit', path: 'README.md', diff: expect.stringContaining('# hi') },
      { type: 'message', text: 'done' },
      { type: 'turn_end', reason: 'completed' },
    ]);
    await session.close();
  });

  it('parks a permission request until a decision, then lets the turn finish', async () => {
    const { execStream, agentStream } = createAcpLoopback();
    startFakeAgent(agentStream, async (conn, params) => {
      const sessionId = params.sessionId;
      const outcome = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'tc2', title: 'git push origin main', kind: 'execute' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Deny', kind: 'reject_once' },
        ],
      });
      // Agent reports what the client decided so the test can assert on it.
      const decided =
        outcome.outcome.outcome === 'selected' ? outcome.outcome.optionId : 'cancelled';
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `decided:${decided}` },
        },
      });
      return { stopReason: 'end_turn' };
    });

    const session = await connectAgent(execStream, codexBackend, { workspacePath: '/workspace' });

    const events: AgentEvent[] = [];
    const iterator = session.runTurn('push my work')[Symbol.asyncIterator]();

    // First event out is the permission request; capture its id and approve it.
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: 'permission_request', op: 'command_run' });
    const requestId = (first.value as { requestId: string }).requestId;
    expect(session.decide({ requestId, decision: 'allow', scope: 'once' })).toBe(true);

    for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
      events.push(step.value);
    }
    expect(events).toEqual([
      { type: 'message', text: 'decided:yes' },
      { type: 'turn_end', reason: 'completed' },
    ]);
    await session.close();
  });
});
