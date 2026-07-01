/**
 * ACP client wiring.
 *
 * The agent-runner is the ACP CLIENT. It launches the agent process inside the
 * sandbox via sandbox-core's exec stream, wraps that {stdin, stdout} byte channel
 * in ACP's `ndJsonStream`, and drives it through a `ClientSideConnection`:
 *
 *   exec stream ──stream-adapter──▶ ndJsonStream ──▶ ClientSideConnection
 *                                                        │
 *                    DevspaceAcpClient ◀── session/update, requestPermission
 *
 * `connectAgent` performs the ACP handshake (`initialize` + `newSession`) and
 * returns an `AcpSession` whose `runTurn` streams normalized AgentEvents for one
 * prompt. Turn orchestration lives here: fire `session/prompt`, forward each
 * mapped update to the turn's async queue, and terminate the stream with a
 * `turn_end` event carrying the mapped stop reason.
 */
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';
import type { AgentEvent, PermissionDecision } from '@devspace/contracts';
import type { ExecStream } from '@devspace/sandbox-core';
import type { AgentBackend } from '../backends/codex.js';
import { AsyncQueue } from './async-queue.js';
import { DevspaceAcpClient } from './client.js';
import { stopReasonToTurnEnd } from './events.js';
import { execStreamToAcp } from './stream-adapter.js';

export interface ConnectOptions {
  /** Absolute workspace path inside the sandbox; the ACP session cwd. */
  workspacePath: string;
  /** Sink for agent stderr / diagnostics. */
  onLog?: (line: string) => void;
}

export interface AcpSession {
  /** The ACP session id negotiated with the agent. */
  readonly sessionId: string;
  /** Run one prompt turn, streaming normalized events until `turn_end`. */
  runTurn(prompt: string): AsyncIterable<AgentEvent>;
  /** Resolve a parked permission request; false if the id is unknown. */
  decide(decision: PermissionDecision): boolean;
  /** Cancel any in-flight turn and tear down the session. */
  close(): Promise<void>;
}

/**
 * Handshake with the agent over `stream` and return a live session. The agent
 * process must already be running (launched via `exec` with the backend's
 * `launchCommand`) and speaking ACP on stdout.
 */
export async function connectAgent(
  stream: ExecStream,
  backend: AgentBackend,
  opts: ConnectOptions,
): Promise<AcpSession> {
  const onLog = opts.onLog ?? (() => {});
  const client = new DevspaceAcpClient(backend, onLog);
  const bytes = execStreamToAcp(stream, onLog);
  const conn = new ClientSideConnection(() => client, ndJsonStream(bytes.writable, bytes.readable));

  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    // The agent edits its own in-sandbox workspace and runs its own commands, so
    // we expose no client-side fs/terminal capabilities.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });

  const { sessionId } = await conn.newSession({ cwd: opts.workspacePath, mcpServers: [] });

  async function* runTurn(prompt: string): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    client.setSink((event) => queue.push(event));

    const turn = conn
      .prompt({ sessionId, prompt: [{ type: 'text', text: prompt }] })
      .then((res) => {
        queue.push({ type: 'turn_end', reason: stopReasonToTurnEnd(res.stopReason) });
        queue.close();
      })
      .catch((err: unknown) => {
        onLog(`prompt failed: ${err instanceof Error ? err.message : String(err)}`);
        queue.push({ type: 'turn_end', reason: 'error' });
        queue.close();
      });

    try {
      for await (const event of queue) yield event;
    } finally {
      client.setSink(null);
      await turn;
    }
  }

  return {
    sessionId,
    runTurn,
    decide: (decision) => client.decide(decision),
    async close() {
      client.cancelAllPending();
      await conn.cancel({ sessionId }).catch(() => {});
      stream.closeStdin();
    },
  };
}
