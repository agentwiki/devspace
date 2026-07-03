/**
 * Preview proxy suite (M6-B). Like the egress-proxy tests, everything runs
 * over REAL loopback sockets — a genuine upstream HTTP server behind the
 * proxy — with zero external egress (CI-safe).
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PreviewProxy, parsePreviewPath, previewProxyFromEnv } from './preview-proxy.js';

describe('parsePreviewPath', () => {
  it.each([
    ['/t/abc123/', { token: 'abc123', rest: '/' }],
    ['/t/abc123', { token: 'abc123', rest: '/' }],
    ['/t/abc123/some/deep/path', { token: 'abc123', rest: '/some/deep/path' }],
    ['/t/abc123/search?q=1&x=2', { token: 'abc123', rest: '/search?q=1&x=2' }],
    ['/t/abc123?q=1', { token: 'abc123', rest: '/?q=1' }],
    ['/x/abc123/', null],
    ['/t//', null],
    ['/t/', null],
    ['/', null],
    ['/t/bad$token/', null],
  ])('%s', (input, expected) => {
    expect(parsePreviewPath(input)).toEqual(expected);
  });
});

describe('previewProxyFromEnv', () => {
  it('is off without PREVIEW_PROXY_PORT', () => {
    expect(previewProxyFromEnv({})).toBeUndefined();
  });
  it('reads port, bind host, and public base', () => {
    expect(
      previewProxyFromEnv({
        PREVIEW_PROXY_PORT: '4010',
        PREVIEW_BIND_HOST: '10.0.0.1',
        PREVIEW_BASE_URL: 'https://preview.example.com',
      }),
    ).toEqual({ port: 4010, bindHost: '10.0.0.1', publicBaseUrl: 'https://preview.example.com' });
  });
  it('defaults the env-driven bind host to 0.0.0.0 (opting in = serving users)', () => {
    expect(previewProxyFromEnv({ PREVIEW_PROXY_PORT: '4010' })).toMatchObject({
      bindHost: '0.0.0.0',
    });
  });
  it('rejects a malformed port', () => {
    expect(() => previewProxyFromEnv({ PREVIEW_PROXY_PORT: 'lots' })).toThrow(/PREVIEW_PROXY_PORT/);
  });
});

describe('PreviewProxy over loopback', () => {
  let upstream: Server;
  let upstreamPort: number;
  let upstreamDials = 0;
  let lastUpstreamReq: { url?: string; method?: string; host?: string; body?: string };
  let proxy: PreviewProxy;
  let baseUrl: string;

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res) => {
      upstreamDials += 1;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamReq = {
          url: req.url,
          method: req.method,
          host: req.headers.host,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(418, { 'x-upstream': 'yes' });
        res.end(`echo:${req.url}`);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    proxy = new PreviewProxy({
      generateToken: (() => {
        let n = 0;
        return () => `tok${(n += 1)}`;
      })(),
    });
    ({ baseUrl } = await proxy.start());
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('routes /t/<token>/… to the target, stripping the prefix and rewriting Host', async () => {
    const route = proxy.register('env_1', { host: '127.0.0.1', port: upstreamPort });
    expect(route.proxyUrl).toBe(`${baseUrl}/t/${route.token}/`);

    const res = await fetch(`${baseUrl}/t/${route.token}/hello/world?q=1`, {
      method: 'POST',
      body: 'payload',
    });
    expect(res.status).toBe(418);
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(await res.text()).toBe('echo:/hello/world?q=1');
    expect(lastUpstreamReq).toMatchObject({
      url: '/hello/world?q=1',
      method: 'POST',
      host: `127.0.0.1:${upstreamPort}`,
      body: 'payload',
    });
  });

  it('404s an unknown token without dialing any upstream', async () => {
    const before = upstreamDials;
    const res = await fetch(`${baseUrl}/t/never-registered/`);
    expect(res.status).toBe(404);
    expect(upstreamDials).toBe(before);
  });

  it('404s non-preview paths', async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(404);
  });

  it('revokeEnv kills every route for the env — and only that env', async () => {
    const dead = proxy.register('env_dead', { host: '127.0.0.1', port: upstreamPort });
    const alive = proxy.register('env_alive', { host: '127.0.0.1', port: upstreamPort });
    proxy.revokeEnv('env_dead');
    expect((await fetch(`${baseUrl}/t/${dead.token}/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/t/${alive.token}/`)).status).toBe(418);
    proxy.revokeEnv('env_missing'); // idempotent no-op
  });

  it('502s when the target is unreachable', async () => {
    const route = proxy.register('env_gone', { host: '127.0.0.1', port: 1 });
    const res = await fetch(`${baseUrl}/t/${route.token}/`);
    expect(res.status).toBe(502);
  });

  it('register requires a started proxy or a configured publicBaseUrl', () => {
    const cold = new PreviewProxy();
    expect(() => cold.register('env_x', { host: 'h', port: 1 })).toThrow(/not started/);
    const preconfigured = new PreviewProxy({ publicBaseUrl: 'https://p.example.com/' });
    const route = preconfigured.register('env_x', { host: 'h', port: 1 });
    expect(route.proxyUrl).toBe(`https://p.example.com/t/${route.token}/`);
  });
});

/* -------------------------------------------------------------------------- */
/* WebSocket upgrade (M7-A)                                                    */
/* -------------------------------------------------------------------------- */

