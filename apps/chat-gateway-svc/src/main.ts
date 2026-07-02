/**
 * The M4 demo service: the real Orchestrator and the real SlackAdapter in ONE
 * process, connected at the two seam functions (m4-plan Decision 2):
 *
 *   orchestrator.render  = (cmd)   => slackAdapter.render(cmd)
 *   slackAdapter.start((event)     => orchestrator.handleChatEvent(event))
 *
 * Those two boundaries are exactly where a later two-service HTTP split cuts
 * (M6) — nothing else couples the halves. The orchestrator assembly is the
 * shared `bootOrchestrator` (same code path as orchestrator-svc); migrations
 * apply before Socket Mode connects, so no event ever races the schema.
 *
 * The binding's cold-miss resolvers close the post-restart gap (m4-plan
 * Decision 1): inbound via orch.resolveConversationId, outbound via the
 * conversation record's externalChannelId (the reconciler's render path).
 */
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { ConversationBinding, SlackAdapter } from '@devspace/chat-gateway';
import { bootOrchestrator, type BootedOrchestrator } from '@devspace/orchestrator';

const SERVICE = 'chat-gateway';

interface Config {
  port: number;
  databaseUrl: string;
  envelopeKey: string;
  retiredKeys: string[];
  githubApiBase: string;
  reconcileIntervalMs: number;
  slackBotToken: string;
  slackAppToken: string;
}

function loadConfig(): Config {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    port: Number(process.env.CHAT_GATEWAY_PORT ?? process.env.PORT ?? 4002),
    databaseUrl: required('DATABASE_URL'),
    envelopeKey: required('SECRET_ENVELOPE_KEY'),
    retiredKeys: (process.env.SECRET_ENVELOPE_KEYS_RETIRED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    githubApiBase: process.env.GITHUB_API_BASE ?? 'https://api.github.com',
    reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 30_000),
    slackBotToken: required('SLACK_BOT_TOKEN'),
    slackAppToken: required('SLACK_APP_TOKEN'),
  };
}

export interface BootedGateway {
  server: Server;
  adapter: SlackAdapter;
  booted: BootedOrchestrator;
  pool: Pool;
  close(): Promise<void>;
}

/** Build and start the demo service. Exported so a wiring smoke can drive it. */
export async function start(config: Config = loadConfig()): Promise<BootedGateway> {
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
    { binding },
  );

  const booted = await bootOrchestrator(pool, {
    envelopeKey: config.envelopeKey,
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
