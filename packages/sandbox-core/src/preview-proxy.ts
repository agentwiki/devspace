/**
 * The M6 ports preview proxy — authenticated ingress to a port inside a
 * sandboxed env, the counterpart of the M5 egress proxy.
 *
 * The M5 posture makes an env unreachable from anywhere except the host on
 * its own per-env bridge — so preview ingress terminates at the host (m6-plan
 * Decision 5): this proxy listens on the host, and `forwardPort` registers a
 * route from a capability token to `<containerIp>:<port>` resolved at
 * registration time. URLs look like `<base>/t/<token>/<path>`; the token is a
 * 32-byte random value shown only in the owner's session thread, and every
 * route dies with its env (`revokeEnv` on teardown).
 *
 * Like the egress proxy, this is a boundary and stays DUMB: match the token,
 * strip the prefix, stream the request through, stream the response back.
 * No rewriting, no redirect following, no caching, no cookies. Unknown or
 * revoked tokens → 404 before any upstream connection is dialed. WebSocket
 * upgrade is out of scope for M6 (documented limitation).
 */
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PreviewTarget {
  host: string;
  port: number;
}

export interface PreviewRoute {
  token: string;
  proxyUrl: string;
}

/** The narrow surface DevcontainerSandboxCore needs (fake-able in tests). */
export interface PreviewRegistrar {
  register(envId: string, target: PreviewTarget): PreviewRoute;
  revokeEnv(envId: string): void;
}

/**
 * Split `/t/<token>/rest?query` into its token and upstream path. Null when
 * the path is not a preview path (no token, wrong prefix).
 */
export function parsePreviewPath(url: string): { token: string; rest: string } | null {
  const m = /^\/t\/([A-Za-z0-9_-]+)(\/[^?#]*)?([?#].*)?$/.exec(url);
  if (!m) return null;
  return { token: m[1]!, rest: `${m[2] ?? '/'}${m[3] ?? ''}` };
}

export interface PreviewProxyOptions {
  /** Bind address. Default 127.0.0.1 — expose deliberately, not by accident. */
  bindHost?: string;
  /** Listen port. Default 0 (ephemeral; read it from `start()`'s result). */
  port?: number;
  /**
   * Public base for composed URLs (scheme://host[:port], no trailing slash) —
   * what users can actually reach, e.g. behind TLS or a hostname. Defaults to
   * `http://<bindHost>:<port>` once started.
   */
  publicBaseUrl?: string;
  /** Token source, injected in tests. Default: 32 random bytes, hex. */
  generateToken?: () => string;
}

/**
 * Read the preview proxy's boot config from service env. Undefined (feature
 * off) without PREVIEW_PROXY_PORT. Opting in via env means serving users, so
 * the env-driven default binds 0.0.0.0 (the class default stays loopback).
 */
export function previewProxyFromEnv(
  env: Record<string, string | undefined>,
): PreviewProxyOptions | undefined {
  if (!env.PREVIEW_PROXY_PORT) return undefined;
  const port = Number(env.PREVIEW_PROXY_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid PREVIEW_PROXY_PORT: ${env.PREVIEW_PROXY_PORT}`);
  }
  return {
    port,
    bindHost: env.PREVIEW_BIND_HOST || '0.0.0.0',
    publicBaseUrl: env.PREVIEW_BASE_URL || undefined,
  };
}

export class PreviewProxy implements PreviewRegistrar {
  private readonly routes = new Map<string, { envId: string; target: PreviewTarget }>();
  private readonly tokensByEnv = new Map<string, Set<string>>();
  private readonly generateToken: () => string;
  private server?: Server;
  private baseUrl?: string;

  constructor(private readonly options: PreviewProxyOptions = {}) {
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString('hex'));
    this.baseUrl = options.publicBaseUrl?.replace(/\/+$/, '');
  }

  /** Register a route. The proxy must be started (or have a publicBaseUrl). */
  register(envId: string, target: PreviewTarget): PreviewRoute {
    if (!this.baseUrl) throw new Error('PreviewProxy not started and no publicBaseUrl configured');
    const token = this.generateToken();
    this.routes.set(token, { envId, target });
    let tokens = this.tokensByEnv.get(envId);
    if (!tokens) {
      tokens = new Set();
      this.tokensByEnv.set(envId, tokens);
    }
    tokens.add(token);
    return { token, proxyUrl: `${this.baseUrl}/t/${token}/` };
  }

  /** Drop every route for an env — no preview URL survives its env. */
  revokeEnv(envId: string): void {
    const tokens = this.tokensByEnv.get(envId);
    if (!tokens) return;
    for (const token of tokens) this.routes.delete(token);
    this.tokensByEnv.delete(envId);
  }

  async start(): Promise<{ port: number; baseUrl: string }> {
    if (this.server) throw new Error('PreviewProxy already started');
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    const bindHost = this.options.bindHost ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, bindHost, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    this.baseUrl ??= `http://${bindHost}:${port}`;
    return { port, baseUrl: this.baseUrl };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const parsed = parsePreviewPath(req.url ?? '');
    const route = parsed ? this.routes.get(parsed.token) : undefined;
    if (!parsed || !route) {
      // Unknown token: no upstream dial, no detail leak.
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    // Stream through untouched apart from Host (the upstream's own) and
    // hop-by-hop connection handling, which node manages per-request.
    const headers = { ...req.headers, host: `${route.target.host}:${route.target.port}` };
    const upstream = httpRequest(
      {
        host: route.target.host,
        port: route.target.port,
        method: req.method,
        path: parsed.rest,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('upstream unreachable');
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
    req.on('error', () => upstream.destroy());
  }
}
