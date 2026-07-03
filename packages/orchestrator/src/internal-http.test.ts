/**
 * The two-service split, exercised over REAL loopback HTTP (m6-plan A):
 * `handleInternalApi` / `handleRenderRequest` mounted on real `node:http`
 * servers, driven by the real clients (`httpChatEventEmitter`,
 * `httpOrchestratorReads`) — genuine sockets, zero external egress (the M5
 * egress-proxy test discipline). The render transport's retry/log-and-drop
 * behavior runs against an injected fetch so failure sequences are exact.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, RenderCommand, SessionSummary } from '@devspace/contracts';
import {
  handleInternalApi,
  handleRenderRequest,
  httpChatEventEmitter,
  httpOrchestratorReads,
  httpRenderTransport,
  verifyBearer,
  type InternalApiDeps,
} from './internal-http.js';
import { OrchestratorError } from './index.js';

const TOKEN = 'test-internal-token';

describe('verifyBearer', () => {
  it.each([
    [`Bearer ${TOKEN}`, TOKEN, true],
    [`Bearer wrong`, TOKEN, false],
    [`Bearer ${TOKEN}x`, TOKEN, false], // longer, same prefix
    [`Bearer ${TOKEN.slice(0, -1)}`, TOKEN, false], // shorter
    [TOKEN, TOKEN, false], // missing scheme
    [`bearer ${TOKEN}`, TOKEN, false], // scheme is case-sensitive on purpose
    [undefined, TOKEN, false],
    [`Bearer `, TOKEN, false],
    [`Bearer x`, '', false], // empty configured token can never match
  ])('(%s, %s) -> %s', (header, token, expected) => {
    expect(verifyBearer(header as string | undefined, token as string)).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* Loopback split: real servers, real clients                                  */
/* -------------------------------------------------------------------------- */

const SESSION: SessionSummary = {
  conversationId: 'conv_1',
  platform: 'slack',
  externalChannelId: 'C1:111.222',
  state: 'READY',
  repoUrl: 'https://github.com/o/r',
  updatedAt: new Date(0).toISOString(),
};

function fakeDeps(): InternalApiDeps & {
  seen: ChatEvent[];
} {
  const seen: ChatEvent[] = [];
  return {
    token: TOKEN,
    seen,
    async handleChatEvent(event) {
      seen.push(event);
      if (event.type === 'conversation.created') return { conversationId: 'conv_1' };
      if (event.type === 'message.posted' && event.userId === 'intruder') {
        throw new OrchestratorError('FORBIDDEN', 'not yours');
      }
      return undefined;
    },
    async resolveConversationId(platform, externalChannelId) {
      return platform === 'slack' && externalChannelId === 'C1:111.222' ? 'conv_1' : null;
    },
    async conversationRef(conversationId) {
      return conversationId === 'conv_1' ? 'C1:111.222' : null;
    },
    async listSessions(platform, userId) {
      return platform === 'slack' && userId === 'U1' ? [SESSION] : [];
    },
  };
}

