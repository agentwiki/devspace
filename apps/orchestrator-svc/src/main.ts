/**
 * Deployable entrypoint for the orchestrator control plane (M3 wiring, M4
 * boot extraction, M6 split). The assembly itself lives in
 * @devspace/orchestrator's `bootOrchestrator`; this entrypoint owns the Pool,
 * the HTTP surface, and the reconciler schedule.
 *
 * M6 (m6-plan A): the internal API for the two-service split — authed
 * `POST /chat-events` (synchronous, replaces the M3 fire-and-forget `/events`),
 * the binding cold-miss resolver reads, and `GET /sessions`. Render commands go
 * to the gateway's `POST /render` when GATEWAY_RENDER_URL is set (retry, then
 * log-and-drop — never fail a turn on a dead gateway); to logs otherwise.
 *
 * M13: with the DEVSPACE_TLS_* identity set instead of the shared token
 * (never both), the split API moves to a mutual-TLS listener on
 * DEVSPACE_TLS_PORT (default PORT+1) serving the chat gateway only; the plain
 * port keeps /health and the GitHub webhook ingress, whose caller cannot
 * present a client certificate and authenticates by HMAC signature (M5).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { Pool } from 'pg';
import type { EventBus, Repositories } from '@devspace/db';
import {
  internalTlsFromEnv,
  serverTlsOptions,
  type InternalTlsIdentity,
} from '@devspace/sandbox-core';
import {
  bootOrchestrator,
  handleInternalApi,
  httpRenderTransport,
  processWebhookDelivery,
  reapPolicyFromEnv,
  type InternalServerAuth,
  type Orchestrator,
  type ReapPolicy,
} from '@devspace/orchestrator';

const SERVICE = 'orchestrator';

interface Config {
  port: number;
  databaseUrl: string;
  envelopeKey: string;
  retiredKeys: string[];
  githubApiBase: string;
  reconcileIntervalMs: number;
  /** Lifecycle reclamation (M17); the reaper is off when unset. */
  reapPolicy?: ReapPolicy;
  /** Webhook ingress is disabled (with a boot log) when unset. */
  webhookSecret?: string;
  /** Shared bearer token; mutually exclusive with internalTls (M13). */
  internalToken?: string;
  /** Internal TLS identity (M13); the split API then serves on tlsPort. */
  internalTls?: InternalTlsIdentity;
  tlsPort: number;
  /** Gateway render endpoint (split mode); render logs when unset. */
  gatewayRenderUrl?: string;
}

function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const envelopeKey = process.env.SECRET_ENVELOPE_KEY;
  if (!envelopeKey) throw new Error('SECRET_ENVELOPE_KEY is required');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || undefined;
  const internalToken = process.env.DEVSPACE_INTERNAL_TOKEN || undefined;
  const internalTls = internalTlsFromEnv(process.env);
  const gatewayRenderUrl = process.env.GATEWAY_RENDER_URL || undefined;
  const port = Number(process.env.ORCHESTRATOR_PORT ?? process.env.PORT ?? 4000);
  // One auth regime per deployment (m13-plan Decision 1).
  if (internalToken && internalTls) {
    throw new Error(
      'DEVSPACE_INTERNAL_TOKEN and DEVSPACE_TLS_* are mutually exclusive — one auth regime per deployment',
    );
  }
  // An unauthenticated control plane is worse than no split (m6-plan
  // Decision 3): render-to-gateway without internal auth is refused.
  if (gatewayRenderUrl && !internalToken && !internalTls) {
    throw new Error(
      'GATEWAY_RENDER_URL requires DEVSPACE_INTERNAL_TOKEN or the DEVSPACE_TLS_* identity',
    );
  }
  return {
    port,
    tlsPort: Number(process.env.DEVSPACE_TLS_PORT ?? port + 1),
    databaseUrl,
    envelopeKey,
    retiredKeys: (process.env.SECRET_ENVELOPE_KEYS_RETIRED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    githubApiBase: process.env.GITHUB_API_BASE ?? 'https://api.github.com',
    // With webhooks configured, the poll is a drift backstop on a long
    // interval (M5); without them it remains the primary PR-state driver.
    reconcileIntervalMs: Number(
      process.env.RECONCILE_INTERVAL_MS ?? (webhookSecret ? 300_000 : 30_000),
    ),
    reapPolicy: reapPolicyFromEnv(process.env),
    webhookSecret,
    internalToken,
    internalTls,
    gatewayRenderUrl,
  };
}

export interface BootedService {
  server: Server;
  bus: EventBus;
  pool: Pool;
  close(): Promise<void>;
}

