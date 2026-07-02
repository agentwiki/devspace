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
import type { EventBus } from '@devspace/db';
import { bootOrchestrator, type Orchestrator } from '@devspace/orchestrator';

const SERVICE = 'orchestrator';

interface Config {
  port: number;
  databaseUrl: string;
  envelopeKey: string;
  retiredKeys: string[];
  githubApiBase: string;
  reconcileIntervalMs: number;
}

function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const envelopeKey = process.env.SECRET_ENVELOPE_KEY;
  if (!envelopeKey) throw new Error('SECRET_ENVELOPE_KEY is required');
  return {
    port: Number(process.env.ORCHESTRATOR_PORT ?? process.env.PORT ?? 4000),
    databaseUrl,
    envelopeKey,
    retiredKeys: (process.env.SECRET_ENVELOPE_KEYS_RETIRED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    githubApiBase: process.env.GITHUB_API_BASE ?? 'https://api.github.com',
    reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 30_000),
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
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port}`);

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

// Run when invoked directly (node dist/main.js), not when imported by a test.
const invokedDirectly = process.argv[1]?.endsWith('main.js') ?? false;
if (invokedDirectly) {
  start().catch((err) => {
    console.error(`[${SERVICE}] failed to start:`, err);
    process.exit(1);
  });
}
