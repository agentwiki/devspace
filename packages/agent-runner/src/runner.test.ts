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

/** A non-ACP exec (the in-container kill): resolves `done` immediately. */
function immediateExecStream(): ExecStream {
  return {
    writeStdin: () => true,
    drain: () => Promise.resolve(),
    closeStdin: () => {},
    frames: (async function* () {})(),
    done: Promise.resolve(0),
    kill: () => {},
  };
}

/** ExecProvider that echoes the prompt back via a real SDK agent on each launch. */
function fakeExecProvider(opts: { toolCallsPerPrompt?: number } = {}) {
  const launches: Launched[] = [];
  const exec = async (envId: string, req: ExecRequest): Promise<ExecStream> => {
    launches.push({ envId, req });
    // The M5 abort path execs the backend's kill command — not an ACP launch.
    if (req.cmd[0] === 'sh') return immediateExecStream();
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
          for (let i = 0; i < (opts.toolCallsPerPrompt ?? 0); i++) {
            await conn.sessionUpdate({
              sessionId: p.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `tc-${i}`,
                title: `run ${i}`,
                kind: 'execute',
                status: 'pending',
                rawInput: { command: `cmd-${i}` },
              },
            });
          }
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

  it('abortTurn cancels the protocol AND kills the agent inside the container', async () => {
    const provider = fakeExecProvider();
    const runner = new DefaultAgentRunner({ exec: provider });
    const { agentSessionId } = await runner.createSession({
      envId: 'env-abort',
      agentKind: 'codex',
      workspacePath: '/workspace',
      llmKeyRef: 'r',
    });

    await runner.abortTurn(agentSessionId);

    // The kill runs via the ordinary exec provider INTO the env — never
    // ExecStream.kill() (docker-exec does not propagate signals inward).
    const kill = provider.launches.find((l) => l.req.cmd[0] === 'sh');
    expect(kill?.envId).toBe('env-abort');
    expect(kill?.req.cmd[2]).toContain('pkill');
    // The `[/]` prefix keeps pkill from matching its own parent shell.
    expect(kill?.req.cmd[2]).toContain('[/]opt/agent-runtime/codex-acp');
  });

  it('aborts a turn that blows the tool-call budget and kills the agent', async () => {
    const provider = fakeExecProvider({ toolCallsPerPrompt: 3 });
    const runner = new DefaultAgentRunner({
      exec: provider,
      policy: {
        ...(await import('./guardrails.js')).DEFAULT_POLICY,
        maxToolCallsPerTurn: 1,
      },
    });
    const { agentSessionId } = await runner.createSession({
      envId: 'env-budget',
      agentKind: 'codex',
      workspacePath: '/workspace',
      llmKeyRef: 'r',
    });

    const events = await drain(runner.runTurn(agentSessionId, { prompt: 'go', attachments: [] }));

    expect(events[0]).toMatchObject({ type: 'command_run', cmd: 'cmd-0' });
    expect(events.at(-2)).toMatchObject({
      type: 'message',
      text: expect.stringContaining('aborted'),
    });
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'aborted' });
    const kill = provider.launches.find((l) => l.req.cmd[0] === 'sh');
    expect(kill?.envId).toBe('env-budget');
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