/** Build and start the service. Exported so a boot-migrate smoke test can drive it. */
export async function start(config: Config = loadConfig()): Promise<BootedService> {
  const pool = new Pool({ connectionString: config.databaseUrl });

  // Split mode posts each command to the gateway (m6-plan Decision 2) with
  // whichever internal auth regime is configured; standalone logs, unchanged.
  const renderAuth = config.internalToken
    ? { token: config.internalToken }
    : config.internalTls
      ? { tls: { ...config.internalTls, expectService: 'chat-gateway' } }
      : undefined;
  const booted = await bootOrchestrator(pool, {
    envelopeKey: config.envelopeKey,
    retiredKeys: config.retiredKeys,
    githubApiBase: config.githubApiBase,
    internalTls: config.internalTls,
    render:
      config.gatewayRenderUrl && renderAuth
        ? httpRenderTransport(config.gatewayRenderUrl, renderAuth)
        : async (command) => {
            console.log(`[render] ${JSON.stringify(command)}`);
          },
  });

  // Poll reconciler — since M5 the drift backstop behind webhook ingress.
  const stopReconciler = booted.startReconciler(config.reconcileIntervalMs);

  // Elected lifecycle reaper (M17) — off unless a TTL knob is configured.
  const stopReaper = config.reapPolicy ? booted.startReaper(config.reapPolicy) : undefined;

  const server = createServer((req, res) => {
    void route(req, res, config, booted.orch, booted.repos, booted.bus);
  });

  // mTLS mode (M13): the split API serves the chat gateway on its own
  // listener; the plain port above keeps /health + webhooks only.
  let tlsServer: HttpsServer | undefined;
  if (config.internalTls) {
    const auth: InternalServerAuth = { tlsAllow: ['chat-gateway'] };
    tlsServer = createHttpsServer(serverTlsOptions(config.internalTls), (req, res) => {
      void (async () => {
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: SERVICE }));
          return;
        }
        if (await handleInternalApi(req, res, internalApiDeps(auth, booted.orch, booted.repos))) {
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
      })();
    });
    await new Promise<void>((resolve) => tlsServer!.listen(config.tlsPort, resolve));
    console.log(
      `[${SERVICE}] internal split API on :${config.tlsPort} (mTLS, serving chat-gateway)`,
    );
  }

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port}`);
  if (!config.webhookSecret) {
    console.log(`[${SERVICE}] GITHUB_WEBHOOK_SECRET unset — webhook ingress disabled, poll only`);
  }
  if (!config.internalToken && !config.internalTls) {
    console.log(
      `[${SERVICE}] DEVSPACE_INTERNAL_TOKEN and DEVSPACE_TLS_* unset — internal split API disabled`,
    );
  }
  console.log(
    config.reapPolicy
      ? `[${SERVICE}] lifecycle reaper on (idleTtlMs=${config.reapPolicy.idleTtlMs ?? 'off'}, ` +
          `idleWarnMs=${config.reapPolicy.idleWarnMs ?? 'off'}, ` +
          `terminalGraceMs=${config.reapPolicy.terminalGraceMs ?? 'off'}, ` +
          `prOpenEnvTtlMs=${config.reapPolicy.prOpenEnvTtlMs ?? 'off'}, ` +
          `intervalMs=${config.reapPolicy.intervalMs})`
      : `[${SERVICE}] DEVSPACE_IDLE_TTL_MS / DEVSPACE_TERMINAL_GRACE_MS / ` +
          `DEVSPACE_PR_OPEN_ENV_TTL_MS unset — lifecycle reaper off`,
  );

  return {
    server,
    bus: booted.bus,
    pool,
    async close() {
      stopReaper?.();
      stopReconciler();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (tlsServer) await new Promise<void>((resolve) => tlsServer!.close(() => resolve()));
      await booted.close();
      await pool.end();
    },
  };
}

/** The internal API's narrow deps, shared by the token and mTLS listeners. */
function internalApiDeps(
  auth: InternalServerAuth,
  orch: Orchestrator,
  repos: Repositories,
): Parameters<typeof handleInternalApi>[2] {
  return {
    auth,
    handleChatEvent: (event) => orch.handleChatEvent(event),
    resolveConversationId: (platform, externalChannelId) =>
      orch.resolveConversationId(platform, externalChannelId),
    conversationRef: async (conversationId) =>
      (await repos.conversations.get(conversationId))?.externalChannelId ?? null,
    listSessions: (platform, userId) => orch.listSessions(platform, userId),
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  orch: Orchestrator,
  repos: Repositories,
  bus: EventBus,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: SERVICE }));
    return;
  }

  if (req.method === 'POST' && req.url === '/webhooks/github') {
    if (!config.webhookSecret) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'webhooks not configured' }));
      return;
    }
    githubWebhook(req, res, config.webhookSecret, orch, repos, bus);
    return;
  }

  // The split's internal API (M6-A) — on this plain port only in token mode;
  // in mTLS mode it lives on its own listener (M13).
  if (config.internalToken) {
    const handled = await handleInternalApi(
      req,
      res,
      internalApiDeps({ token: config.internalToken }, orch, repos),
    );
    if (handled) return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
}

/**
 * GitHub webhook ingress (M5). The RAW body is captured for HMAC verification
 * before any parse; the verify→parse→map decision is the pure
 * `processWebhookDelivery` (tested in @devspace/orchestrator) — this is glue.
 */
function githubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  orch: Orchestrator,
  repos: Repositories,
  bus: EventBus,
): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    const result = processWebhookDelivery({
      secret,
      signatureHeader: header(req, 'x-hub-signature-256'),
      eventName: header(req, 'x-github-event'),
      rawBody,
    });
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: result.reason }));

    if (result.status === 401) {
      // A bad signature on the ingress boundary is itself audit-worthy.
      void repos.audit
        .append({ action: 'webhook.rejected', detail: { reason: result.reason } })
        .catch((err) => console.error(`[webhook] audit failed: ${String(err)}`));
      return;
    }
    if (!result.mapped) return; // verified but not a delivery we act on
    void orch
      .handleGitHubWebhook(result.mapped, async (e) => {
        await bus.publish({ topic: e.topic, workUnitId: e.workUnitId, payload: {} });
      })
      .catch((err) => console.error(`[webhook] handler error: ${String(err)}`));
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Run when invoked directly (node dist/main.js), not when imported by a test.
const invokedDirectly = process.argv[1]?.endsWith('main.js') ?? false;
if (invokedDirectly) {
  start().catch((err) => {
    console.error(`[${SERVICE}] failed to start:`, err);
    process.exit(1);
  });
}
