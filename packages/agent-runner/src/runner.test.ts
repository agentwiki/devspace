/**
 * AgentRunner wiring test.
 *
 * A fake ExecProvider stands in for sandbox-core: when the runner launches the
 * agent, it records the ExecRequest (so we assert model/key injection) and wires
 * a real SDK `AgentSideConnection` to the returned loopback stream. From there the
 * runner drives a genuine ACP turn — no Docker, no child process.
 */
import { AgentSideConnection, type Agent } from '@agentclientprotocol/sdk';
import type { AgentEvent, ExecRequest } from '@devspace/contracts';
import type { ExecStream } from '@devspace/sandbox-core';
import { describe, expect, it } from 'vitest';
import { createAcpLoopback } from './acp/loopback.js';
import { DefaultAgentRunner, agentRuntimeMount } from './runner.js';

interface Launched {
  envId: string;
  req: ExecRequest;
}

function textOf(p: { prompt: Array<{ type: string }> }): string {
  const block = p.prompt.find((b) => b.type === 'text') as { text?: string } | undefined;
  return block?.text ?? '';
}

/** ExecProvider that echoes the prompt back via a real SDK agent on each launch. */
function fakeExecProvider() {
  const launches: Launched[] = [];
  const exec = async (envId: string, req: ExecRequest): Promise<ExecStream> => {
    launches.push({ envId, req });
    const { execStream, agentStream } = createAcpLoopback();
    new AgentSideConnection(
      (conn): Agent => ({
        async initialize() {
          return { protocolVersion: 1, agentCapabilities: {} };
        },
        async newSession() {
          return { sessionId: 'sess-runner' };
        },
        async authenticate() {
          return {};
        },
        async prompt(p) {
          await conn.sessionUpdate({
            sessionId: p.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `echo:${textOf(p)}` },
            },
          });
          return { stopReason: 'end_turn' };
        },
        async cancel() {
          /* no-op */
        },
      }),
      agentStream,
    );
    return execStream;
  };
  return { exec, launches };
}

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('agentRuntimeMount', () => {
  it('produces a read-only mount at the fixed runtime path', () => {
    expect(agentRuntimeMount()).toEqual({
      source: 'devspace-agent-runtime',
      target: '/opt/agent-runtime',
      ro: true,
    });
    expect(agentRuntimeMount('custom-vol').source).toBe('custom-vol');
  });
});

describe('DefaultAgentRunner', () => {
  it('launches the agent with model + resolved key and runs a turn', async () => {
    const provider = fakeExecProvider();
    const runner = new DefaultAgentRunner({
      exec: provider,
      resolveSecret: async (ref) => (ref === 'ref-1' ? 'sk-test' : undefined),
    });

    const { agentSessionId } = await runner.createSession({
      envId: 'env-1',
      agentKind: 'codex',
      workspacePath: '/workspace',
      model: 'gpt-x',
      llmKeyRef: 'ref-1',
    });
    expect(agentSessionId).toMatch(/^agent_/);

    const launch = provider.launches[0];
    expect(launch?.envId).toBe('env-1');
    expect(launch?.req.cmd).toEqual([
      '/opt/agent-runtime/bin/node',
      '/opt/agent-runtime/codex-acp',
    ]);
    expect(launch?.req.env).toMatchObject({ CODEX_MODEL: 'gpt-x', OPENAI_API_KEY: 'sk-test' });

    const events = await drain(
      runner.runTurn(agentSessionId, { prompt: 'hi there', attachments: [] }),
    );
    expect(events).toEqual([
      { type: 'message', text: 'echo:hi there' },
      { type: 'turn_end', reason: 'completed' },
    ]);

    await runner.closeSession(agentSessionId);
    await expect(
      runner.decidePermission(agentSessionId, { requestId: 'x', decision: 'allow', scope: 'once' }),
    ).rejects.toThrow(/unknown agent session/);
  });

  it('creates a session without a secret resolver (key assumed pre-injected)', async () => {
    const provider = fakeExecProvider();
    const runner = new DefaultAgentRunner({ exec: provider });
    const { agentSessionId } = await runner.createSession({
      envId: 'e',
      agentKind: 'codex',
      workspacePath: '/workspace',
      llmKeyRef: 'r',
    });
    expect(agentSessionId).toBeDefined();
    expect(provider.launches[0]?.req.env).toEqual({});
    await runner.closeSession(agentSessionId);
  });
});
