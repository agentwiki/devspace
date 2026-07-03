/**
 * RemoteSandboxCore (M8, m8-plan workstream B): the full `SandboxCore`
 * interface spoken against a remote sandbox-core-svc, so "the sandbox is on
 * another machine" is a constructor swap for the orchestrator and invisible to
 * agent-runner (its ExecProvider slice is exactly `exec()`).
 *
 * Lifecycle/fs/ports ride plain JSON over injected fetch (the internal-http
 * client pattern; no timeout on create — provisioning legitimately takes
 * minutes). `exec()` rides the `devspace-exec` upgrade: the returned
 * `ExecStream` is the real thing — inbound frames land in the M1 watermark
 * channel which pauses/resumes the SOCKET, so a slow consumer closes TCP's
 * receive window and the far end's pump stops pulling from the container
 * (backpressure end to end, m8-plan Decision 2).
 */
import { request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import {
  EnvironmentSchema,
  FsEntrySchema,
  type CreateEnvironmentRequest,
  type Environment,
  type ExecClientFrame,
  type ExecFrame,
  type ExecRequest,
  type FsEntry,
} from '@devspace/contracts';
import { ExecFrameSchema } from '@devspace/contracts';
import { fromBase64, toBase64 } from './exec.js';
import type { ExecStream } from './exec.js';
import { FrameChannel } from './process-stream.js';
import {
  EXEC_UPGRADE_PROTOCOL,
  LineDecoder,
  execUpgradePath,
  socketDrain,
  writeJsonLine,
} from './remote-protocol.js';
import { SandboxError } from './sandbox.js';
import type { SandboxCore } from './sandbox.js';

type FetchLike = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface RemoteSandboxCoreOptions {
  /** Injected in tests. Defaults to global fetch (Node 22+). */
  fetchImpl?: FetchLike;
  /** Watermarks for the client-side inbound frame channel (tests). */
  highWaterMark?: number;
  lowWaterMark?: number;
}

const SANDBOX_ERROR_CODES = new Set(['NOT_FOUND', 'CONFLICT', 'PROVISION_FAILED', 'EXEC_FAILED']);

export class RemoteSandboxCore implements SandboxCore {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly opts: RemoteSandboxCoreOptions = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async createEnvironment(req: CreateEnvironmentRequest): Promise<Environment> {
    const body = await this.json('POST', '/environments', req, 'PROVISION_FAILED');
    return EnvironmentSchema.parse(body);
  }

  async getEnvironment(envId: string): Promise<Environment | null> {
    const res = await this.fetchImpl(`${this.base}/environments/${encodeURIComponent(envId)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res, 'EXEC_FAILED');
    return EnvironmentSchema.parse(await res.json());
  }

  async destroyEnvironment(envId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/environments/${encodeURIComponent(envId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw await this.toError(res, 'EXEC_FAILED');
  }

  /** Full-duplex exec over the devspace-exec upgrade. */
  async exec(envId: string, req: ExecRequest): Promise<ExecStream> {
    const socket = await this.upgrade(envId);
    return clientExecStream(socket, req, this.opts);
  }

  async fsRead(envId: string, path: string): Promise<Uint8Array> {
    const body = (await this.json('POST', `/environments/${encodeURIComponent(envId)}/fs/read`, {
      path,
    })) as { data: string };
    return fromBase64(body.data);
  }

  async fsWrite(envId: string, path: string, data: Uint8Array, mode?: number): Promise<void> {
    await this.json('POST', `/environments/${encodeURIComponent(envId)}/fs/write`, {
      path,
      data: toBase64(data),
      mode,
    });
  }

  async fsList(envId: string, path: string): Promise<FsEntry[]> {
    const body = (await this.json('POST', `/environments/${encodeURIComponent(envId)}/fs/list`, {
      path,
    })) as { entries: unknown[] };
    return body.entries.map((e) => FsEntrySchema.parse(e));
  }

  async forwardPort(
    envId: string,
    containerPort: number,
  ): Promise<{ proxyUrl: string; token: string }> {
    const body = (await this.json('POST', `/environments/${encodeURIComponent(envId)}/ports`, {
      containerPort,
    })) as { proxyUrl: string; token: string };
    return { proxyUrl: body.proxyUrl, token: body.token };
  }

  /* ------------------------------------------------------------------------ */

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
  }

  private async json(
    method: string,
    path: string,
    body: unknown,
    fallback: SandboxError['code'] = 'EXEC_FAILED',
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.toError(res, fallback);
    if (res.status === 204) return undefined;
    return res.json();
  }

  /** Map a remote error envelope back onto SandboxError, preserving known codes. */
  private async toError(
    res: { status: number; text(): Promise<string> },
    fallback: SandboxError['code'],
  ): Promise<SandboxError> {
    const text = await res.text().catch(() => '');
    try {
      const body = JSON.parse(text) as { code?: string; message?: string };
      const code = SANDBOX_ERROR_CODES.has(body.code ?? '')
        ? (body.code as SandboxError['code'])
        : fallback;
      return new SandboxError(code, body.message ?? `remote sandbox HTTP ${res.status}`);
    } catch {
      return new SandboxError(fallback, `remote sandbox HTTP ${res.status}: ${text}`);
    }
  }

  /** Dial the exec upgrade; a non-101 answer maps back onto SandboxError. */
  private upgrade(envId: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${this.base}${execUpgradePath(envId)}`, {
        method: 'GET',
        headers: {
          connection: 'Upgrade',
          upgrade: EXEC_UPGRADE_PROTOCOL,
          authorization: `Bearer ${this.token}`,
        },
      });
      req.on('upgrade', (_res, socket, head) => {
        // The server speaks only after our first line, but keep any early
        // bytes anyway — unshift returns them to the readable queue.
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          void this.toError(
            { status: res.statusCode ?? 0, text: async () => text },
            'EXEC_FAILED',
          ).then(reject);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }
}

/** Wrap an upgraded socket as a real ExecStream (the client rim of the wire). */
function clientExecStream(
  socket: Socket,
  execReq: ExecRequest,
  opts: RemoteSandboxCoreOptions,
): ExecStream {
  socket.setNoDelay(true);

  let exited = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));

  const frames = new FrameChannel<ExecFrame>(
    opts.highWaterMark ?? 256,
    opts.lowWaterMark ?? 64,
    () => socket.pause(),
    () => socket.resume(),
  );

  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    frames.push({ kind: 'exit', code });
    frames.end();
    resolveDone(code);
  };

  const decoder = new LineDecoder();
  socket.on('data', (chunk: Buffer) => {
    for (const line of decoder.push(chunk)) {
      const parsed = ExecFrameSchema.safeParse(safeJson(line));
      if (!parsed.success || parsed.data.kind === 'stdin') continue; // protocol noise
      if (parsed.data.kind === 'exit') {
        finish(parsed.data.code);
        socket.end();
        return;
      }
      frames.push(parsed.data);
    }
  });
  socket.on('error', () => socket.destroy());
  // A connection lost before the exit frame is the M1 spawn-error convention:
  // an explanatory stderr frame, then exit -1 — consumers never hang.
  socket.on('close', () => {
    if (exited) return;
    frames.push({
      kind: 'stderr',
      data: toBase64(Buffer.from('remote exec: connection lost before exit\n')),
    });
    finish(-1);
  });

  // Line one: the ExecRequest (never a header — it can carry the LLM key).
  writeJsonLine(socket, execReq);

  const send = (frame: ExecClientFrame): boolean => writeJsonLine(socket, frame);

  return {
    writeStdin(bytes: Uint8Array): boolean {
      if (exited) return false;
      return send({ kind: 'stdin', data: toBase64(bytes) });
    },
    drain(): Promise<void> {
      return socketDrain(socket);
    },
    closeStdin(): void {
      send({ kind: 'stdin_close' });
    },
    frames: {
      [Symbol.asyncIterator](): AsyncIterator<ExecFrame> {
        return { next: () => frames.pull() };
      },
    },
    done,
    // Forwarded to the remote stream's kill() — the docker-exec caveat applies
    // there unchanged; hard stops still go through killCommand()/destroy().
    kill(signal?: NodeJS.Signals): void {
      send({ kind: 'kill', signal });
    },
  };
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
