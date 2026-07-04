/**
 * The remote sandbox surface + exec wire, end to end over real loopback HTTP/
 * TCP (m8-plan workstreams A/B): a real http.Server running the package
 * handlers against a fake SandboxCore — backed by REAL child processes for the
 * stream tests, the M1 discipline — driven by the real RemoteSandboxCore.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateEnvironmentRequest, Environment, ExecRequest } from '@devspace/contracts';
import { captureExec, createScriptedExecStream, fromBase64, toBase64 } from './exec.js';
import type { ExecStream } from './exec.js';
import { spawnExecStream } from './process-stream.js';
import { RemoteSandboxCore } from './remote-client.js';
import { LineDecoder } from './remote-protocol.js';
import { createSandboxRequestHandler, createSandboxUpgradeHandler } from './remote-server.js';
import { SandboxError } from './sandbox.js';
import type { SandboxCore } from './sandbox.js';

const TOKEN = 'internal-test-token';

function readyEnv(envId: string): Environment {
  return { envId, status: 'ready', ports: [], createdAt: new Date().toISOString() };
}

/** A fake core: every method overridable, sane defaults for the rest. */
function fakeCore(overrides: Partial<SandboxCore> = {}): SandboxCore {
  return {
    async createEnvironment() {
      return readyEnv('env_created');
    },
    async getEnvironment(envId) {
      return readyEnv(envId);
    },
    async listEnvironments() {
      return [readyEnv('env_listed')];
    },
    async applySecrets() {},
    async claimEnvironment(envId) {
      return readyEnv(envId);
    },
    async destroyEnvironment() {},
    async exec() {
      return createScriptedExecStream([{ kind: 'exit', code: 0 }]);
    },
    async fsRead() {
      return new TextEncoder().encode('file-bytes');
    },
    async fsWrite() {},
    async fsList() {
      return [{ name: 'a.txt', type: 'file' as const, size: 3 }];
    },
    async forwardPort() {
      return { proxyUrl: 'http://preview/t/tok/', token: 'tok' };
    },
    ...overrides,
  };
}

interface Loopback {
  url: string;
  client: RemoteSandboxCore;
  sockets: Set<Socket>;
}

const servers: Server[] = [];
const allSockets = new Set<Socket>();

async function startLoopback(
  core: SandboxCore,
  opts: { token?: string; clientToken?: string } = {},
): Promise<Loopback> {
  const token = 'token' in opts ? opts.token : TOKEN;
  const server = createServer(createSandboxRequestHandler(core, { token }));
  server.on('upgrade', createSandboxUpgradeHandler(core, { token }));
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    allSockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new RemoteSandboxCore(url, opts.clientToken ?? TOKEN, {
    highWaterMark: 8,
    lowWaterMark: 2,
  });
  return { url, client, sockets };
}

