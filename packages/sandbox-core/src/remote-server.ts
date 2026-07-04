/**
 * The remote sandbox surface (M8, m8-plan workstreams A/B): sandbox-core-svc's
 * HTTP routing, moved into the package so it is tested over loopback, plus the
 * `devspace-exec` Upgrade endpoint that finally carries the load-bearing exec
 * stream over the network (top-risk #1).
 *
 * Auth (m8-plan Decision 5): with a token configured, every route except
 * `/health` requires the internal bearer. Without one, the JSON surface stays
 * open — the pre-M8 local ops/debug posture — but the exec stream refuses to
 * serve: a full-duplex exec that injects per-env secrets never runs
 * unauthenticated.
 */
import { STATUS_CODES } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { constants as osConstants } from 'node:os';
import {
  ApplySecretsRequestSchema,
  CreateEnvironmentRequestSchema,
  ExecClientFrameSchema,
  ExecRequestSchema,
  FsListRequestSchema,
  FsReadRequestSchema,
  FsWriteRequestSchema,
} from '@devspace/contracts';
import type { ErrorCode, ExecFrame } from '@devspace/contracts';
import { z } from 'zod';
import { captureExec, fromBase64, toBase64 } from './exec.js';
import type { ExecStream } from './exec.js';
import { FrameChannel } from './process-stream.js';
import {
  EXEC_UPGRADE_PROTOCOL,
  LineDecoder,
  safeJsonLine,
  socketDrain,
  verifyBearer,
  writeJsonLine,
} from './remote-protocol.js';
import { SandboxError } from './sandbox.js';
import type { SandboxCore } from './sandbox.js';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PROVISION_FAILED: 500,
  EXEC_FAILED: 500,
  AGENT_FAILED: 500,
  GUARDRAIL_BLOCKED: 403,
  INTERNAL: 500,
};

export interface SandboxServerOptions {
  /** Shared internal bearer (DEVSPACE_INTERNAL_TOKEN). See Decision 5. */
  token?: string;
  /** Service name echoed by /health. */
  service?: string;
  onLog?: (line: string) => void;
  /** Watermarks for the per-connection inbound line channel (tests). */
  highWaterMark?: number;
  lowWaterMark?: number;
}

/* -------------------------------------------------------------------------- */
/* JSON control surface                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build the request handler for the JSON control surface (env lifecycle, fs,
 * capture exec, ports, /health). Hand it straight to `createServer`.
 */
export function createSandboxRequestHandler(
  core: SandboxCore,
  opts: SandboxServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const service = opts.service ?? 'sandbox-core';
  return (req, res) => {
    handle(core, service, opts.token, req, res).catch((err) => sendError(res, err));
  };
}

async function handle(
  core: SandboxCore,
  service: string,
  token: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', service });
  }

  // Everything but /health sits behind the bearer once a token is configured.
  if (token && !verifyBearer(req.headers.authorization, token)) {
    return sendJson(res, 401, { code: 'UNAUTHORIZED', message: 'bad or missing bearer token' });
  }

  if (segments[0] === 'environments') {
    const envId = segments[1] ? tryDecode(segments[1]) : undefined;

    if (method === 'POST' && segments.length === 1) {
      const body = CreateEnvironmentRequestSchema.parse(await readJson(req));
      return sendJson(res, 201, await core.createEnvironment(body));
    }

    // The census/ops read (M9): the host's env table, as it stands.
    if (method === 'GET' && segments.length === 1) {
      return sendJson(res, 200, await core.listEnvironments());
    }

    if (envId) {
      if (method === 'GET' && segments.length === 2) {
        const env = await core.getEnvironment(envId);
        if (!env) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
        return sendJson(res, 200, env);
      }
      if (method === 'DELETE' && segments.length === 2) {
        await core.destroyEnvironment(envId);
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST' && segments[2] === 'exec') {
        // Exec injects per-env secrets, so — like the upgrade stream — it
        // never serves unauthenticated (Decision 5); fs/lifecycle stay open
        // as the local ops surface they have been since M1.
        if (!token) {
          return sendJson(res, 503, {
            code: 'INTERNAL',
            message: 'exec requires DEVSPACE_INTERNAL_TOKEN',
          });
        }
        const execReq = ExecRequestSchema.parse(await readJson(req));
        const { code, stdout, stderr } = await captureExec(await core.exec(envId, execReq));
        return sendJson(res, 200, { code, stdout: toBase64(stdout), stderr: toBase64(stderr) });
      }
      if (method === 'POST' && segments[2] === 'secrets') {
        // Secret plaintext, so the same line as exec (Decision 5): never
        // served on the open tokenless surface.
        if (!token) {
          return sendJson(res, 503, {
            code: 'INTERNAL',
            message: 'applySecrets requires DEVSPACE_INTERNAL_TOKEN',
          });
        }
        const { secrets } = ApplySecretsRequestSchema.parse(await readJson(req));
        await core.applySecrets(envId, secrets);
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST' && segments[2] === 'claim' && segments.length === 3) {
        // Pool hand-out (M10): refresh + unmark on the owning host. No secret
        // plaintext crosses, so — like the rest of the lifecycle — it stays
        // on the open local-ops surface (m10-plan Decision 4).
        return sendJson(res, 200, await core.claimEnvironment(envId));
      }
      if (method === 'POST' && segments[2] === 'fs' && segments[3] === 'read') {
        const { path } = FsReadRequestSchema.parse(await readJson(req));
        return sendJson(res, 200, { data: toBase64(await core.fsRead(envId, path)) });
      }
      if (method === 'POST' && segments[2] === 'fs' && segments[3] === 'write') {
        const { path, data, mode } = FsWriteRequestSchema.parse(await readJson(req));
        await core.fsWrite(envId, path, fromBase64(data), mode);
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST' && segments[2] === 'fs' && segments[3] === 'list') {
        const { path } = FsListRequestSchema.parse(await readJson(req));
        return sendJson(res, 200, { entries: await core.fsList(envId, path) });
      }
      if (method === 'POST' && segments[2] === 'ports') {
        const { containerPort } = z
          .object({ containerPort: z.number().int().min(1).max(65535) })
          .parse(await readJson(req));
        return sendJson(res, 201, await core.forwardPort(envId, containerPort));
      }
    }
  }

  throw new SandboxError('NOT_FOUND', `no route for ${method} ${url.pathname}`);
}

