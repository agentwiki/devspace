/**
 * RemoteSandboxCore (M8, m8-plan workstream B): the full `SandboxCore`
 * interface spoken against a remote sandbox-core-svc, so "the sandbox is on
 * another machine" is a constructor swap for the orchestrator and invisible to
 * agent-runner (its ExecProvider slice is exactly `exec()`).
 *
 * All calls ride node:http(s) requests with NO client-side timeout — global
 * fetch (undici) imposes a 300s headersTimeout that would sever a slow
 * `createEnvironment` (provisioning legitimately takes minutes) and orphan
 * the remote container. `exec()` rides the `devspace-exec` upgrade: the
 * returned `ExecStream` is the real thing — inbound frames land in the M1
 * watermark channel which pauses/resumes the SOCKET, so a slow consumer
 * closes TCP's receive window and the far end's pump stops pulling from the
 * container (backpressure end to end, m8-plan Decision 2).
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
  type SecretSpec,
} from '@devspace/contracts';
import { ExecFrameSchema } from '@devspace/contracts';
import { encodeStdin, fromBase64, toBase64 } from './exec.js';
import type { ExecStream } from './exec.js';
import { clientTlsOptions, type InternalTlsIdentity } from './internal-tls.js';
import { FrameChannel } from './process-stream.js';
import {
  EXEC_UPGRADE_PROTOCOL,
  LineDecoder,
  execUpgradePath,
  safeJsonLine,
  socketDrain,
  writeJsonLine,
} from './remote-protocol.js';
import { SandboxError } from './sandbox.js';
import type { SandboxCore } from './sandbox.js';

export interface RemoteSandboxCoreOptions {
  /**
   * Mutual-TLS mode (M13): dial with this identity and verify the host
   * presents the expected service name (default `sandbox-core`). Requires an
   * https:// base url; mutually exclusive with the bearer token.
   */
  tls?: InternalTlsIdentity & { expectService?: string };
  /** Watermarks for the client-side inbound frame channel (tests). */
  highWaterMark?: number;
  lowWaterMark?: number;
}

const SANDBOX_ERROR_CODES = new Set(['NOT_FOUND', 'CONFLICT', 'PROVISION_FAILED', 'EXEC_FAILED']);

interface JsonResponse {
  status: number;
  text: string;
}

export class RemoteSandboxCore implements SandboxCore {
  private readonly base: string;
  /** TLS connection options in mTLS mode; undefined in token mode. */
  private readonly tls?: ReturnType<typeof clientTlsOptions>;

  constructor(
    baseUrl: string,
    private readonly token: string | undefined,
    private readonly opts: RemoteSandboxCoreOptions = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
    // One auth regime, always authed (m13-plan Decision 1 / m8-plan Decision 5).
    if (token && opts.tls) {
      throw new Error('RemoteSandboxCore: bearer token and internal TLS are mutually exclusive');
    }
    if (!token && !opts.tls) {
      throw new Error('RemoteSandboxCore requires a bearer token or an internal TLS identity');
    }
    if (opts.tls) {
      if (!this.base.startsWith('https://')) {
        throw new Error(`internal TLS requires an https:// sandbox host url, got ${baseUrl}`);
      }
      this.tls = clientTlsOptions({
        ...opts.tls,
        expectService: opts.tls.expectService ?? 'sandbox-core',
      });
    }
  }

  async createEnvironment(req: CreateEnvironmentRequest): Promise<Environment> {
    const res = await this.request('POST', '/environments', req);
    if (res.status !== 201) throw this.toError(res, 'PROVISION_FAILED');
    return EnvironmentSchema.parse(JSON.parse(res.text));
  }