type UpgradeOutcome =
  | { kind: 'upgraded'; res: IncomingMessage; socket: Socket; head: Buffer }
  | { kind: 'response'; res: IncomingMessage; body: string };

/** Send an Upgrade request through the proxy with a raw node http client. */
function upgradeThrough(baseUrl: string, path: string): Promise<UpgradeOutcome> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'x-ws-key': 'k1' },
    });
    req.on('upgrade', (res, socket, head) => resolve({ kind: 'upgraded', res, socket, head }));
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ kind: 'response', res, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const nextData = (socket: Socket): Promise<string> =>
  new Promise((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString('utf8'))));

const closed = (socket: Socket): Promise<void> =>
  new Promise((resolve) => socket.once('close', () => resolve()));

describe('PreviewProxy WebSocket upgrade', () => {
  let upstream: Server;
  let upstreamPort: number;
  let upgradeDials = 0;
  let lastUpgradeReq: { url?: string; host?: string };
  let proxy: PreviewProxy;
  let baseUrl: string;

  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(200);
      res.end('plain');
    });
    upstream.on('upgrade', (req, socket) => {
      upgradeDials += 1;
      lastUpgradeReq = { url: req.url, host: req.headers.host };
      if (req.url === '/reject') {
        // A server that refuses the handshake with an ordinary response.
        socket.end(
          'HTTP/1.1 403 Forbidden\r\nx-reason: nope\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnope',
        );
        return;
      }
      // Complete the handshake, then echo every byte back.
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nx-accept: ok\r\n\r\n',
      );
      socket.on('data', (d: Buffer) => socket.write(d));
      // http-server sockets allow half-open: fully close when the peer does,
      // or upstream.close() in afterAll would wait on it forever.
      socket.on('end', () => socket.destroy());
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    proxy = new PreviewProxy();
    ({ baseUrl } = await proxy.start());
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('completes the handshake and splices bytes both ways', async () => {
    const route = proxy.register('env_ws', { host: '127.0.0.1', port: upstreamPort });
    const outcome = await upgradeThrough(baseUrl, `/t/${route.token}/live?x=1`);
    expect(outcome.kind).toBe('upgraded');
    if (outcome.kind !== 'upgraded') return;

    // The 101 head comes through with the upstream's own headers; the
    // handshake request reached the upstream prefix-stripped and Host-rewritten.
    expect(outcome.res.statusCode).toBe(101);
    expect(outcome.res.headers['x-accept']).toBe('ok');
    expect(lastUpgradeReq).toEqual({
      url: '/live?x=1',
      host: `127.0.0.1:${upstreamPort}`,
    });

    outcome.socket.write('ping-1');
    expect(await nextData(outcome.socket)).toBe('ping-1');
    outcome.socket.write('ping-2');
    expect(await nextData(outcome.socket)).toBe('ping-2');
    outcome.socket.destroy();
  });

  it('404s an unknown token before any upstream dial', async () => {
    const before = upgradeDials;
    const outcome = await upgradeThrough(baseUrl, '/t/never-registered/live');
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.res.statusCode).toBe(404);
    expect(upgradeDials).toBe(before);
  });

  it('forwards an upstream handshake rejection verbatim', async () => {
    const route = proxy.register('env_rej', { host: '127.0.0.1', port: upstreamPort });
    const outcome = await upgradeThrough(baseUrl, `/t/${route.token}/reject`);
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.res.statusCode).toBe(403);
    expect(outcome.res.headers['x-reason']).toBe('nope');
    expect(outcome.body).toBe('nope');
  });

  it('502s (still a parseable response) when the target is unreachable', async () => {
    const route = proxy.register('env_dead_ws', { host: '127.0.0.1', port: 1 });
    const outcome = await upgradeThrough(baseUrl, `/t/${route.token}/live`);
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.res.statusCode).toBe(502);
  });

  it('revokeEnv severs an ESTABLISHED upgraded connection', async () => {
    const route = proxy.register('env_live', { host: '127.0.0.1', port: upstreamPort });
    const outcome = await upgradeThrough(baseUrl, `/t/${route.token}/live`);
    expect(outcome.kind).toBe('upgraded');
    if (outcome.kind !== 'upgraded') return;

    // Prove the splice is live, then revoke: the client socket must close.
    outcome.socket.write('alive?');
    expect(await nextData(outcome.socket)).toBe('alive?');
    const gone = closed(outcome.socket);
    proxy.revokeEnv('env_live');
    await gone;
  });

  it('plain HTTP requests on the same route still stream through', async () => {
    const route = proxy.register('env_mixed', { host: '127.0.0.1', port: upstreamPort });
    const res = await fetch(`${baseUrl}/t/${route.token}/anything`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('plain');
  });
});
