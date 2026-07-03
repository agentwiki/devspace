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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
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
    const envId = segments[1] ? decodeURIComponent(segments[1]) : undefined;

    if (method === 'POST' && segments.length === 1) {
      const body = CreateEnvironmentRequestSchema.parse(await readJson(req));
      return sendJson(res, 201, await core.createEnvironment(body));
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
        const execReq = ExecRequestSchema.parse(await readJson(req));
        const { code, stdout, stderr } = await captureExec(await core.exec(envId, execReq));
        return sendJson(res, 200, { code, stdout: toBase64(stdout), stderr: toBase64(stderr) });
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

  const envId = decodeURIComponent(match[1]!);
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
  socket.on('close', () => stream.kill());

  // Client frames -> the stream. Honoring writeStdin's false with the stdin
  // drain keeps this pump bounded: meanwhile the line channel fills and pauses
  // the socket.
  const inbound = (async (): Promise<void> => {
    for (;;) {
      const next = await lines.pull();
      if (next.done) break;
      const parsed = ExecClientFrameSchema.safeParse(safeJson(next.value));
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
        stream.kill(frame.signal as NodeJS.Signals | undefined);
      }
    }
  })();

  // Stream frames -> the socket. Honoring write's false with socketDrain makes
  // a slow reader stop this loop; the M1 channel then pauses the child's pipes
  // and the kernel blocks the producer — backpressure end to end (Decision 2).
  try {
    for await (const frame of stream.frames as AsyncIterable<ExecFrame>) {
      if (socket.destroyed) {
        stream.kill();
        break;
      }
      if (!writeJsonLine(socket, frame)) await socketDrain(socket);
      if (frame.kind === 'exit') break;
    }
  } finally {
    socket.end();
    await inbound.catch(() => {});
  }
}

/** Answer a not-yet-upgraded socket with a plain HTTP error and close it. */
function refuse(socket: Socket, status: number, code: ErrorCode, message: string): void {
  const body = JSON.stringify({ code, message });
  socket.write(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
  socket.destroy();
}

function statusText(status: number): string {
  return (
    {
      401: 'Unauthorized',
      404: 'Not Found',
      409: 'Conflict',
      503: 'Service Unavailable',
    }[status] ?? 'Error'
  );
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                    */
/* -------------------------------------------------------------------------- */

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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
