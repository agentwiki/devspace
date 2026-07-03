/**
 * The remote exec wire (M8, m8-plan Decisions 1-4): shared pieces of the
 * `devspace-exec` HTTP Upgrade protocol used by both the server
 * (`remote-server.ts`) and the client (`remote-client.ts`).
 *
 * The wire itself is deliberately dumb: after the 101, each direction carries
 * newline-delimited JSON frames — the client sends one `ExecRequest` line and
 * then `ExecClientFrame`s; the server answers with `ExecFrame`s (`exit` always
 * last, then FIN). Flow control is TCP's window, re-armed at both rims by the
 * M1 watermark discipline; nothing here parses more than lines.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

/** Value of the `Upgrade:` header for the exec wire. */
export const EXEC_UPGRADE_PROTOCOL = 'devspace-exec';

/** Path of the exec upgrade endpoint for an env. */
export function execUpgradePath(envId: string): string {
  return `/environments/${encodeURIComponent(envId)}/exec`;
}

/**
 * Verify an `Authorization: Bearer <token>` header against the shared internal
 * token, constant-time over the token bytes (the M6 internal-API discipline —
 * reimplemented here because sandbox-core sits BELOW the orchestrator in the
 * package DAG and cannot import its helper).
 */
export function verifyBearer(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return false;
  const presented = Buffer.from(m[1]!, 'utf8');
  const expected = Buffer.from(token, 'utf8');
  const len = Math.max(presented.length, expected.length);
  const a = Buffer.alloc(len);
  const b = Buffer.alloc(len);
  presented.copy(a);
  expected.copy(b);
  return timingSafeEqual(a, b) && presented.length === expected.length;
}

/**
 * Incremental newline splitter. Push raw chunks, get back complete lines
 * (without the terminator); a trailing partial line waits for its newline.
 * Buffers go through a StringDecoder so a multi-byte UTF-8 character split
 * across TCP segments is carried over intact, never mangled to U+FFFD
 * (JSON.stringify emits raw UTF-8 — frames are not ASCII-safe).
 */
export class LineDecoder {
  private readonly utf8 = new StringDecoder('utf8');
  private tail = '';

  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    const parts = (this.tail + text).split('\n');
    this.tail = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }
}

/** JSON.parse that answers `undefined` for protocol noise instead of throwing. */
export function safeJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Serialize one frame onto the socket. Returns `socket.write`'s watermark verdict. */
export function writeJsonLine(socket: Socket, value: unknown): boolean {
  if (socket.destroyed || !socket.writable) return false;
  return socket.write(JSON.stringify(value) + '\n');
}

/**
 * Wait for the socket's write buffer to drain. Also settles on close/error so
 * a peer that vanishes mid-backpressure can never park a pump forever.
 */
export function socketDrain(socket: Socket): Promise<void> {
  if (socket.destroyed || !socket.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      socket.off('drain', settle);
      socket.off('close', settle);
      socket.off('error', settle);
      resolve();
    };
    socket.once('drain', settle);
    socket.once('close', settle);
    socket.once('error', settle);
  });
}