  async getEnvironment(envId: string): Promise<Environment | null> {
    const res = await this.request('GET', `/environments/${encodeURIComponent(envId)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw this.toError(res, 'EXEC_FAILED');
    return EnvironmentSchema.parse(JSON.parse(res.text));
  }

  async listEnvironments(): Promise<Environment[]> {
    const res = await this.request('GET', '/environments');
    if (res.status !== 200) throw this.toError(res, 'EXEC_FAILED');
    return (JSON.parse(res.text) as unknown[]).map((e) => EnvironmentSchema.parse(e));
  }

  async destroyEnvironment(envId: string): Promise<void> {
    const res = await this.request('DELETE', `/environments/${encodeURIComponent(envId)}`);
    if (res.status !== 204) throw this.toError(res, 'EXEC_FAILED');
  }

  async applySecrets(envId: string, secrets: SecretSpec[]): Promise<void> {
    await this.json(`/environments/${encodeURIComponent(envId)}/secrets`, { secrets });
  }

  async claimEnvironment(envId: string): Promise<Environment> {
    const body = await this.json(`/environments/${encodeURIComponent(envId)}/claim`, {});
    return EnvironmentSchema.parse(body);
  }

  /** Full-duplex exec over the devspace-exec upgrade. */
  async exec(envId: string, req: ExecRequest): Promise<ExecStream> {
    const socket = await this.upgrade(envId);
    return clientExecStream(socket, req, this.opts);
  }

  async fsRead(envId: string, path: string): Promise<Uint8Array> {
    const body = (await this.json(`/environments/${encodeURIComponent(envId)}/fs/read`, {
      path,
    })) as { data: string };
    return fromBase64(body.data);
  }

  async fsWrite(envId: string, path: string, data: Uint8Array, mode?: number): Promise<void> {
    await this.json(`/environments/${encodeURIComponent(envId)}/fs/write`, {
      path,
      data: toBase64(data),
      mode,
    });
  }

  async fsList(envId: string, path: string): Promise<FsEntry[]> {
    const body = (await this.json(`/environments/${encodeURIComponent(envId)}/fs/list`, {
      path,
    })) as { entries: unknown[] };
    return body.entries.map((e) => FsEntrySchema.parse(e));
  }

  async forwardPort(
    envId: string,
    containerPort: number,
  ): Promise<{ proxyUrl: string; token: string }> {
    const body = (await this.json(`/environments/${encodeURIComponent(envId)}/ports`, {
      containerPort,
    })) as { proxyUrl: string; token: string };
    return { proxyUrl: body.proxyUrl, token: body.token };
  }

  /* ------------------------------------------------------------------------ */

  /** The auth header rides only in token mode; TLS mode authenticates itself. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}`, ...extra } : extra;
  }

  /** One JSON request over node:http(s); no timeout by design (see header). */
  private request(method: string, path: string, body?: unknown): Promise<JsonResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.base}${path}`);
      const dial = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = dial(url, {
        method,
        headers: this.headers({ 'content-type': 'application/json' }),
        ...this.tls,
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  /** POST helper for the 2xx-JSON-or-error routes. */
  private async json(path: string, body: unknown): Promise<unknown> {
    const res = await this.request('POST', path, body);
    if (res.status < 200 || res.status >= 300) throw this.toError(res, 'EXEC_FAILED');
    return res.text ? JSON.parse(res.text) : undefined;
  }

  /** Map a remote error envelope back onto SandboxError, preserving known codes. */
  private toError(res: JsonResponse, fallback: SandboxError['code']): SandboxError {
    try {
      const body = JSON.parse(res.text) as { code?: string; message?: string };
      const code = SANDBOX_ERROR_CODES.has(body.code ?? '')
        ? (body.code as SandboxError['code'])
        : fallback;
      return new SandboxError(code, body.message ?? `remote sandbox HTTP ${res.status}`);
    } catch {
      return new SandboxError(fallback, `remote sandbox HTTP ${res.status}: ${res.text}`);
    }
  }

  /** Dial the exec upgrade; a non-101 answer maps back onto SandboxError. */
  private upgrade(envId: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.base}${execUpgradePath(envId)}`);
      const dial = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = dial(url, {
        method: 'GET',
        headers: this.headers({
          connection: 'Upgrade',
          upgrade: EXEC_UPGRADE_PROTOCOL,
        }),
        ...this.tls,
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
          reject(
            this.toError(
              { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') },
              'EXEC_FAILED',
            ),
          );
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
      const parsed = ExecFrameSchema.safeParse(safeJsonLine(line));
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
      return send(encodeStdin(bytes));
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
