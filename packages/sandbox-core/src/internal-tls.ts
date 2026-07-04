/**
 * Per-service identity on the internal API (M13, m13-plan workstream A): the
 * shared pieces of the mutual-TLS regime that replaces the
 * DEVSPACE_INTERNAL_TOKEN bearer (m13-plan Decision 1 — one auth regime per
 * deployment, never both).
 *
 * Identity is the certificate subject CN = the service name (`orchestrator`,
 * `chat-gateway`, `sandbox-core`), issued by a private internal CA that is the
 * sole trust root on both sides — system roots are never consulted. Servers
 * require a CA-signed client certificate at the handshake and authorize the
 * peer's NAME per surface; clients present their own identity and verify the
 * server's SERVICE name instead of its hostname (m13-plan Decision 3 —
 * addresses are deployment detail; the threat inside a single-purpose CA is
 * cross-service impersonation).
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { PeerCertificate, TLSSocket } from 'node:tls';

/** A service's internal TLS identity: PEM contents, not paths. */
export interface InternalTlsIdentity {
  /** This service's certificate (subject CN = its service name). */
  cert: string;
  /** The matching private key. */
  key: string;
  /** The internal CA — the only trust root, for peers in both directions. */
  ca: string;
}

/** Client-side identity plus the service name the server must present. */
export interface InternalTlsClient extends InternalTlsIdentity {
  expectService: string;
}

/**
 * Load the internal TLS identity from DEVSPACE_TLS_CERT / DEVSPACE_TLS_KEY /
 * DEVSPACE_TLS_CA (PEM file paths). All-or-nothing: a partial set is a
 * misconfigured deployment and refuses loudly rather than silently running
 * token-mode. Returns undefined when none are set.
 */
export function internalTlsFromEnv(env: Record<string, string | undefined>):
  | {
      cert: string;
      key: string;
      ca: string;
    }
  | undefined {
  const certPath = env.DEVSPACE_TLS_CERT;
  const keyPath = env.DEVSPACE_TLS_KEY;
  const caPath = env.DEVSPACE_TLS_CA;
  if (!certPath && !keyPath && !caPath) return undefined;
  if (!certPath || !keyPath || !caPath) {
    throw new Error('DEVSPACE_TLS_CERT, DEVSPACE_TLS_KEY and DEVSPACE_TLS_CA must be set together');
  }
  return {
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
    ca: readFileSync(caPath, 'utf8'),
  };
}

/**
 * Options for `https.createServer`: present this identity, REQUIRE a client
 * certificate, and verify it against the internal CA only. A peer without a
 * CA-signed certificate never completes the handshake — authorization by
 * service name (`peerAllowed`) then runs per request.
 */
export function serverTlsOptions(identity: InternalTlsIdentity): {
  cert: string;
  key: string;
  ca: string;
  requestCert: true;
  rejectUnauthorized: true;
  minVersion: 'TLSv1.2';
} {
  return {
    cert: identity.cert,
    key: identity.key,
    ca: identity.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
}

/**
 * The authenticated peer's service name, or undefined when there is none.
 * Fail-closed by construction: a plain socket has no peer certificate, an
 * unauthorized TLS peer is ignored — so a TLS-mode handler accidentally
 * mounted on a cleartext server refuses everything (m13-plan Decision 6).
 */
export function peerServiceName(req: IncomingMessage): string | undefined {
  const socket = req.socket as Partial<TLSSocket>;
  if (socket.authorized !== true || typeof socket.getPeerCertificate !== 'function') {
    return undefined;
  }
  const cert = socket.getPeerCertificate();
  const cn: unknown = cert?.subject?.CN;
  return typeof cn === 'string' && cn.length > 0 ? cn : undefined;
}

/** Is the request's authenticated peer one of the services this surface serves? */
export function peerAllowed(req: IncomingMessage, allow: readonly string[]): boolean {
  const name = peerServiceName(req);
  return name !== undefined && allow.includes(name);
}

/**
 * Options for `https.request` / `tls.connect`: present this identity, pin the
 * internal CA, and verify the server presents the SERVICE we meant to dial —
 * subject CN equals `expectService` — in place of hostname verification
 * (m13-plan Decision 3). Chain validation against `ca` is unchanged.
 */
export function clientTlsOptions(client: InternalTlsClient): {
  cert: string;
  key: string;
  ca: string;
  checkServerIdentity: (host: string, cert: PeerCertificate) => Error | undefined;
} {
  return {
    cert: client.cert,
    key: client.key,
    ca: client.ca,
    checkServerIdentity: (_host, cert) => {
      const cn: unknown = cert?.subject?.CN;
      return cn === client.expectService
        ? undefined
        : new Error(
            `server presented service identity "${String(cn ?? 'none')}", expected "${client.expectService}"`,
          );
    },
  };
}

/** The response slice the internal split clients consume (fetch-shaped). */
export interface TlsFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * A fetch-shaped client over `https.request` with the internal identity —
 * global fetch cannot present a client certificate (m13-plan Decision 8).
 * Like the M8 remote client, no client-side timeout: nothing internal is
 * public, and severing a slow call would orphan real work.
 */
export function tlsFetch(
  client: InternalTlsClient,
): (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<TlsFetchResponse> {
  const tls = clientTlsOptions(client);
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        reject(new Error(`internal TLS client requires an https:// url, got ${url}`));
        return;
      }
      const options: RequestOptions = {
        method: init.method ?? 'GET',
        headers: init.headers,
        ...tls,
      };
      const req = httpsRequest(parsed, options);
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(text) as unknown,
            text: async () => text,
          });
        });
      });
      req.on('error', reject);
      req.end(init.body);
    });
}
