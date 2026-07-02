/**
 * M4 wiring smoke (m4-plan workstream E) — the analogue of M2's ACP loopback:
 * recorded/synthetic Slack payloads flow through the REAL SlackAdapter (real
 * Bolt routing via an injected receiver, fake WebClient) into the REAL
 * Orchestrator (in-memory repos, fake SandboxCore/AgentRunner, fake git/REST),
 * whose renders come back through the same adapter. No Docker, no network.
 *
 * Covered end to end: /devspace → PROVISIONING → READY, message → WORKING →
 * agent stream (incl. the secret-redaction invariant), approval round trip,
 * create-pr → PR_OPEN, and the reconciler's PR_MERGED render resolving a
 * cold outbound binding.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { App, Receiver } from '@slack/bolt';
import type {
  AgentEvent,
  Environment,
  PermissionDecision,
  RenderCommand,
} from '@devspace/contracts';
import { createInMemoryRepositories } from '@devspace/db';
import type { SandboxCore } from '@devspace/sandbox-core';
import type { AgentRunner } from '@devspace/agent-runner';
import { ConversationBinding, SlackAdapter } from '@devspace/chat-gateway';
import {
  generateKeyEntry,
  Orchestrator,
  parseKeyring,
  SECRET_GH_TOKEN,
  SECRET_LLM_KEY,
  SecretStore,
  TOPIC_PR_MERGED,
  type GitHubRestClient,
  type HostGitExec,
  type PullRef,
} from '@devspace/orchestrator';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'chat-gateway',
  'fixtures',
);
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

class FakeReceiver implements Receiver {
  private app!: App;
  init(app: App): void {
    this.app = app;
  }
  async start(): Promise<unknown> {
    return undefined;
  }
  async stop(): Promise<unknown> {
    return undefined;
  }
  async dispatch(body: Record<string, unknown>): Promise<void> {
    await this.app.processEvent({ body, ack: async () => {}, retryNum: undefined });
  }
}

const LLM_KEY_PLAINTEXT = 'sk-live-supersecret';

function fakeSandbox(): SandboxCore {
  const env: Environment = {
    envId: 'env_1',
    status: 'ready',
    ports: [],
    createdAt: new Date(0).toISOString(),
  };
  return {
    createEnvironment: vi.fn(async () => env),
    getEnvironment: vi.fn(async () => env),
    destroyEnvironment: vi.fn(async () => {}),
    exec: vi.fn(),
    fsRead: vi.fn(),
    fsWrite: vi.fn(),
    fsList: vi.fn(),
    forwardPort: vi.fn(),
  } as unknown as SandboxCore;
}

function fakeAgent(): AgentRunner & { decisions: PermissionDecision[] } {
  const decisions: PermissionDecision[] = [];
  const events: AgentEvent[] = [
    // The echoed LLM key MUST come out redacted — the E2E redaction invariant.
    { type: 'message', text: `Working on it (key=${LLM_KEY_PLAINTEXT})` },
    { type: 'permission_request', requestId: 'req-1', op: 'shell', details: 'ls -la' },
    { type: 'turn_end', reason: 'completed' },
  ];
  return {
    decisions,
    async createSession() {
      return { agentSessionId: 'as_1' };
    },
    async *runTurn(): AsyncIterable<AgentEvent> {
      for (const e of events) yield e;
    },
    async decidePermission(_id: string, d: PermissionDecision) {
      decisions.push(d);
    },
  } as AgentRunner & { decisions: PermissionDecision[] };
}

const fakeGit: HostGitExec = {
  async run() {
    return { stdout: '', stderr: '', code: 0 };
  },
};

function fakeRest(): GitHubRestClient {
  const pull: PullRef = {
    number: 42,
    htmlUrl: 'https://github.com/acme/widgets/pull/42',
    state: 'open',
    merged: false,
  };
  return {
    async createPull() {
      return pull;
    },
    async listOpenPullsByHead() {
      return [];
    },
    async getPull() {
      return { ...pull, state: 'closed', merged: true };
    },
  };
}

function fakeWebClient() {
  let n = 0;
  return {
    postMessage: vi.fn(
      async (_args: { channel: string; thread_ts?: string; text: string; blocks?: unknown[] }) => ({
        ts: `9999.${String((n += 1)).padStart(6, '0')}`,
      }),
    ),
    update: vi.fn(
      async (_args: { channel: string; ts: string; text: string; blocks?: unknown[] }) => {},
    ),
    publishHome: vi.fn(async () => {}),
  };
}

/** The full in-process demo assembly over in-memory repos + fakes. */
async function demoHarness() {
  const repos = createInMemoryRepositories();
  const store = new SecretStore(repos.secrets, parseKeyring(generateKeyEntry('k1')));
  const agent = fakeAgent();
  const sandbox = fakeSandbox();
  const receiver = new FakeReceiver();
  const client = fakeWebClient();

  // The exact main.ts shape: resolvers close over the orchestrator via a
  // holder, assigned after construction (they only run once events flow).
  const holder: { orch?: Orchestrator } = {};
  const binding = new ConversationBinding({
    conversation: async (ext) => holder.orch?.resolveConversationId('slack', ext) ?? null,
    ref: async (cid) => (await repos.conversations.get(cid))?.externalChannelId ?? null,
  });
  const adapter = new SlackAdapter(
    { botToken: 'xoxb-test', appToken: 'xapp-test' },
    {
      receiver,
      client,
      binding,
      authorize: async () => ({ botToken: 'xoxb-test', botId: 'B0001', botUserId: 'UBOT' }),
      warn: () => {},
    },
  );
  const orch = new Orchestrator({
    repos,
    sandbox,
    agents: agent,
    secrets: store,
    git: fakeGit,
    githubRest: () => fakeRest(),
    render: async (command: RenderCommand) => {
      await adapter.render(command);
    },
    workdirFor: () => '/work',
  });
  holder.orch = orch;
  await adapter.start((event) => orch.handleChatEvent(event));
  return { adapter, receiver, client, repos, store, agent, orch };
}

