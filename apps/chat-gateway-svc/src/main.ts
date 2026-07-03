/**
 * The chat gateway service. Two modes, one adapter:
 *
 * **Split mode (M6, m6-plan A)** — `ORCHESTRATOR_URL` set: a real two-service
 * deployment. Chat events go up over authed `POST /chat-events`, the binding's
 * cold-miss resolvers and the App Home list ride the orchestrator's read
 * endpoints, and this service serves authed `POST /render` for commands coming
 * down. No database, no in-process orchestrator.
 *
 * **Demo mode (M4)** — `ORCHESTRATOR_URL` unset: the real Orchestrator and the
 * real SlackAdapter in ONE process, connected at the two seam functions
 * (m4-plan Decision 2):
 *
 *   orchestrator.render  = (cmd)   => slackAdapter.render(cmd)
 *   slackAdapter.start((event)     => orchestrator.handleChatEvent(event))
 *
 * Those two boundaries are exactly where the split cuts — nothing else couples
 * the halves; the HTTP mode wraps the same seam functions the demo wires
 * directly (m6-plan Decision 4).
 */
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { ConversationBinding, SlackAdapter } from '@devspace/chat-gateway';
import type { HomeSession } from '@devspace/chat-gateway';
import {
  bootOrchestrator,
  handleRenderRequest,
  httpChatEventEmitter,
  httpOrchestratorReads,
  type BootedOrchestrator,
} from '@devspace/orchestrator';

const SERVICE = 'chat-gateway';

interface Config {
  port: number;
  slackBotToken: string;
  slackAppToken: string;
  /** Split mode when set (m6-plan Decision 4). */
  orchestratorUrl?: string;
  internalToken?: string;
  /** Demo mode only: */
  databaseUrl?: string;
  envelopeKey?: string;
  retiredKeys: string[];
  githubApiBase: string;
  reconcileIntervalMs: number;
}

function loadConfig(): Config {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || undefined;
  const internalToken = process.env.DEVSPACE_INTERNAL_TOKEN || undefined;
  if (orchestratorUrl && !internalToken) {
    // An unauthenticated control plane is worse than no split (Decision 3).
    throw new Error('ORCHESTRATOR_URL requires DEVSPACE_INTERNAL_TOKEN');
  }
  return {
    port: Number(process.env.CHAT_GATEWAY_PORT ?? process.env.PORT ?? 4002),
    slackBotToken: required('SLACK_BOT_TOKEN'),
    slackAppToken: required('SLACK_APP_TOKEN'),
    orchestratorUrl,
    internalToken,
    databaseUrl: orchestratorUrl ? undefined : required('DATABASE_URL'),
    envelopeKey: orchestratorUrl ? undefined : required('SECRET_ENVELOPE_KEY'),
    retiredKeys: (process.env.SECRET_ENVELOPE_KEYS_RETIRED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    githubApiBase: process.env.GITHUB_API_BASE ?? 'https://api.github.com',
    reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 30_000),
  };
}

export interface BootedGateway {
  server: Server;
  adapter: SlackAdapter;
  /** Present in demo mode only. */
  booted?: BootedOrchestrator;
  pool?: Pool;
  close(): Promise<void>;
}

/** Build and start the service. Exported so a wiring smoke can drive it. */
export async function start(config: Config = loadConfig()): Promise<BootedGateway> {
  return config.orchestratorUrl
    ? startSplit(config, config.orchestratorUrl, config.internalToken!)
    : startDemo(config);
}

/* -------------------------------------------------------------------------- */
/* Split mode (M6)                                                             */
/* -------------------------------------------------------------------------- */

async function startSplit(
  config: Config,
  orchestratorUrl: string,
  token: string,
): Promise<BootedGateway> {
  const emit = httpChatEventEmitter(orchestratorUrl, token);
  const reads = httpOrchestratorReads(orchestratorUrl, token);

  const binding = new ConversationBinding({
    conversation: (externalChannelId) => reads.resolveConversationId('slack', externalChannelId),
    ref: (conversationId) => reads.conversationRef(conversationId),
  });

  const adapter = new SlackAdapter(
    { botToken: config.slackBotToken, appToken: config.slackAppToken },
    {
      binding,
      listSessions: async (slackUserId): Promise<HomeSession[]> =>
        (await reads.listSessions('slack', slackUserId)).map((s) => ({
          conversationId: s.conversationId,
          state: s.state,
          repoUrl: s.repoUrl,
          prUrl: s.prUrl,
        })),
    },
  );

  await adapter.start((event) => emit(event));

  const server = createServer((req, res) => {
    void (async () => {
      if (await handleRenderRequest(req, res, { token, render: (cmd) => adapter.render(cmd) })) {
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ status: 'ok', service: SERVICE, platform: 'slack', mode: 'split' }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port} (slack socket mode, split)`);

  return {
    server,
    adapter,
    async close() {
      await adapter.stop(); // drains pending stream buffers
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Demo mode (M4) — in-process orchestrator, byte-for-byte the M4 wiring       */
/* -------------------------------------------------------------------------- */

async function startDemo(config: Config): Promise<BootedGateway> {
  const pool = new Pool({ connectionString: config.databaseUrl });

  // The binding's resolvers reference the orchestrator, booted below — they
  // only run once events flow, which is after bootOrchestrator returns.
  const holder: { booted?: BootedOrchestrator } = {};
  const binding = new ConversationBinding({
    conversation: async (externalChannelId) =>
      holder.booted?.orch.resolveConversationId('slack', externalChannelId) ?? null,
    ref: async (conversationId) =>
      (await holder.booted?.repos.conversations.get(conversationId))?.externalChannelId ?? null,
  });

  const adapter = new SlackAdapter(
    { botToken: config.slackBotToken, appToken: config.slackAppToken },
    {
      binding,
      listSessions: async (slackUserId): Promise<HomeSession[]> =>
        ((await holder.booted?.orch.listSessions('slack', slackUserId)) ?? []).map((s) => ({
          conversationId: s.conversationId,
          state: s.state,
          repoUrl: s.repoUrl,
          prUrl: s.prUrl,
        })),
    },
  );

  const booted = await bootOrchestrator(pool, {
    envelopeKey: config.envelopeKey!,
    retiredKeys: config.retiredKeys,
    githubApiBase: config.githubApiBase,
    render: async (command) => {
      await adapter.render(command);
    },
  });
  holder.booted = booted;
  const stopReconciler = booted.startReconciler(config.reconcileIntervalMs);

  // Socket Mode connects only now — after migrations and the full assembly.
  await adapter.start((event) => booted.orch.handleChatEvent(event));

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: SERVICE, platform: 'slack' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port} (slack socket mode)`);

  return {
    server,
    adapter,
    booted,
    pool,
    async close() {
      stopReconciler();
      await adapter.stop(); // drains pending stream buffers
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await booted.close();
      await pool.end();
    },
  };
}

// Run when invoked directly (node dist/main.js), not when imported by a test.
const invokedDirectly = process.argv[1]?.endsWith('main.js') ?? false;
if (invokedDirectly) {
  start().catch((err) => {
    console.error(`[${SERVICE}] failed to start:`, err);
    process.exit(1);
  });
}
