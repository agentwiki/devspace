/**
 * The M5 egress allowlist proxy — the only door out of a sandboxed env.
 *
 * Each hardened env sits on an `--internal` docker network with NO route to
 * the outside; the only reachable off-subnet address is the host at the
 * network's bridge gateway, where this proxy listens. In-env processes get
 * HTTP(S)_PROXY pointed here (provision-time containerEnv); anything that
 * ignores the proxy simply has no route — enforcement never depends on
 * processes being proxy-polite.
 *
 * Because it is a security boundary the proxy stays DUMB (m5-plan): decide
 * allow/refuse by hostname, then splice sockets. CONNECT is a blind TLS
 * passthrough (no MITM, no header rewriting); plain HTTP is forwarded
 * absolute-form with headers passed through untouched. No caching, no
 * rewriting, no auth — complexity here is attack surface.
 *
 * It is deliberately our own ~150 lines over node:http/node:net: zero new
 * runtime dependencies, and — unlike a squid/tinyproxy config — the whole
 * boundary is unit-tested over loopback sockets in CI (which has no external
 * egress anyway).
 */
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';

/**
 * Default sandbox egress: GitHub (clone/REST/raw+release downloads), the LLM
 * endpoints, and the npm registry. Deployments extend this per stack (pypi,
 * crates.io, …). NOTE the chat GATEWAY host additionally needs slack.com +
 * wss-primary.slack.com (Socket Mode) — that is control-plane egress, not
 * sandbox egress, and must not be defaulted into tenant envs.
 */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  '*.githubusercontent.com',
  'api.openai.com',
  'api.anthropic.com',
  'registry.npmjs.org',
];

/**
 * Hostname allowlist check. Entries are exact hostnames or `*.suffix`
 * wildcards (matching any subdomain, NOT the bare suffix). Matching is
 * case-insensitive and ignores a trailing dot; IP literals match only when
 * listed explicitly.
 */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // '.githubusercontent.com'
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Coverage check for a REQUESTED allowlist entry against the operator's
 * allowlist (M22, m22-plan Decision 2): a per-env `custom` policy may only
 * NARROW the host ceiling. An exact-host entry is covered iff the operator
 * list would allow that host; a `*.suffix` entry is covered only by an
 * equal-or-broader operator wildcard (an exact operator host never covers a
 * wildcard request — the wildcard matches strictly more).
 */
export function coveredByAllowlist(entry: string, allowlist: readonly string[]): boolean {
  const e = entry.trim().toLowerCase().replace(/\.$/, '');
  if (!e) return false;
  if (!e.startsWith('*.')) return hostAllowed(e, allowlist);
  const wanted = e.slice(1); // '.suffix'
  for (const raw of allowlist) {
    const op = raw.trim().toLowerCase();
    if (!op.startsWith('*.')) continue;
    const given = op.slice(1);
    if (wanted === given || wanted.endsWith(given)) return true;
  }
  return false;
}

/**
 * Per-env scope registration (M22): the provisioner/core scope a network
 * gateway to an env's own (narrowed) allowlist; connections arriving on an
 * unscoped address keep the default allowlist. `allowlist` exposes the
 * operator ceiling `custom` requests are validated against.
 */
export interface EgressScopeRegistrar {
  readonly allowlist: readonly string[];
  setScope(clientAddr: string, allowlist: readonly string[]): void;
  clearScope(clientAddr: string): void;
}

/** Node reports IPv4 peers as `::ffff:a.b.c.d` on dual-stack binds. */
function normalizeAddr(addr: string): string {
  return addr.toLowerCase().replace(/^::ffff:/, '');
}

/** Parse a CONNECT target (`host:port`, incl. `[v6]:port`). Null when malformed. */
export function parseConnectTarget(url: string | undefined): { host: string; port: number } | null {
  if (!url) return null;
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(url) ?? /^([^:]+):(\d+)$/.exec(url);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: m[1]!, port };
}

export interface EgressProxyOptions {
  allowlist: readonly string[];
  /** Bind address. Default 0.0.0.0 (containers reach it at their gateway). */
  bindHost?: string;
  /** Listen port. Default 0 (ephemeral; read it from `start()`'s result). */
  port?: number;
  /** Decision log (allow/deny lines only — never request bodies). */
  onLog?: (line: string) => void;
}

export class EgressProxy implements EgressScopeRegistrar {
  readonly allowlist: readonly string[];
  private readonly bindHost: string;
  private readonly requestedPort: number;
  private readonly onLog: (line: string) => void;
  private server?: Server;
  /**
   * Per-env scopes (M22), keyed by the LOCAL address a connection arrived
   * on: an `--internal` network reaches the host only at its own bridge
   * gateway, so the dialed address identifies the env's network — nothing
   * the workload can forge. Unscoped addresses keep the default allowlist.
   */
  private readonly scopes = new Map<string, readonly string[]>();

  constructor(options: EgressProxyOptions) {
    this.allowlist = options.allowlist;
    this.bindHost = options.bindHost ?? '0.0.0.0';
    this.requestedPort = options.port ?? 0;
    this.onLog = options.onLog ?? (() => {});
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('egress proxy already started');
    const server = createServer((req, res) => this.forwardHttp(req, res));
    server.on('connect', (req, socket, head) => this.tunnelConnect(req, socket as Socket, head));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.requestedPort, this.bindHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no bound address');
    return { host: this.bindHost, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  setScope(clientAddr: string, allowlist: readonly string[]): void {
    this.scopes.set(normalizeAddr(clientAddr), [...allowlist]);
  }

  clearScope(clientAddr: string): void {
    this.scopes.delete(normalizeAddr(clientAddr));
  }

  /** The allowlist governing one accepted connection (scope, else default). */
  private allowlistFor(socket: Pick<Socket, 'localAddress'>): readonly string[] {
    const addr = socket.localAddress;
    if (addr !== undefined) {
      const scoped = this.scopes.get(normalizeAddr(addr));
      if (scoped !== undefined) return scoped;
    }
    return this.allowlist;
  }

  /** HTTPS (and any raw TCP-over-CONNECT): allow, then blind splice. */
  private tunnelConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    clientSocket.on('error', () => {});
    const target = parseConnectTarget(req.url);
    if (!target || !hostAllowed(target.host, this.allowlistFor(clientSocket))) {
      this.onLog(`deny CONNECT ${req.url ?? '<none>'}`);
      clientSocket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const upstream = netConnect(target.port, target.host, () => {
      this.onLog(`allow CONNECT ${target.host}:${target.port}`);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  }

  /** Plain HTTP absolute-form forward (proxy-style `GET http://host/…`). */
  private forwardHttp(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('proxy requires absolute-form URLs');
      return;
    }
    if (url.protocol !== 'http:' || !hostAllowed(url.hostname, this.allowlistFor(req.socket))) {
      this.onLog(`deny ${req.method ?? 'GET'} ${url.hostname}`);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('egress denied by allowlist');
      return;
    }
    this.onLog(`allow ${req.method ?? 'GET'} ${url.hostname}`);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const upstream = httpRequest(
      {
        host: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream unreachable');
    });
    req.pipe(upstream);
  }
}
