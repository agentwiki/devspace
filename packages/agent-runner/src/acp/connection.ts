/**
 * ACP client wiring.
 *
 * The agent-runner is the ACP CLIENT. It launches the agent process inside the
 * sandbox via sandbox-core's exec stream, then wraps that {stdin, stdout} byte
 * channel in ACP's ndJsonStream and constructs a ClientSideConnection.
 *
 * M0 skeleton: defines the seam. M2 plugs in `@agentclientprotocol/sdk`:
 *   import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
 *   const conn = new ClientSideConnection(client, ndJsonStream(writable, readable));
 * where `writable`/`readable` are adapted from ExecStream (stdout frames ->
 * readable bytes; writeStdin <- writable). stderr frames are surfaced as logs.
 */
import type { AgentEvent } from '@devspace/contracts';
import type { ExecStream } from '@devspace/sandbox-core';
import { fromBase64 } from '@devspace/sandbox-core';
import type { AgentBackend } from '../backends/codex.js';

export interface AcpSession {
  /** Normalized agent events for the current/next turn. */
  events: AsyncIterable<AgentEvent>;
  /** Send a user prompt to start a turn. */
  prompt(text: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Build the readable byte stream (agent stdout) the ACP ndJsonStream consumes.
 * Stderr is routed to `onLog` instead of the protocol channel.
 */
export async function* readProtocolBytes(
  stream: ExecStream,
  onLog: (line: string) => void = () => {},
): AsyncIterable<Uint8Array> {
  for await (const frame of stream.frames) {
    if (frame.kind === 'stdout') yield fromBase64(frame.data);
    else if (frame.kind === 'stderr') onLog(Buffer.from(fromBase64(frame.data)).toString());
  }
}

/**
 * M0 placeholder connection factory. Returns an AcpSession shape so the
 * runner/orchestrator can be wired and tested before the SDK is plugged in.
 */
export function connectAgent(_stream: ExecStream, _backend: AgentBackend): AcpSession {
  async function* noEvents(): AsyncIterable<AgentEvent> {
    /* no events until M2 wires the SDK */
  }
  return {
    events: noEvents(),
    async prompt() {
      throw new Error('AcpSession.prompt not implemented yet (lands in M2)');
    },
    async close() {
      /* no-op */
    },
  };
}
