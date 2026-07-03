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
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import type { EventBus, Repositories } from '@devspace/db';
import {
  bootOrchestrator,
  handleInternalApi,
  httpRenderTransport,
  processWebhookDelivery,
  type Orchestrator,
} from '@devspace/orchestrator';

const SERVICE = 'orchestrator';

interface Config {
  port: number;
  databaseUrl: string;
  envelopeKey: string;
  retiredKeys: string[];
  githubApiBase: string;
  reconcileIntervalMs: number;
  /** Webhook ingress is disabled (with a boot log) when unset. */
  webhookSecret?: string;
  /** Shared bearer token; the internal split API is disabled when unset. */
  internalToken?: string;
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
  const gatewayRenderUrl = process.env.GATEWAY_RENDER_URL || undefined;
  // An unauthenticated control plane is worse than no split (m6-plan
  // Decision 3): render-to-gateway without the shared token is refused.
  if (gatewayRenderUrl && !internalToken) {
    throw new Error('GATEWAY_RENDER_URL requires DEVSPACE_INTERNAL_TOKEN');
  }
  return {
    port: Number(process.env.ORCHESTRATOR_PORT ?? process.env.PORT ?? 4000),
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
    webhookSecret,
    internalToken,
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

  const booted = await bootOrchestrator(pool, {
    envelopeKey: config.envelopeKey,
    retiredKeys: config.retiredKeys,
    githubApiBase: config.githubApiBase,
    // Split mode posts each command to the gateway (m6-plan Decision 2);
    // standalone surfaces to logs, unchanged.
    render:
      config.gatewayRenderUrl && config.internalToken
        ? httpRenderTransport(config.gatewayRenderUrl, config.internalToken)
        : async (command) => {
            console.log(`[render] ${JSON.stringify(command)}`);
          },
  });

  // Poll reconciler — since M5 the drift backstop behind webhook ingress.
  const stopReconciler = booted.startReconciler(config.reconcileIntervalMs);

  const server = createServer((req, res) => {
    void route(req, res, config, booted.orch, booted.repos, booted.bus);
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port}`);
  if (!config.webhookSecret) {
    console.log(`[${SERVICE}] GITHUB_WEBHOOK_SECRET unset — webhook ingress disabled, poll only`);
  }
  if (!config.internalToken) {
    console.log(`[${SERVICE}] DEVSPACE_INTERNAL_TOKEN unset — internal split API disabled`);
  }

  return {
    server,
    bus: booted.bus,
    pool,
    async close() {
      stopReconciler();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await booted.close();
      await pool.end();
    },
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

  // The split's internal API (M6-A) — live only when the token is configured.
  if (config.internalToken) {
    const handled = await handleInternalApi(req, res, {
      token: config.internalToken,
      handleChatEvent: (event) => orch.handleChatEvent(event),
      resolveConversationId: (platform, externalChannelId) =>
        orch.resolveConversationId(platform, externalChannelId),
      conversationRef: async (conversationId) =>
        (await repos.conversations.get(conversationId))?.externalChannelId ?? null,
      listSessions: (platform, userId) => orch.listSessions(platform, userId),
    });
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
