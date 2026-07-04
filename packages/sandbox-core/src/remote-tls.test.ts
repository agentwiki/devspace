/**
 * The remote sandbox surface over mutual TLS (M13, m13-plan workstream A):
 * the M8 loopback discipline re-run with real handshakes — an `https.Server`
 * requiring CA-signed client certificates, driven by the real
 * RemoteSandboxCore presenting a service identity. Certificates are minted
 * per run by shelling out to openssl (m13-plan Decision 7); the suite
 * self-skips when openssl is unavailable.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Environment } from '@devspace/contracts';
import { captureExec, createScriptedExecStream } from './exec.js';
import { serverTlsOptions, type InternalTlsIdentity } from './internal-tls.js';
import { spawnExecStream } from './process-stream.js';
import { RemoteSandboxCore } from './remote-client.js';
import { createSandboxRequestHandler, createSandboxUpgradeHandler } from './remote-server.js';
import type { SandboxCore } from './sandbox.js';
import { mintInternalTls, opensslAvailable } from './test-tls.js';

const hasOpenssl = await opensslAvailable();

function readyEnv(envId: string): Environment {
  return { envId, status: 'ready', ports: [], createdAt: new Date().toISOString() };
}

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
      return [];
    },
    async forwardPort() {
      return { proxyUrl: 'http://preview/t/tok/', token: 'tok' };
    },
    ...overrides,
  };
}

describe.runIf(hasOpenssl)('the sandbox surface over mutual TLS', () => {
  let host: InternalTlsIdentity;
  let orchestrator: InternalTlsIdentity;
  let gateway: InternalTlsIdentity;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const minted = await mintInternalTls(['sandbox-core', 'orchestrator', 'chat-gateway']);
    host = minted.identities['sandbox-core']!;
    orchestrator = minted.identities['orchestrator']!;
    gateway = minted.identities['chat-gateway']!;
    cleanup = minted.cleanup;
  });
  afterAll(() => cleanup());

  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });

  /** An https loopback host in TLS mode, serving `allow` (default orchestrator). */
  async function startTlsHost(
    core: SandboxCore,
    opts: { identity?: InternalTlsIdentity; allow?: string[] } = {},
  ): Promise<string> {
    const tls = { allow: opts.allow ?? ['orchestrator'] };
    const server = createHttpsServer(
      serverTlsOptions(opts.identity ?? host),
      createSandboxRequestHandler(core, { tls }),
    );
    server.on('upgrade', createSandboxUpgradeHandler(core, { tls }));
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('round-trips the lifecycle and a full-duplex exec with the orchestrator identity', async () => {
    const url = await startTlsHost(
      fakeCore({
        async exec() {
          return spawnExecStream('cat', []);
        },
      }),
    );
    const client = new RemoteSandboxCore(url, undefined, { tls: orchestrator });

    expect((await client.createEnvironment({ repoUrl: 'https://x/r.git' } as never)).envId).toBe(
      'env_created',
    );
    expect((await client.listEnvironments())[0]?.envId).toBe('env_listed');

    // The load-bearing stream crosses the handshake unchanged: a TLSSocket is
    // a Duplex and the M8 frame pumps do not care.
    const stream = await client.exec('env_1', { cmd: ['cat'], tty: false });
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x42]);
    stream.writeStdin(payload);
    stream.closeStdin();
    const { code, stdout } = await captureExec(stream);
    expect(code).toBe(0);
    expect(Buffer.compare(stdout, payload)).toBe(0);
  });

  it('serves applySecrets — transport auth satisfies the M8 token gate (Decision 5)', async () => {
    const applied: string[] = [];
    const url = await startTlsHost(
      fakeCore({
        async applySecrets(_envId, secrets) {
          applied.push(...secrets.map((s) => s.name));
        },
      }),
    );
    const client = new RemoteSandboxCore(url, undefined, { tls: orchestrator });
    await client.applySecrets('env_1', [{ name: 'GH', value: 'v', target: 'env' }]);
    expect(applied).toEqual(['GH']);
  });

  it('refuses a wrong-service peer on JSON routes and before the exec 101', async () => {
    let execDialed = false;
    const url = await startTlsHost(
      fakeCore({
        async exec() {
          execDialed = true;
          return createScriptedExecStream([{ kind: 'exit', code: 0 }]);
        },
      }),
    );
    // A CA-signed chat-gateway certificate authenticates, but this surface
    // serves the orchestrator only — the replay the shared token permitted.
    const impostor = new RemoteSandboxCore(url, undefined, {
      tls: { ...gateway, expectService: 'sandbox-core' },
    });
    const jsonErr = await impostor.getEnvironment('e').catch((e: unknown) => e as Error);
    expect((jsonErr as Error).message).toContain('not allowed');
    const execErr = await impostor
      .exec('e', { cmd: ['true'], tty: false })
      .catch((e: unknown) => e as Error);
    expect((execErr as Error).message).toContain('not allowed');
    expect(execDialed).toBe(false);
  });

  it('never completes the handshake for a certless client', async () => {
    const url = await startTlsHost(fakeCore());
    const err = await new Promise<Error>((resolve) => {
      const req = httpsRequest(`${url}/environments`, { ca: host.ca }, () =>
        resolve(new Error('unexpected response')),
      );
      req.on('error', resolve);
      req.end();
    });
    expect(err.message).not.toBe('unexpected response');
  });

  it('rejects a server that presents the wrong service identity', async () => {
    // The host answers with a valid CA-signed certificate — for the WRONG
    // service. The client must refuse before sending anything.
    const url = await startTlsHost(fakeCore(), { identity: gateway });
    const client = new RemoteSandboxCore(url, undefined, { tls: orchestrator });
    const err = await client.getEnvironment('e').catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('expected "sandbox-core"');
  });

  it('fails closed when a TLS-mode handler is mounted on a cleartext server', async () => {
    const server = createHttpServer(
      createSandboxRequestHandler(fakeCore(), { tls: { allow: ['orchestrator'] } }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/environments/e`,
    );
    expect(res.status).toBe(403);
  });
});

describe('one auth regime per deployment (m13-plan Decision 1)', () => {
  const identity = { cert: 'c', key: 'k', ca: 'ca' };

  it('refuses token + TLS on the server handlers', () => {
    const both = { token: 't', tls: { allow: ['orchestrator'] } };
    expect(() => createSandboxRequestHandler(fakeCore(), both)).toThrow(/mutually exclusive/);
    expect(() => createSandboxUpgradeHandler(fakeCore(), both)).toThrow(/mutually exclusive/);
  });

  it('refuses token + TLS, no auth at all, and a cleartext url on the client', () => {
    expect(() => new RemoteSandboxCore('https://h', 't', { tls: identity })).toThrow(
      /mutually exclusive/,
    );
    expect(() => new RemoteSandboxCore('https://h', undefined, {})).toThrow(/requires/);
    expect(() => new RemoteSandboxCore('http://h', undefined, { tls: identity })).toThrow(/https/);
  });
});
