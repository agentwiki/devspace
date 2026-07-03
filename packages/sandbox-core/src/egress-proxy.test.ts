/**
 * The egress proxy is a security boundary, so it is tested with REAL sockets —
 * loopback only, so the suite runs in CI (which has no external egress).
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { ClientRequest, Server as HttpServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import type { Server as TcpServer, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EGRESS_ALLOWLIST,
  EgressProxy,
  hostAllowed,
  parseConnectTarget,
} from './egress-proxy.js';

describe('hostAllowed', () => {
  const list = ['github.com', '*.githubusercontent.com', 'API.openai.com'];

  it.each([
    ['github.com', true],
    ['GITHUB.COM', true],
    ['github.com.', true], // trailing dot normalized
    ['api.github.com', false], // exact entries do not cover subdomains
    ['objects.githubusercontent.com', true], // wildcard subdomain
    ['a.b.githubusercontent.com', true], // nested subdomain
    ['githubusercontent.com', false], // wildcard does NOT match bare suffix
    ['evil-githubusercontent.com', false], // suffix must be a label boundary
    ['api.openai.com', true], // entry case-insensitive too
    ['198.51.100.7', false], // IPs only when listed
    ['', false],
  ])('%s -> %s', (host, expected) => {
    expect(hostAllowed(host, list)).toBe(expected);
  });

  it('ships GitHub, LLM endpoints, and npm in the default sandbox list', () => {
    for (const host of [
      'github.com',
      'api.github.com',
      'codeload.github.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com',
      'api.openai.com',
      'api.anthropic.com',
      'registry.npmjs.org',
    ]) {
      expect(hostAllowed(host, DEFAULT_EGRESS_ALLOWLIST)).toBe(true);
    }
    // The gateway's Slack egress is control-plane policy, never a sandbox default.
    expect(hostAllowed('slack.com', DEFAULT_EGRESS_ALLOWLIST)).toBe(false);
  });
});

describe('parseConnectTarget', () => {
  it('parses host:port and [v6]:port; rejects junk', () => {
    expect(parseConnectTarget('github.com:443')).toEqual({ host: 'github.com', port: 443 });
    expect(parseConnectTarget('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
    expect(parseConnectTarget('no-port')).toBeNull();
    expect(parseConnectTarget('host:99999')).toBeNull();
    expect(parseConnectTarget(undefined)).toBeNull();
  });
});

describe('EgressProxy over loopback sockets', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function startProxy(allowlist: readonly string[]): Promise<{ port: number }> {
    const proxy = new EgressProxy({ allowlist, bindHost: '127.0.0.1' });
    const { port } = await proxy.start();
    cleanups.push(() => proxy.stop());
    return { port };
  }

  /** A TCP upstream that echoes and counts connections. */
  async function startTcpUpstream(): Promise<{ port: number; connections: () => number }> {
    let count = 0;
    const server: TcpServer = createTcpServer((socket) => {
      count += 1;
      socket.pipe(socket);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;
    return { port, connections: () => count };
  }

  async function startHttpUpstream(): Promise<{ port: number }> {
    const server: HttpServer = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`hello ${req.url}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    });
    return { port: (server.address() as { port: number }).port };
  }

  /** Open a CONNECT tunnel through the proxy; resolve the status line. */
  function connectViaProxy(
    proxyPort: number,
    target: string,
  ): Promise<{ socket: Socket; statusLine: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });
      socket.once('data', (chunk: Buffer) => {
        resolve({ socket, statusLine: chunk.toString().split('\r\n')[0]! });
      });
      socket.on('error', reject);
      cleanups.push(() => void socket.destroy());
    });
  }

  it('tunnels CONNECT to an allowed host end-to-end', async () => {
    const upstream = await startTcpUpstream();
    const proxy = await startProxy(['127.0.0.1']);

    const { socket, statusLine } = await connectViaProxy(proxy.port, `127.0.0.1:${upstream.port}`);
    expect(statusLine).toBe('HTTP/1.1 200 Connection Established');

    // Bytes flow both ways through the spliced tunnel (upstream echoes).
    const echoed = new Promise<string>((r) => socket.once('data', (c: Buffer) => r(c.toString())));
    socket.write('ping-through-tunnel');
    expect(await echoed).toBe('ping-through-tunnel');
    expect(upstream.connections()).toBe(1);
  });

  it('refuses CONNECT to a non-allowlisted host and never dials upstream', async () => {
    const upstream = await startTcpUpstream();
    const proxy = await startProxy(['github.com']); // loopback NOT allowed

    const { statusLine } = await connectViaProxy(proxy.port, `127.0.0.1:${upstream.port}`);
    expect(statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect(upstream.connections()).toBe(0);
  });

  it('forwards allowed plain-HTTP absolute-form requests', async () => {
    const upstream = await startHttpUpstream();
    const proxy = await startProxy(['127.0.0.1']);

    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = createHttpRequestViaProxy(proxy.port, `http://127.0.0.1:${upstream.port}/x`);
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
        );
      });
      req.on('error', reject);
      req.end();
    });
    expect(body.status).toBe(200);
    expect(body.text).toBe('hello /x');
  });

  it('rejects plain-HTTP to a denied host with 403', async () => {
    const upstream = await startHttpUpstream();
    const proxy = await startProxy(['github.com']);

    const status = await new Promise<number>((resolve, reject) => {
      const req = createHttpRequestViaProxy(proxy.port, `http://127.0.0.1:${upstream.port}/x`);
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

/** Proxy-style request: connect to the proxy, ask for an absolute-form URL. */
function createHttpRequestViaProxy(proxyPort: number, absoluteUrl: string): ClientRequest {
  const url = new URL(absoluteUrl);
  return httpRequest({
    host: '127.0.0.1',
    port: proxyPort,
    path: absoluteUrl,
    method: 'GET',
    headers: { host: url.host },
  });
}
