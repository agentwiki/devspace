/**
 * Deployable entrypoint for the orchestrator control plane (M3 wiring, M4
 * boot extraction). The assembly itself lives in @devspace/orchestrator's
 * `bootOrchestrator` (shared with the chat-gateway demo service); this
 * entrypoint owns the Pool, the HTTP surface (`/health` + the `ChatEvent`
 * ingest endpoint), and the reconciler schedule. Standalone, render commands
 * surface to logs — the Slack transport lives in chat-gateway-svc.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { ChatEventSchema } from '@devspace/contracts';
import type { EventBus, Repositories } from '@devspace/db';
import {
  bootOrchestrator,
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
}

function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const envelopeKey = process.env.SECRET_ENVELOPE_KEY;
  if (!envelopeKey) throw new Error('SECRET_ENVELOPE_KEY is required');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || undefined;
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
    // A real render transport (Slack) lives in chat-gateway-svc; surface to logs.
    render: async (command) => {
      console.log(`[render] ${JSON.stringify(command)}`);
    },
  });

  // Poll reconciler — the webhook stand-in that advances PR_OPEN units.
  const stopReconciler = booted.startReconciler(config.reconcileIntervalMs);

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: SERVICE }));
      return;
    }
    if (req.method === 'POST' && req.url === '/events') {
      ingest(req, res, booted.orch);
      return;
    }
    if (req.method === 'POST' && req.url === '/webhooks/github') {
      if (!config.webhookSecret) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'webhooks not configured' }));
        return;
      }
      githubWebhook(req, res, config.webhookSecret, booted.orch, booted.repos, booted.bus);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port}`);
  if (!config.webhookSecret) {
    console.log(`[${SERVICE}] GITHUB_WEBHOOK_SECRET unset — webhook ingress disabled, poll only`);
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

function ingest(req: IncomingMessage, res: ServerResponse, orch: Orchestrator): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return badRequest(res, 'invalid JSON');
    }
    const parsed = ChatEventSchema.safeParse(json);
    if (!parsed.success) return badRequest(res, parsed.error.message);
    // Ack immediately; process asynchronously (handlers are idempotent).
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));
    void orch.handleChatEvent(parsed.data).catch((err) => {
      console.error(`[ingest] handler error: ${String(err)}`);
    });
  });
}

function badRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'BAD_REQUEST', message }));
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