describe('internal API over loopback', () => {
  let server: Server;
  let base: string;
  const deps = fakeDeps();

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleInternalApi(req, res, deps).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects a missing/wrong token with 401 on every route', async () => {
    for (const path of ['/chat-events', '/conversations/resolve', '/sessions']) {
      const res = await fetch(`${base}${path}`, { method: 'POST' });
      expect(res.status).toBe(401);
      const bad = await fetch(`${base}${path}`, {
        headers: { authorization: 'Bearer nope' },
      });
      expect(bad.status).toBe(401);
    }
  });

  it('POST /chat-events runs the handler synchronously and returns its result', async () => {
    const emit = httpChatEventEmitter(base, TOKEN);
    const result = await emit({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C1:111.222',
      userId: 'U1',
    });
    expect(result).toEqual({ conversationId: 'conv_1' });
    expect(deps.seen.at(-1)?.type).toBe('conversation.created');

    // Events without a result body come back as {}.
    const none = await emit({
      type: 'message.posted',
      conversationId: 'conv_1',
      userId: 'U1',
      text: 'hi',
    });
    expect(none).toEqual({});
  });

  it('maps OrchestratorError codes onto HTTP statuses', async () => {
    const res = await fetch(`${base}/chat-events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'message.posted',
        conversationId: 'conv_1',
        userId: 'intruder',
        text: 'gimme',
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
  });

  it('rejects malformed and non-contract bodies with 400', async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const bad = await fetch(`${base}/chat-events`, { method: 'POST', headers, body: '{nope' });
    expect(bad.status).toBe(400);
    const unshaped = await fetch(`${base}/chat-events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'not.a.thing' }),
    });
    expect(unshaped.status).toBe(400);
  });

  it('serves the binding cold-miss reads', async () => {
    const reads = httpOrchestratorReads(base, TOKEN);
    expect(await reads.resolveConversationId('slack', 'C1:111.222')).toBe('conv_1');
    expect(await reads.resolveConversationId('slack', 'C9:000')).toBeNull();
    expect(await reads.conversationRef('conv_1')).toBe('C1:111.222');
    expect(await reads.conversationRef('conv_missing')).toBeNull();
  });

  it('serves the session list and validates the platform', async () => {
    const reads = httpOrchestratorReads(base, TOKEN);
    expect(await reads.listSessions('slack', 'U1')).toEqual([SESSION]);
    expect(await reads.listSessions('slack', 'U2')).toEqual([]);
    const bad = await fetch(`${base}/sessions?platform=irc&userId=U1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('falls through on foreign paths so the svc can serve its own routes', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(404); // our test server 404s unhandled paths
  });
});

/* -------------------------------------------------------------------------- */
/* Gateway render endpoint + orchestrator render transport                     */
/* -------------------------------------------------------------------------- */

describe('render over loopback', () => {
  let server: Server;
  let base: string;
  const rendered: RenderCommand[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleRenderRequest(req, res, {
        token: TOKEN,
        render: async (cmd) => {
          rendered.push(cmd);
        },
      }).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers a command end to end through the real transport', async () => {
    const transport = httpRenderTransport(`${base}/render`, TOKEN, { backoffMs: 0 });
    const cmd: RenderCommand = { type: 'post_message', conversationId: 'conv_1', text: 'hello' };
    await transport(cmd);
    expect(rendered).toEqual([cmd]);
  });

  it('401s without the token and 400s a non-contract body', async () => {
    const unauth = await fetch(`${base}/render`, { method: 'POST', body: '{}' });
    expect(unauth.status).toBe(401);
    const bad = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'no_such_command' }),
    });
    expect(bad.status).toBe(400);
    expect(rendered).toHaveLength(1); // nothing new rendered
  });
});

describe('httpRenderTransport retry policy', () => {
  const CMD: RenderCommand = { type: 'post_message', conversationId: 'conv_1', text: 'x' };
  const ok = { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  const status = (code: number) => ({
    ok: false,
    status: code,
    json: async () => ({}),
    text: async () => '',
  });

  it('retries network errors and 5xx, then succeeds', async () => {
    const warn = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(ok);
    const transport = httpRenderTransport('http://gw/render', TOKEN, {
      fetchImpl,
      warn,
      backoffMs: 0,
    });
    await transport(CMD);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws: exhausted retries log and drop', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    const transport = httpRenderTransport('http://gw/render', TOKEN, {
      fetchImpl,
      warn,
      attempts: 3,
      backoffMs: 0,
    });
    await expect(transport(CMD)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('post_message');
  });

  it('does not retry 4xx (config errors) and still never throws', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(status(401));
    const transport = httpRenderTransport('http://gw/render', TOKEN, {
      fetchImpl,
      warn,
      backoffMs: 0,
    });
    await expect(transport(CMD)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
  });

  it('honors exponential backoff between attempts', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    const transport = httpRenderTransport('http://gw/render', TOKEN, {
      fetchImpl,
      warn: () => {},
      attempts: 3,
      backoffMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await transport(CMD);
    expect(sleeps).toEqual([100, 200]);
  });
});
