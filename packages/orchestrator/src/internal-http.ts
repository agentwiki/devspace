/**
 * The internal HTTP API between chat-gateway-svc and orchestrator-svc — the
 * two-service split (m6-plan workstream A). It cuts at exactly the seams M4
 * predicted and nothing else:
 *
 *   gateway -> orchestrator   POST /chat-events           (handleChatEvent)
 *   orchestrator -> gateway   POST /render                (render)
 *   gateway -> orchestrator   GET  /conversations/resolve (binding cold miss, in)
 *   gateway -> orchestrator   GET  /conversations/:id     (binding cold miss, out)
 *   gateway -> orchestrator   GET  /sessions              (App Home list, M6-D)
 *
 * Every call carries `Authorization: Bearer <DEVSPACE_INTERNAL_TOKEN>`,
 * verified timing-safely on both servers (m6-plan Decision 3). Transport
 * changes, semantics don't (Decision 1): /chat-events is synchronous and
 * returns the same `ChatEventResult` the in-process seam returns, and the
 * render client retries then logs-and-drops so the "render path never throws"
 * discipline survives the wire (Decision 2).
 *
 * Both svc entrypoints import from here; the handlers take narrow, fake-able
 * deps so the whole split is tested over loopback HTTP servers in CI.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ChatEvent,
  ChatEventResult,
  ChatPlatform,
  RenderCommand,
  SessionSummary,
} from '@devspace/contracts';
import {
  ChatEventResultSchema,
  ChatEventSchema,
  ChatPlatformSchema,
  RenderCommandSchema,
  SessionSummarySchema,
} from '@devspace/contracts';
import { OrchestratorError } from './index.js';

/* -------------------------------------------------------------------------- */
/* Auth + body plumbing                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Verify an `Authorization: Bearer <token>` header against the shared internal
 * token. Constant-time over the token bytes; a length mismatch is decided on
 * hashes of nothing — we simply compare padded buffers so length itself does
 * not early-exit.
 */
export function verifyBearer(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return false;
  const presented = Buffer.from(m[1]!, 'utf8');
  const expected = Buffer.from(token, 'utf8');
  const len = Math.max(presented.length, expected.length);
  const a = Buffer.alloc(len);
  const b = Buffer.alloc(len);
  presented.copy(a);
  expected.copy(b);
  // timingSafeEqual over equal-length padded copies; require true length match.
  return timingSafeEqual(a, b) && presented.length === expected.length;
}

const MAX_BODY_BYTES = 1024 * 1024; // internal API; nothing legitimate is bigger

/** Read + JSON-parse a request body with a hard size cap. */
export function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errStatus(err: unknown): number {
  if (err instanceof OrchestratorError) {
    return err.code === 'FORBIDDEN' ? 403 : err.code === 'NOT_FOUND' ? 404 : 400;
  }
  return 500;
}

/* -------------------------------------------------------------------------- */
/* Orchestrator-side handler                                                   */
/* -------------------------------------------------------------------------- */

/** The narrow orchestrator surface the internal API exposes (fake-able). */
export interface InternalApiDeps {
  token: string;
  handleChatEvent(event: ChatEvent): Promise<ChatEventResult | void>;
  resolveConversationId(platform: string, externalChannelId: string): Promise<string | null>;
  /** The conversation's platform thread ref, for the outbound cold miss. */
  conversationRef(conversationId: string): Promise<string | null>;
  listSessions(platform: ChatPlatform, userId: string): Promise<SessionSummary[]>;
}

const PlatformQuerySchema = ChatPlatformSchema;

/**
 * Handle one request against the internal API. Returns false when the path is
 * not ours so the svc can fall through to its other routes (/health, webhooks).
 */
