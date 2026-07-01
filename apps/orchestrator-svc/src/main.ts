/**
 * Deployable entrypoint for the orchestrator control plane (M3 wiring).
 *
 * Assembles the Postgres repositories, the LISTEN/NOTIFY event bus, the
 * envelope-encrypted secret store, and the real `Orchestrator`, applies pending
 * migrations before serving, exposes a `ChatEvent` ingest endpoint, subscribes
 * the bus to the orchestrator, and runs the PR poll reconciler on a schedule
 * (the webhook stand-in — without it PR_OPEN units never advance).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { Pool } from 'pg';
import { ChatEventSchema } from '@devspace/contracts';
import {
  createPgEventBus,
  createPostgresRepositories,
  runMigrations,
  type EventBus,
} from '@devspace/db';
import {
  createGitHubRestClient,
  Orchestrator,
  parseKeyring,
  SecretStore,
  type HostGitExec,
} from '@devspace/orchestrator';
import { DevcontainerSandboxCore } from '@devspace/sandbox-core';
import { DefaultAgentRunner } from '@devspace/agent-runner';

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

/** Host-side git executor. Never runs inside a container (Decision 1). */
const nodeHostGit: HostGitExec = {
  run(args, opts) {
    return new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd: opts?.cwd, env: { ...process.env, ...opts?.env } },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ stdout, stderr, code });
        },
      );
    });
  },
};

export interface BootedService {
  server: Server;
  bus: EventBus;
  pool: Pool;
  close(): Promise<void>;
}

/** Build and start the service. Exported so a boot-migrate smoke test can drive it. */
export async function start(config: Config = loadConfig()): Promise<BootedService> {
  const pool = new Pool({ connectionString: config.databaseUrl });

  // Migrations first — never serve against an unmigrated schema.
  await runMigrations(pool);

  const repos = createPostgresRepositories(pool);
  const keyring = parseKeyring(config.envelopeKey, config.retiredKeys);
  const secrets = new SecretStore(repos.secrets, keyring);
  const sandbox = new DevcontainerSandboxCore();
  const agents = new DefaultAgentRunner({
    exec: sandbox,
    // llmKeyRef is a secret record id resolved through the envelope store.
    resolveSecret: (ref) => secrets.resolveRef(ref),
  });
  const bus = createPgEventBus(pool, repos.events);

  const orch = new Orchestrator({
    repos,
    sandbox,
    agents,
    secrets,
    git: nodeHostGit,
    githubRest: (token) => createGitHubRestClient(token, config.githubApiBase),
    // A real render transport (Slack) lands in M4; for now surface to logs.
    render: async (command) => {
      console.log(`[render] ${JSON.stringify(command)}`);
    },
  });

  bus.subscribe((evt) => orch.handleBusEvent(evt));
  await bus.start();

  // Poll reconciler — the webhook stand-in that advances PR_OPEN units.
  const reconcile = setInterval(() => {
    void orch
      .reconcileOpenPrs(async (e) => {
        await bus.publish({ topic: e.topic, workUnitId: e.workUnitId, payload: {} });
      })
      .catch((err) => console.error(`[reconcile] ${String(err)}`));
  }, config.reconcileIntervalMs);
  reconcile.unref();

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: SERVICE }));
      return;
    }
    if (req.method === 'POST' && req.url === '/events') {
      ingest(req, res, orch);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port}`);

  return {
    server,
    bus,
    pool,
    async close() {
      clearInterval(reconcile);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await bus.stop();
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