afterEach(async () => {
  for (const socket of allSockets) socket.destroy();
  allSockets.clear();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('remote JSON control surface', () => {
  it('round-trips the environment lifecycle', async () => {
    let destroyed: string | undefined;
    const seen: CreateEnvironmentRequest[] = [];
    const { client } = await startLoopback(
      fakeCore({
        async createEnvironment(req) {
          seen.push(req);
          return readyEnv('env_new');
        },
        async destroyEnvironment(envId) {
          destroyed = envId;
        },
      }),
    );

    const env = await client.createEnvironment({
      repoUrl: 'https://example.com/repo.git',
    } as CreateEnvironmentRequest);
    expect(env.envId).toBe('env_new');
    expect(env.status).toBe('ready');
    // Schema defaults were applied server-side before reaching the core.
    expect(seen[0]?.resources?.cpu).toBe(2);

    expect((await client.getEnvironment('env_new'))?.envId).toBe('env_new');
    await client.destroyEnvironment('env_new');
    expect(destroyed).toBe('env_new');
  });

  it('returns null for a missing environment', async () => {
    const { client } = await startLoopback(fakeCore({ getEnvironment: async () => null }));
    expect(await client.getEnvironment('nope')).toBeNull();
  });

  it('round-trips the env-table list (the M9 census read)', async () => {
    const { client } = await startLoopback(
      fakeCore({
        async listEnvironments() {
          return [readyEnv('env_1'), { ...readyEnv('env_2'), status: 'stopped' as const }];
        },
      }),
    );
    const listed = await client.listEnvironments();
    expect(listed.map((e) => [e.envId, e.status])).toEqual([
      ['env_1', 'ready'],
      ['env_2', 'stopped'],
    ]);
  });

  it('round-trips fs ops (binary-safe) and ports', async () => {
    const writes: Array<{ path: string; data: Uint8Array; mode?: number }> = [];
    const payload = new Uint8Array([0x00, 0xff, 0x0a, 0x42]);
    const { client } = await startLoopback(
      fakeCore({
        async fsRead() {
          return payload;
        },
        async fsWrite(_envId, path, data, mode) {
          writes.push({ path, data, mode });
        },
      }),
    );

    expect(Buffer.compare(Buffer.from(await client.fsRead('e', '/x')), Buffer.from(payload))).toBe(
      0,
    );
    await client.fsWrite('e', '/y', payload, 0o600);
    expect(writes[0]?.path).toBe('/y');
    expect(writes[0]?.mode).toBe(0o600);
    expect(Buffer.compare(Buffer.from(writes[0]!.data), Buffer.from(payload))).toBe(0);

    expect(await client.fsList('e', '/')).toEqual([{ name: 'a.txt', type: 'file', size: 3 }]);
    expect((await client.forwardPort('e', 3000)).proxyUrl).toBe('http://preview/t/tok/');
  });

  it('round-trips applySecrets (the M9 warm-claim seam)', async () => {
    const applied: Array<{ envId: string; names: string[] }> = [];
    const { client } = await startLoopback(
      fakeCore({
        async applySecrets(envId, secrets) {
          applied.push({ envId, names: secrets.map((s) => s.name) });
        },
      }),
    );
    await client.applySecrets('env_w', [
      { name: 'GH', value: 'v1', target: 'env' },
      { name: 'npmrc', value: 'v2', target: 'file', path: '/root/.npmrc' },
    ]);
    expect(applied).toEqual([{ envId: 'env_w', names: ['GH', 'npmrc'] }]);
  });

  it('round-trips claimEnvironment (the M10 pool hand-out)', async () => {
    const claims: string[] = [];
    const { client } = await startLoopback(
      fakeCore({
        async claimEnvironment(envId) {
          claims.push(envId);
          return readyEnv(envId); // poolKey already cleared by the host
        },
      }),
    );
    const env = await client.claimEnvironment('env_warm');
    expect(claims).toEqual(['env_warm']);
    expect(env.envId).toBe('env_warm');
    expect(env.poolKey).toBeUndefined();

    // Host-side refusals cross the wire with their codes intact.
    const { client: refusing } = await startLoopback(
      fakeCore({
        async claimEnvironment() {
          throw new SandboxError('CONFLICT', 'environment env_t is not pool-owned');
        },
      }),
    );
    const err = await refusing.claimEnvironment('env_t').catch((e: unknown) => e);
    expect((err as SandboxError).code).toBe('CONFLICT');
  });

  it('refuses applySecrets tokenless — secret plaintext never rides the open surface', async () => {
    const { url } = await startLoopback(fakeCore(), { token: undefined });
    const res = await fetch(`${url}/environments/e/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secrets: [{ name: 'X', value: 'v', target: 'env' }] }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain(
      'DEVSPACE_INTERNAL_TOKEN',
    );
  });

  it('maps remote SandboxError codes back onto SandboxError', async () => {
    const { client } = await startLoopback(
      fakeCore({
        async destroyEnvironment() {
          throw new SandboxError('NOT_FOUND', 'no such environment: ghost');
        },
      }),
    );
    const err = await client.destroyEnvironment('ghost').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('NOT_FOUND');
    expect((err as SandboxError).message).toContain('ghost');
  });

  it('rejects a bad bearer on every route but /health', async () => {
    const { url, client } = await startLoopback(fakeCore(), { clientToken: 'wrong' });
    const err = await client.getEnvironment('e').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).message).toContain('bearer');

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
  });

  it('keeps the JSON surface open when no token is configured (local ops mode)', async () => {
    const { client } = await startLoopback(fakeCore(), { token: undefined });
    expect((await client.getEnvironment('e'))?.envId).toBe('e');
  });

  it('refuses the capture exec tokenless — exec never runs unauthenticated', async () => {
    const { url } = await startLoopback(fakeCore(), { token: undefined });
    const res = await fetch(`${url}/environments/e/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: ['true'] }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain(
      'DEVSPACE_INTERNAL_TOKEN',
    );
  });

  it('answers 404 (not 500) for a malformed percent-encoded envId', async () => {
    const { url } = await startLoopback(fakeCore({ getEnvironment: async () => null }));
    const res = await fetch(`${url}/environments/%zz`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('caps the request body instead of buffering without bound', async () => {
    const { url } = await startLoopback(fakeCore());
    const res = await fetch(`${url}/environments/e/fs/write`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/x', data: 'A'.repeat(70 * 1024 * 1024) }),
    }).catch(() => null);
    // Either the server answered with the error envelope or it destroyed the
    // oversized request mid-flight; it must never 2xx.
    if (res) expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('LineDecoder', () => {
  it('carries a multi-byte UTF-8 character split across chunks', () => {
    const decoder = new LineDecoder();
    const line = Buffer.from(JSON.stringify({ cwd: '/workspace/한글-café-🎉' }) + '\n');
    // Split inside the emoji's 4-byte sequence.
    const cut = line.length - 6;
    const first = decoder.push(line.subarray(0, cut));
    const rest = decoder.push(line.subarray(cut));
    expect(first).toEqual([]);
    expect(rest).toHaveLength(1);
    expect(JSON.parse(rest[0]!)).toEqual({ cwd: '/workspace/한글-café-🎉' });
  });
});

describe('the devspace-exec wire', () => {
  /** A core whose exec launches a real local child (the M1 test discipline). */
  function childCore(
    launch: (req: ExecRequest) => ExecStream,
    overrides: Partial<SandboxCore> = {},
  ): { core: SandboxCore; requests: ExecRequest[] } {
    const requests: ExecRequest[] = [];
    const core = fakeCore({
      async exec(_envId, req) {
        requests.push(req);
        return launch(req);
      },
      ...overrides,
    });
    return { core, requests };
  }

  it('round-trips a full-duplex exec: binary stdin through cat', async () => {
    const { core, requests } = childCore(() => spawnExecStream('cat', []));
    const { client } = await startLoopback(core);

    const stream = await client.exec('env_1', { cmd: ['cat'], tty: false });
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x42, 0xfe, 0x0a]);
    stream.writeStdin(payload);
    stream.closeStdin();
    const { code, stdout } = await captureExec(stream);
    expect(code).toBe(0);
    expect(Buffer.compare(stdout, payload)).toBe(0);
    expect(await stream.done).toBe(0);
    // The ExecRequest crossed the wire intact (schema-validated server-side).
    expect(requests[0]?.cmd).toEqual(['cat']);
  });

  it('keeps stdout/stderr separate and propagates the exit code', async () => {
    const { core } = childCore(() =>
      spawnExecStream('sh', ['-c', 'printf out; printf err 1>&2; exit 3']),
    );
    const { client } = await startLoopback(core);
    const { code, stdout, stderr } = await captureExec(
      await client.exec('env_1', { cmd: ['sh'], tty: false }),
    );
    expect(stdout.toString()).toBe('out');
    expect(stderr.toString()).toBe('err');
    expect(code).toBe(3);
  });

  it('streams a large stdin payload with the drain protocol intact', async () => {
    const { core } = childCore(() => spawnExecStream('cat', []));
    const { client } = await startLoopback(core);
    const stream = await client.exec('env_1', { cmd: ['cat'], tty: false });

    // ~1MB of newline-free bytes: exercises write-false/drain plus line
    // reassembly across arbitrary TCP chunk boundaries.
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const CHUNK = 64 * 1024;
    for (let offset = 0; offset < payload.length; offset += CHUNK) {
      if (!stream.writeStdin(payload.subarray(offset, offset + CHUNK))) await stream.drain();
    }
    stream.closeStdin();

    const { code, stdout } = await captureExec(stream);
    expect(code).toBe(0);
    expect(stdout.length).toBe(payload.length);
    expect(Buffer.compare(stdout, payload)).toBe(0);
  });

  it('refuses before the upgrade: unknown env is 404 and exec is never dialed', async () => {
    let execCalled = false;
    const { client } = await startLoopback(
      fakeCore({
        async getEnvironment() {
          return null;
        },
        async exec() {
          execCalled = true;
          return createScriptedExecStream([{ kind: 'exit', code: 0 }]);
        },
      }),
    );
    const err = await client.exec('ghost', { cmd: ['true'], tty: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('NOT_FOUND');
    expect(execCalled).toBe(false);
  });

  it('refuses before the upgrade: not-ready env is 409', async () => {
    const { client } = await startLoopback(
      fakeCore({
        async getEnvironment(envId) {
          return { ...readyEnv(envId), status: 'provisioning' };
        },
      }),
    );
    const err = await client.exec('e', { cmd: ['true'], tty: false }).catch((e: unknown) => e);
    expect((err as SandboxError).code).toBe('CONFLICT');
  });

  it('refuses before the upgrade: bad bearer is 401', async () => {
    const { client } = await startLoopback(fakeCore(), { clientToken: 'wrong' });
    const err = await client.exec('e', { cmd: ['true'], tty: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).message).toContain('bearer');
  });

  it('never serves the exec stream tokenless (Decision 5)', async () => {
    const { client } = await startLoopback(fakeCore(), { token: undefined });
    const err = await client.exec('e', { cmd: ['true'], tty: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).message).toContain('DEVSPACE_INTERNAL_TOKEN');
  });

  it('forwards kill() through the wire to the remote stream', async () => {
    const { core } = childCore(() => spawnExecStream('sh', ['-c', 'exec sleep 30']));
    const { client } = await startLoopback(core);
    const stream = await client.exec('env_1', { cmd: ['sleep'], tty: false });
    // Give the first line (the ExecRequest) a moment to launch the child.
    await new Promise((r) => setTimeout(r, 200));
    stream.kill('SIGKILL');
    // 128 + SIGKILL(9) = 137, observed through two sockets and a child.
    expect(await stream.done).toBe(137);
  }, 30_000);

  it('survives an unknown kill signal from the wire (no crash, stream stays live)', async () => {
    const { core } = childCore(() => spawnExecStream('sh', ['-c', 'exec sleep 30']));
    const { client } = await startLoopback(core);
    const stream = await client.exec('env_1', { cmd: ['sleep'], tty: false });
    await new Promise((r) => setTimeout(r, 200));
    // ERR_UNKNOWN_SIGNAL territory: the server must drop it, not throw an
    // unhandled rejection that takes the whole svc (and this test) down.
    stream.kill('SIGBOGUS' as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 200));
    // The child is still running and the wire still works: a real kill lands.
    stream.kill('SIGKILL');
    expect(await stream.done).toBe(137);
  }, 30_000);

  it('synthesizes stderr + exit -1 when the connection dies before exit', async () => {
    const hanging: ExecStream = {
      writeStdin: () => true,
      drain: () => Promise.resolve(),
      closeStdin() {},
      kill() {},
      frames: {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<never>(() => {}) };
        },
      },
      done: new Promise<never>(() => {}),
    };
    const { core } = childCore(() => hanging);
    const { client, sockets } = await startLoopback(core);
    const stream = await client.exec('env_1', { cmd: ['hang'], tty: false });
    await new Promise((r) => setTimeout(r, 100));
    for (const socket of sockets) socket.destroy();
    const { code, stderr } = await captureExec(stream);
    expect(code).toBe(-1);
    expect(stderr.toString()).toContain('connection lost');
    expect(await stream.done).toBe(-1);
  });

  it('applies backpressure end to end: a parked client consumer stops the remote producer', async () => {
    // An unbounded producer measured at the source: every pull is counted, so
    // the M1 proof restates over TCP — if any hop buffered without bound, the
    // count would grow for as long as we idle.
    const counter = { pulled: 0 };
    const chunk = toBase64(Buffer.alloc(64 * 1024, 0x58));
    const producer: ExecStream = {
      writeStdin: () => true,
      drain: () => Promise.resolve(),
      closeStdin() {},
      kill() {},
      frames: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              counter.pulled += 1;
              return { value: { kind: 'stdout', data: chunk }, done: false };
            },
          };
        },
      },
      done: new Promise<never>(() => {}),
    };
    const { core } = childCore(() => producer);
    const { client } = await startLoopback(core);

    const stream = await client.exec('env_1', { cmd: ['spew'], tty: false });
    const iterator = stream.frames[Symbol.asyncIterator]();
    let received = 0;
    for (let i = 0; i < 5; i++) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.kind === 'stdout') received += fromBase64(value.data).length;
    }
    expect(received).toBe(5 * 64 * 1024);

    // Let every buffer in the path (server write queue, kernel snd/rcv, client
    // channel) fill and settle...
    await new Promise((r) => setTimeout(r, 300));
    const settled = counter.pulled;
    // ...then verify the producer is actually parked, not merely slow.
    await new Promise((r) => setTimeout(r, 300));
    expect(counter.pulled - settled).toBeLessThanOrEqual(1);
    // And the plateau is buffer-sized, nowhere near unbounded (64KB frames).
    expect(settled).toBeLessThan(500);
  });
});