function threadEvent(text: string, threadTs: string, ts: string): Record<string, unknown> {
  return {
    ...fixture('event-thread-message.json'),
    event_id: `Ev-${ts}`,
    event: {
      type: 'message',
      channel: 'C0123ABC',
      channel_type: 'channel',
      user: 'U111',
      text,
      ts,
      thread_ts: threadTs,
      event_ts: ts,
    },
  };
}

function actionEvent(actionId: string, threadTs: string): Record<string, unknown> {
  const base = fixture('action-approve.json');
  return {
    ...base,
    message: { type: 'message', ts: '9999.000099', thread_ts: threadTs, text: 'actions' },
    actions: [
      {
        type: 'button',
        action_id: actionId,
        block_id: 'b1',
        text: { type: 'plain_text', text: actionId },
        action_ts: '1712345699.000000',
      },
    ],
  };
}

describe('M4 wiring smoke: Slack payloads ⇄ real Orchestrator, in one process', () => {
  it('drives the demo path: /devspace → READY → turn → approve → create-pr → merged', async () => {
    const h = await demoHarness();

    /* 1. /devspace <repo> — root a thread, provision, reach READY. */
    await h.receiver.dispatch(fixture('command-devspace.json'));
    const rootTs = '9999.000001';

    const units = await h.repos.workUnits.listByState('READY');
    expect(units).toHaveLength(1);
    expect(units[0]?.repoUrl).toBe('https://github.com/acme/widgets');
    // Renders arrived through the adapter into the thread: the PROVISIONING
    // status was posted (cold outbound resolved via the conversation record,
    // since the bind lands only after handleChatEvent returns), then READY
    // edited the SAME status message in place.
    const statusPost = h.client.postMessage.mock.calls.find(([a]) =>
      a.text.startsWith('PROVISIONING'),
    );
    expect(statusPost?.[0]).toMatchObject({ channel: 'C0123ABC', thread_ts: rootTs });
    expect(h.client.update.mock.calls.some(([a]) => a.text.startsWith('READY'))).toBe(true);

    const conversationId = units[0]!.conversationId;

    /* 2. Seed the demo secrets (out-of-band by design — m4-plan "Out"). */
    await h.store.put('U111', conversationId, SECRET_LLM_KEY, LLM_KEY_PLAINTEXT);
    await h.store.put('U111', conversationId, SECRET_GH_TOKEN, 'ghp_token');

    /* 3. First message → WORKING → agent stream renders into the thread. */
    await h.receiver.dispatch(threadEvent('add a healthcheck endpoint', rootTs, '1712.100'));
    expect(await h.repos.workUnits.listByState('WORKING')).toHaveLength(1);

    const texts = h.client.postMessage.mock.calls.map(([a]) => a.text);
    const agentMsg = texts.find((t) => t.includes('Working on it'));
    expect(agentMsg).toBeDefined();
    // The redaction invariant survived the whole pipeline:
    expect(agentMsg).toContain('«redacted»');
    expect(JSON.stringify(h.client.postMessage.mock.calls)).not.toContain(LLM_KEY_PLAINTEXT);
    // The permission request arrived as buttons with stable action ids.
    expect(texts.some((t) => t.includes('Approve'))).toBe(true);

    /* 4. Click Approve — the decision reaches the agent runner. */
    await h.receiver.dispatch(actionEvent('approve:req-1', rootTs));
    expect(h.agent.decisions).toEqual([{ requestId: 'req-1', decision: 'allow', scope: 'once' }]);

    /* 5. Click Create PR — host-side wrapper pushes + opens the PR. */
    await h.receiver.dispatch(actionEvent('create-pr', rootTs));
    const open = await h.repos.workUnits.listByState('PR_OPEN');
    expect(open).toHaveLength(1);
    expect(open[0]?.prUrl).toBe('https://github.com/acme/widgets/pull/42');
    expect(h.client.postMessage.mock.calls.some(([a]) => a.text.includes('Opened PR'))).toBe(true);

    /* 6. Reconciler observes the merge and renders PR_MERGED. */
    await h.orch.reconcileOpenPrs(async (e) => {
      expect(e.topic).toBe(TOPIC_PR_MERGED);
      await h.orch.handleBusEvent({
        id: 'evt-1',
        topic: e.topic,
        workUnitId: e.workUnitId,
        payload: {},
        emittedAt: new Date(0).toISOString(),
      });
    });
    expect(await h.repos.workUnits.listByState('PR_MERGED')).toHaveLength(1);
    expect(h.client.update.mock.calls.some(([a]) => a.text.includes('PR merged'))).toBe(true);
  });

  it('resolves a reconciler render with NO warm binding (post-restart path)', async () => {
    // Build one harness to create state, then a SECOND adapter with an empty
    // cache — as after a gateway restart — and let the resolvers do the work.
    const h = await demoHarness();
    await h.receiver.dispatch(fixture('command-devspace.json'));
    const conversationId = (await h.repos.workUnits.listByState('READY'))[0]!.conversationId;

    const cold = fakeWebClient();
    const binding = new ConversationBinding({
      conversation: async (ext) => h.orch.resolveConversationId('slack', ext),
      ref: async (cid) => (await h.repos.conversations.get(cid))?.externalChannelId ?? null,
    });
    const restarted = new SlackAdapter(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      {
        receiver: new FakeReceiver(),
        client: cold,
        binding,
        authorize: async () => ({ botToken: 'xoxb-test', botId: 'B0001', botUserId: 'UBOT' }),
        warn: () => {},
      },
    );
    await restarted.start(async () => {});

    await restarted.render({
      type: 'update_status',
      conversationId,
      state: 'PR_MERGED',
      text: 'PR merged. 🎉',
    });
    expect(cold.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C0123ABC', thread_ts: '9999.000001' }),
    );
  });
});
