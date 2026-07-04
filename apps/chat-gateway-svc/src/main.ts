/**
 * The chat gateway service. One platform per process (CHAT_PLATFORM=slack —
 * the default — or discord), two modes:
 *
 * **Split mode (M6, m6-plan A)** — `ORCHESTRATOR_URL` set: a real two-service
 * deployment. Chat events go up over authed `POST /chat-events`, the binding's
 * cold-miss resolvers and the App Home list ride the orchestrator's read
 * endpoints, and this service serves authed `POST /render` for commands coming
 * down. No database, no in-process orchestrator.
 *
 * **Demo mode (M4)** — `ORCHESTRATOR_URL` unset: the real Orchestrator and the
 * platform adapter in ONE process, connected at the two seam functions
 * (m4-plan Decision 2):
 *
 *   orchestrator.render  = (cmd)   => adapter.render(cmd)
 *   adapter.start((event)          => orchestrator.handleChatEvent(event))
 *
 * Those two boundaries are exactly where the split cuts — nothing else couples
 * the halves; the HTTP mode wraps the same seam functions the demo wires
 * directly (m6-plan Decision 4).
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { Pool } from 'pg';
import type { ChatPlatform } from '@devspace/contracts';
import {
  internalTlsFromEnv,
  serverTlsOptions,
  type InternalTlsIdentity,
} from '@devspace/sandbox-core';
import {
  ConversationBinding,
  DiscordAdapter,
  SlackAdapter,
  discordJsTransport,
  type ChatAdapter,
  type ChatRenderer,
  type HomeSession,
} from '@devspace/chat-gateway';
import {
  bootOrchestrator,
  handleRenderRequest,
  httpChatEventEmitter,
  httpOrchestratorReads,
  type BootedOrchestrator,
  type InternalClientAuth,
  type InternalServerAuth,
} from '@devspace/orchestrator';

const SERVICE = 'chat-gateway';

interface Config {
  port: number;
  platform: ChatPlatform;
  slackBotToken?: string;
  slackAppToken?: string;
  discordToken?: string;
  discordApplicationId?: string;
  /** Split mode when set (m6-plan Decision 4). */
  orchestratorUrl?: string;
  internalToken?: string;
  /** Internal TLS identity (M13); /render then serves on tlsPort over mTLS. */
  internalTls?: InternalTlsIdentity;
  tlsPort: number;
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
  const platform = (process.env.CHAT_PLATFORM ?? 'slack') as ChatPlatform;
  if (platform !== 'slack' && platform !== 'discord') {
    throw new Error(`CHAT_PLATFORM must be slack or discord, got ${platform}`);
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || undefined;
  const internalToken = process.env.DEVSPACE_INTERNAL_TOKEN || undefined;
  const internalTls = internalTlsFromEnv(process.env);
  const port = Number(process.env.CHAT_GATEWAY_PORT ?? process.env.PORT ?? 4002);
  // One auth regime per deployment (m13-plan Decision 1).
  if (internalToken && internalTls) {
    throw new Error(
      'DEVSPACE_INTERNAL_TOKEN and DEVSPACE_TLS_* are mutually exclusive — one auth regime per deployment',
    );
  }
  if (orchestratorUrl && !internalToken && !internalTls) {
    // An unauthenticated control plane is worse than no split (Decision 3).
    throw new Error(
      'ORCHESTRATOR_URL requires DEVSPACE_INTERNAL_TOKEN or the DEVSPACE_TLS_* identity',
    );
  }
  return {
    port,
    tlsPort: Number(process.env.DEVSPACE_TLS_PORT ?? port + 1),
    platform,
    slackBotToken: platform === 'slack' ? required('SLACK_BOT_TOKEN') : undefined,
    slackAppToken: platform === 'slack' ? required('SLACK_APP_TOKEN') : undefined,
    discordToken: platform === 'discord' ? required('DISCORD_TOKEN') : undefined,
    discordApplicationId: platform === 'discord' ? required('DISCORD_APPLICATION_ID') : undefined,
    orchestratorUrl,
    internalToken,
    internalTls,
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

type Adapter = ChatAdapter & ChatRenderer;

/** Build the platform adapter around a shared binding + session-list source. */
function buildAdapter(
  config: Config,
  binding: ConversationBinding,
  listSessions: (userId: string) => Promise<HomeSession[]>,
): Adapter {
  if (config.platform === 'discord') {
    return new DiscordAdapter(
      discordJsTransport({
        token: config.discordToken!,
        applicationId: config.discordApplicationId!,
      }),
      // Same session-list source as Slack's App Home — `/sessions` (M7-C).
      { binding, listSessions },
    );
  }
  return new SlackAdapter(
    { botToken: config.slackBotToken!, appToken: config.slackAppToken! },
    { binding, listSessions },
  );
}

export interface BootedGateway {
  server: Server;
  adapter: Adapter;
  /** The mTLS /render listener (M13); present in TLS split mode only. */
  tlsServer?: HttpsServer;
  /** Present in demo mode only. */
  booted?: BootedOrchestrator;
  pool?: Pool;
  close(): Promise<void>;
}

/** Build and start the service. Exported so a wiring smoke can drive it. */
export async function start(config: Config = loadConfig()): Promise<BootedGateway> {
  if (!config.orchestratorUrl) return startDemo(config);
  const auth: InternalClientAuth = config.internalToken
    ? { token: config.internalToken }
    : { tls: { ...config.internalTls!, expectService: 'orchestrator' } };
  return startSplit(config, config.orchestratorUrl, auth);
}

/* -------------------------------------------------------------------------- */
/* Split mode (M6)                                                             */
/* -------------------------------------------------------------------------- */

async function startSplit(
  config: Config,
  orchestratorUrl: string,
  auth: InternalClientAuth,
): Promise<BootedGateway> {
  const emit = httpChatEventEmitter(orchestratorUrl, auth);
  const reads = httpOrchestratorReads(orchestratorUrl, auth);

  const binding = new ConversationBinding({
    conversation: (externalChannelId) =>
      reads.resolveConversationId(config.platform, externalChannelId),
    ref: (conversationId) => reads.conversationRef(conversationId),
  });

  const adapter = buildAdapter(config, binding, async (userId) =>
    (await reads.listSessions(config.platform, userId)).map((s) => ({
      conversationId: s.conversationId,
      state: s.state,
      repoUrl: s.repoUrl,
      prUrl: s.prUrl,
    })),
  );

  await adapter.start((event) => emit(event));

  const health = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ status: 'ok', service: SERVICE, platform: config.platform, mode: 'split' }),
    );
  };
  const notFound = (res: ServerResponse): void => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
  };

  // mTLS mode (M13): /render serves the orchestrator on its own listener and
  // the plain port keeps /health only; token mode is the single-port M6 shape.
  let tlsServer: HttpsServer | undefined;
  if (config.internalTls) {
    const serverAuth: InternalServerAuth = { tlsAllow: ['orchestrator'] };
    tlsServer = createHttpsServer(serverTlsOptions(config.internalTls), (req, res) => {
      void (async () => {
        if (
          await handleRenderRequest(req, res, {
            auth: serverAuth,
            render: (cmd) => adapter.render(cmd),
          })
        ) {
          return;
        }
        if (req.method === 'GET' && req.url === '/health') return health(res);
        notFound(res);
      })();
    });
    await new Promise<void>((resolve) => tlsServer!.listen(config.tlsPort, resolve));
    console.log(`[${SERVICE}] render endpoint on :${config.tlsPort} (mTLS, serving orchestrator)`);
  }

  const server = createServer((req, res) => {
    void (async () => {
      if (
        !config.internalTls &&
        'token' in auth &&
        (await handleRenderRequest(req, res, {
          auth: { token: auth.token },
          render: (cmd) => adapter.render(cmd),
        }))
      ) {
        return;
      }
      if (req.method === 'GET' && req.url === '/health') return health(res);
      notFound(res);
    })();
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port} (${config.platform}, split)`);

  return {
    server,
    adapter,
    tlsServer,
    async close() {
      await adapter.stop(); // drains pending stream buffers
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (tlsServer) await new Promise<void>((resolve) => tlsServer!.close(() => resolve()));
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
      holder.booted?.orch.resolveConversationId(config.platform, externalChannelId) ?? null,
    ref: async (conversationId) =>
      (await holder.booted?.repos.conversations.get(conversationId))?.externalChannelId ?? null,
  });

  const adapter = buildAdapter(config, binding, async (userId) =>
    ((await holder.booted?.orch.listSessions(config.platform, userId)) ?? []).map((s) => ({
      conversationId: s.conversationId,
      state: s.state,
      repoUrl: s.repoUrl,
      prUrl: s.prUrl,
    })),
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

  // The platform transport connects only now — after migrations and assembly.
  await adapter.start((event) => booted.orch.handleChatEvent(event));

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: SERVICE, platform: config.platform }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[${SERVICE}] listening on :${config.port} (${config.platform})`);

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
