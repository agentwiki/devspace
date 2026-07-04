/**
 * The two-service split over mutual TLS (M13, m13-plan workstream B): the M6
 * loopback discipline re-run with real handshakes. Both directions — chat
 * events up, renders down — ride `https.Server`s that require CA-signed client
 * certificates and authorize the peer's service name; the real clients present
 * per-run openssl-minted identities (self-skipping without openssl).
 */
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RenderCommand } from '@devspace/contracts';
import {
  mintInternalTls,
  opensslAvailable,
  serverTlsOptions,
  type InternalTlsIdentity,
} from '@devspace/sandbox-core';
import {
  handleInternalApi,
  handleRenderRequest,
  httpChatEventEmitter,
  httpOrchestratorReads,
  httpRenderTransport,
  type InternalApiDeps,
} from './internal-http.js';

const hasOpenssl = await opensslAvailable();

describe.runIf(hasOpenssl)('the split API over mutual TLS', () => {
  let orchestrator: InternalTlsIdentity;
  let gateway: InternalTlsIdentity;
  let rogue: InternalTlsIdentity; // a CA-signed cert for the WRONG service
  let cleanup: () => Promise<void>;
  const servers: HttpsServer[] = [];

  beforeAll(async () => {
    const minted = await mintInternalTls(['orchestrator', 'chat-gateway', 'sandbox-core']);
    orchestrator = minted.identities['orchestrator']!;
    gateway = minted.identities['chat-gateway']!;
    rogue = minted.identities['sandbox-core']!;
    cleanup = minted.cleanup;
  });
  afterAll(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    await cleanup();
  });

  async function listen(
    identity: InternalTlsIdentity,
    handler: Parameters<typeof createHttpsServer>[1],
  ): Promise<string> {
    const server = createHttpsServer(serverTlsOptions(identity), handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('carries chat events and the reads with the gateway identity, and 403s a wrong-service peer', async () => {
    const deps: InternalApiDeps = {
      auth: { tlsAllow: ['chat-gateway'] },
      async handleChatEvent() {
        return { conversationId: 'conv_1' };
      },
      async resolveConversationId() {
        return 'conv_1';
      },
      async conversationRef() {
        return 'C1:111.222';
      },
      async listSessions() {
        return [];
      },
    };
    const base = await listen(orchestrator, (req, res) => {
      void handleInternalApi(req, res, deps);
    });

    const emit = httpChatEventEmitter(base, {
      tls: { ...gateway, expectService: 'orchestrator' },
    });
    expect(
      await emit({
        type: 'conversation.created',
        platform: 'slack',
        externalChannelId: 'C1:111.222',
        userId: 'U1',
      }),
    ).toEqual({ conversationId: 'conv_1' });

    const reads = httpOrchestratorReads(base, {
      tls: { ...gateway, expectService: 'orchestrator' },
    });
    expect(await reads.conversationRef('conv_1')).toBe('C1:111.222');

    // A CA-signed sandbox-core certificate authenticates but is not the
    // gateway: the surface refuses it — the replay the shared token allowed.
    const impostor = httpChatEventEmitter(base, {
      tls: { ...rogue, expectService: 'orchestrator' },
    });
    await expect(
      impostor({
        type: 'conversation.created',
        platform: 'slack',
        externalChannelId: 'C1:111.222',
        userId: 'U1',
      }),
    ).rejects.toThrow(/403/);
  });

  it('delivers renders with the orchestrator identity and drops a wrong-service peer', async () => {
    const rendered: RenderCommand[] = [];
    const base = await listen(gateway, (req, res) => {
      void handleRenderRequest(req, res, {
        auth: { tlsAllow: ['orchestrator'] },
        render: async (cmd) => {
          rendered.push(cmd);
        },
      });
    });
    const cmd: RenderCommand = { type: 'post_message', conversationId: 'conv_1', text: 'hi' };

    const transport = httpRenderTransport(
      `${base}/render`,
      { tls: { ...orchestrator, expectService: 'chat-gateway' } },
      { backoffMs: 0 },
    );
    await transport(cmd);
    expect(rendered).toEqual([cmd]);

    // The render path never throws (M6): a refused peer logs-and-drops.
    const warn = vi.fn();
    const impostor = httpRenderTransport(
      `${base}/render`,
      { tls: { ...rogue, expectService: 'chat-gateway' } },
      { backoffMs: 0, warn },
    );
    await expect(impostor(cmd)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('403'));
    expect(rendered).toHaveLength(1);
  });

  it('rejects a server presenting the wrong service identity before sending anything', async () => {
    // The dialer meant to reach the orchestrator; a valid CA-signed
    // chat-gateway certificate must not do.
    const base = await listen(gateway, (req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const reads = httpOrchestratorReads(base, {
      tls: { ...gateway, expectService: 'orchestrator' },
    });
    await expect(reads.conversationRef('conv_1')).rejects.toThrow(/expected "orchestrator"/);
  });
});

describe('TLS-mode client construction', () => {
  const identity = { cert: 'c', key: 'k', ca: 'ca', expectService: 'orchestrator' };

  it('refuses a cleartext url — the identity cannot ride plain HTTP', () => {
    expect(() => httpChatEventEmitter('http://orch:4000', { tls: identity })).toThrow(/https/);
    expect(() => httpRenderTransport('http://gw:4002/render', { tls: identity })).toThrow(/https/);
  });
});