export async function handleInternalApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InternalApiDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://internal');
  const path = url.pathname;
  const isOurs =
    path === '/chat-events' ||
    path === '/sessions' ||
    path === '/conversations/resolve' ||
    /^\/conversations\/[^/]+$/.test(path);
  if (!isOurs) return false;

  if (!verifyBearer(req.headers.authorization, deps.token)) {
    json(res, 401, { code: 'UNAUTHORIZED', message: 'bad or missing bearer token' });
    return true;
  }

  try {
    if (req.method === 'POST' && path === '/chat-events') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        json(res, 400, { code: 'BAD_REQUEST', message: String(err) });
        return true;
      }
      const parsed = ChatEventSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { code: 'BAD_REQUEST', message: parsed.error.message });
        return true;
      }
      // Synchronous by design (m6-plan Decision 1): the response carries the
      // same ChatEventResult the in-process seam returns.
      const result = await deps.handleChatEvent(parsed.data);
      json(res, 200, ChatEventResultSchema.parse(result ?? {}));
      return true;
    }

    if (req.method === 'GET' && path === '/conversations/resolve') {
      const platform = url.searchParams.get('platform') ?? '';
      const externalChannelId = url.searchParams.get('externalChannelId') ?? '';
      if (!platform || !externalChannelId) {
        json(res, 400, { code: 'BAD_REQUEST', message: 'platform and externalChannelId required' });
        return true;
      }
      const conversationId = await deps.resolveConversationId(platform, externalChannelId);
      json(res, 200, { conversationId });
      return true;
    }

    if (req.method === 'GET' && /^\/conversations\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.slice('/conversations/'.length));
      const externalChannelId = await deps.conversationRef(id);
      if (externalChannelId === null) {
        json(res, 404, { code: 'NOT_FOUND', message: `conversation ${id}` });
        return true;
      }
      json(res, 200, { externalChannelId });
      return true;
    }

    if (req.method === 'GET' && path === '/sessions') {
      const platform = PlatformQuerySchema.safeParse(url.searchParams.get('platform'));
      const userId = url.searchParams.get('userId') ?? '';
      if (!platform.success || !userId) {
        json(res, 400, { code: 'BAD_REQUEST', message: 'platform and userId required' });
        return true;
      }
      const sessions = await deps.listSessions(platform.data, userId);
      json(res, 200, { sessions });
      return true;
    }

    json(res, 405, { code: 'BAD_REQUEST', message: `unsupported method ${req.method}` });
    return true;
  } catch (err) {
    json(res, errStatus(err), {
      code: err instanceof OrchestratorError ? err.code : 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Gateway-side render endpoint                                                */
/* -------------------------------------------------------------------------- */

/**
 * Handle `POST /render` on the gateway: auth, zod-parse, hand to the adapter.
 * The adapter's render never throws (M4); a throw here is a programming error
 * and surfaces as 500 so the orchestrator's retry/log path sees it.
 */
export async function handleRenderRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { token: string; render: (command: RenderCommand) => Promise<unknown> },
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://internal');
  if (url.pathname !== '/render') return false;
  if (!verifyBearer(req.headers.authorization, deps.token)) {
    json(res, 401, { code: 'UNAUTHORIZED', message: 'bad or missing bearer token' });
    return true;
  }
  if (req.method !== 'POST') {
    json(res, 405, { code: 'BAD_REQUEST', message: `unsupported method ${req.method}` });
    return true;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    json(res, 400, { code: 'BAD_REQUEST', message: String(err) });
    return true;
  }
  const parsed = RenderCommandSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { code: 'BAD_REQUEST', message: parsed.error.message });
    return true;
  }
  try {
    await deps.render(parsed.data);
    json(res, 200, {});
  } catch (err) {
    json(res, 500, { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Clients                                                                     */
/* -------------------------------------------------------------------------- */

type FetchLike = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface InternalClientOptions {
  /** Injected in tests. Defaults to global fetch (Node 22+). */
  fetchImpl?: FetchLike;
  warn?: (message: string) => void;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

const trimSlash = (base: string): string => base.replace(/\/+$/, '');

/**
 * Gateway -> orchestrator chat-event emitter. Single attempt, no timeout
 * (provisioning can take minutes; a retry would replay a non-idempotent
 * conversation.created). Throws on any failure — the adapters' emitSafe
 * already logs-and-drops.
 */
export function httpChatEventEmitter(
  orchestratorUrl: string,
  token: string,
  opts: InternalClientOptions = {},
): (event: ChatEvent) => Promise<ChatEventResult> {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const base = trimSlash(orchestratorUrl);
  return async (event) => {
    const res = await doFetch(`${base}/chat-events`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`POST /chat-events -> ${res.status}: ${await res.text()}`);
    return ChatEventResultSchema.parse(await res.json());
  };
}

/** Gateway -> orchestrator binding + App Home reads. Null on 404, throw on other failures. */
export function httpOrchestratorReads(
  orchestratorUrl: string,
  token: string,
  opts: InternalClientOptions = {},
): {
  resolveConversationId(platform: string, externalChannelId: string): Promise<string | null>;
  conversationRef(conversationId: string): Promise<string | null>;
  listSessions(platform: ChatPlatform, userId: string): Promise<SessionSummary[]>;
} {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const base = trimSlash(orchestratorUrl);
  const headers = { authorization: `Bearer ${token}` };
  return {
    async resolveConversationId(platform, externalChannelId) {
      const qs = new URLSearchParams({ platform, externalChannelId });
      const res = await doFetch(`${base}/conversations/resolve?${qs}`, { headers });
      if (!res.ok) throw new Error(`GET /conversations/resolve -> ${res.status}`);
      const body = (await res.json()) as { conversationId: string | null };
      return body.conversationId;
    },
    async conversationRef(conversationId) {
      const res = await doFetch(`${base}/conversations/${encodeURIComponent(conversationId)}`, {
        headers,
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET /conversations/${conversationId} -> ${res.status}`);
      const body = (await res.json()) as { externalChannelId: string };
      return body.externalChannelId;
    },
    async listSessions(platform, userId) {
      const qs = new URLSearchParams({ platform, userId });
      const res = await doFetch(`${base}/sessions?${qs}`, { headers });
      if (!res.ok) throw new Error(`GET /sessions -> ${res.status}`);
      const body = (await res.json()) as { sessions: unknown[] };
      return body.sessions.map((s) => SessionSummarySchema.parse(s));
    },
  };
}

export interface RenderTransportOptions extends InternalClientOptions {
  /** Total attempts per command (default 3). */
  attempts?: number;
  /** Base backoff, doubled per retry (default 250ms; 0 in tests). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Orchestrator -> gateway render transport. Retries transient failures
 * (network errors and 5xx) with backoff, then logs-and-drops: the render path
 * never throws (m6-plan Decision 2) — a dead gateway must not fail a turn.
 * 4xx responses are config/programming errors and are not retried.
 */
export function httpRenderTransport(
  gatewayRenderUrl: string,
  token: string,
  opts: RenderTransportOptions = {},
): (command: RenderCommand) => Promise<void> {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const warn = opts.warn ?? ((m) => console.warn(`[render-http] ${m}`));
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? 250;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  return async (command) => {
    let lastFailure = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const res = await doFetch(gatewayRenderUrl, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify(command),
        });
        if (res.ok) return;
        lastFailure = `HTTP ${res.status}`;
        if (res.status < 500) break; // 4xx: retrying cannot help
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err);
      }
      if (attempt < attempts && backoffMs > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    }
    warn(`dropping render ${command.type} for ${command.conversationId}: ${lastFailure}`);
  };
}