/* -------------------------------------------------------------------------- */
/* The devspace-exec upgrade endpoint                                          */
/* -------------------------------------------------------------------------- */

const EXEC_PATH = /^\/environments\/([^/]+)\/exec$/;

/**
 * Build the `upgrade` handler for the exec wire. Everything checkable is
 * answered as plain HTTP BEFORE the 101 (Decision 3): bearer, env existence,
 * env readiness. After the 101, the first client line is the `ExecRequest`
 * (per-exec env can carry the LLM key, so it is never a header), then the
 * socket is a frame pipe until the `exit` frame + FIN.
 */
export function createSandboxUpgradeHandler(
  core: SandboxCore,
  opts: SandboxServerOptions = {},
): (req: IncomingMessage, socket: Socket, head: Buffer) => void {
  const onLog = opts.onLog ?? (() => {});
  return (req, socket, head) => {
    serveUpgrade(core, opts, req, socket, head).catch((err) => {
      onLog(`exec upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.destroy();
    });
  };
}

async function serveUpgrade(
  core: SandboxCore,
  opts: SandboxServerOptions,
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = EXEC_PATH.exec(url.pathname);
  const upgrade = (req.headers.upgrade ?? '').toLowerCase();

  if (!match || upgrade !== EXEC_UPGRADE_PROTOCOL) {
    return refuse(socket, 404, 'NOT_FOUND', `no upgrade route for ${url.pathname}`);
  }
  // The exec stream NEVER serves unauthenticated (Decision 5).
  if (!opts.token) {
    return refuse(socket, 503, 'INTERNAL', 'exec stream requires DEVSPACE_INTERNAL_TOKEN');
  }
  if (!verifyBearer(req.headers.authorization, opts.token)) {
    return refuse(socket, 401, 'UNAUTHORIZED', 'bad or missing bearer token');
  }

  const envId = tryDecode(match[1]!);
  const env = await core.getEnvironment(envId);
  if (!env) return refuse(socket, 404, 'NOT_FOUND', `no such environment: ${envId}`);
  if (env.status !== 'ready') {
    return refuse(socket, 409, 'CONFLICT', `environment ${envId} is not ready (${env.status})`);
  }

  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\n` +
      `upgrade: ${EXEC_UPGRADE_PROTOCOL}\r\nconnection: Upgrade\r\n\r\n`,
  );
  socket.setNoDelay(true);

  // Inbound lines land in the M1 watermark channel; crossing high-water pauses
  // the SOCKET, so a slow stdin sink closes TCP's window against the client.
  const lines = new FrameChannel<string>(
    opts.highWaterMark ?? 256,
    opts.lowWaterMark ?? 64,
    () => socket.pause(),
    () => socket.resume(),
  );
  const decoder = new LineDecoder();
  const pushChunk = (chunk: Buffer): void => {
    for (const line of decoder.push(chunk)) lines.push(line);
  };
  if (head.length > 0) pushChunk(head);
  socket.on('data', pushChunk);
  socket.on('error', () => socket.destroy());
  socket.on('close', () => lines.end());

  // First line: the ExecRequest. Anything wrong past this point is in-band —
  // a stderr frame + exit -1, the M1 spawn-error convention.
  let stream: ExecStream;
  try {
    const first = await lines.pull();
    if (first.done) {
      socket.destroy();
      return;
    }
    const execReq = ExecRequestSchema.parse(JSON.parse(first.value));
    stream = await core.exec(envId, execReq);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJsonLine(socket, {
      kind: 'stderr',
      data: toBase64(Buffer.from(`exec failed: ${message}\n`)),
    });
    writeJsonLine(socket, { kind: 'exit', code: -1 });
    socket.end();
    return;
  }

  // A client that vanishes mid-turn must not leave the local stream consumer
  // parked (docker-exec caveat: the in-container tree is reaped by destroy).
  // 'close' may already have fired while core.exec was pending — events are
  // not sticky, so check the flag as well as registering the handler.
  socket.on('close', () => killQuietly(stream, undefined, opts.onLog));
  if (socket.destroyed) killQuietly(stream, undefined, opts.onLog);

  // Client frames -> the stream. Honoring writeStdin's false with the stdin
  // drain keeps this pump bounded: meanwhile the line channel fills and pauses
  // the socket. The chained catch makes `inbound` unrejectable — a pump error
  // must never become an unhandled rejection that takes the whole svc down.
  const inbound = (async (): Promise<void> => {
    for (;;) {
      const next = await lines.pull();
      if (next.done) break;
      const parsed = ExecClientFrameSchema.safeParse(safeJsonLine(next.value));
      if (!parsed.success) {
        opts.onLog?.(`dropping malformed client frame (${next.value.length} bytes)`);
        continue;
      }
      const frame = parsed.data;
      if (frame.kind === 'stdin') {
        if (!stream.writeStdin(fromBase64(frame.data))) await stream.drain();
      } else if (frame.kind === 'stdin_close') {
        stream.closeStdin();
      } else {
        killQuietly(stream, frame.signal, opts.onLog);
      }
    }
  })().catch((err) => {
    opts.onLog?.(`inbound pump failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Stream frames -> the socket. Honoring write's false with socketDrain makes
  // a slow reader stop this loop; the M1 channel then pauses the child's pipes
  // and the kernel blocks the producer — backpressure end to end (Decision 2).
  try {
    for await (const frame of stream.frames as AsyncIterable<ExecFrame>) {
      if (socket.destroyed) {
        killQuietly(stream, undefined, opts.onLog);
        break;
      }
      if (!writeJsonLine(socket, frame)) await socketDrain(socket);
      if (frame.kind === 'exit') break;
    }
  } finally {
    socket.end();
    await inbound;
  }
}

/**
 * kill() with the wire's trust boundary applied: an unknown signal name from a
 * peer must not throw ERR_UNKNOWN_SIGNAL through the pump (the schema only
 * guarantees a string). An invalid name is a peer bug — it is dropped with a
 * log line, never reinterpreted as some other signal.
 */
function killQuietly(
  stream: ExecStream,
  signal: string | undefined,
  onLog?: (line: string) => void,
): void {
  if (signal !== undefined && !(signal in osConstants.signals)) {
    onLog?.(`ignoring unknown kill signal "${signal}"`);
    return;
  }
  try {
    stream.kill(signal as NodeJS.Signals | undefined);
  } catch (err) {
    onLog?.(`kill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Answer a not-yet-upgraded socket with a plain HTTP error and close it. */
function refuse(socket: Socket, status: number, code: ErrorCode, message: string): void {
  const body = JSON.stringify({ code, message });
  // end(), not write()+destroy(): destroy would race the kernel flush and can
  // drop the response (the client then sees ECONNRESET instead of the error).
  socket.once('error', () => {});
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
      `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
}

/** decodeURIComponent that treats malformed escapes as literals, not a 500. */
function tryDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                    */
/* -------------------------------------------------------------------------- */

// Body cap: generous because fsWrite legitimately carries multi-MB base64
// payloads (unlike the orchestrator's 1MB internal API), but still bounded so
// a bad client cannot buffer arbitrary memory into the host.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.destroy();
      throw new SandboxError('EXEC_FAILED', `request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  let code: ErrorCode = 'INTERNAL';
  let message = 'internal error';
  if (err instanceof SandboxError) {
    code = err.code;
    message = err.message;
  } else if (err instanceof z.ZodError) {
    code = 'BAD_REQUEST';
    message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  } else if (err instanceof SyntaxError) {
    code = 'BAD_REQUEST';
    message = 'invalid JSON body';
  } else if (err instanceof Error) {
    message = err.message;
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, ERROR_STATUS[code], { code, message });
}
