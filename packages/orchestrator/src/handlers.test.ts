import { describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  CreateAgentSessionRequest,
  Environment,
  PermissionDecision,
  RenderCommand,
  TurnRequest,
} from '@devspace/contracts';
import { createInMemoryRepositories, type Repositories } from '@devspace/db';
import type { SandboxCore } from '@devspace/sandbox-core';
import type { AgentRunner } from '@devspace/agent-runner';
import {
  Orchestrator,
  OrchestratorError,
  SECRET_GH_TOKEN,
  SECRET_LLM_KEY,
  TOPIC_PR_MERGED,
} from './index.js';
import { generateKeyEntry, parseKeyring, SecretStore } from './secrets.js';
import type { GitHubRestClient, HostGitExec, PullRef } from './git.js';

const KEY = generateKeyEntry('k1');

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

function fakeAgent(events: AgentEvent[] = [{ type: 'message', text: 'working' }]): AgentRunner & {
  decisions: PermissionDecision[];
} {
  const decisions: PermissionDecision[] = [];
  return {
    decisions,
    async createSession(_req: CreateAgentSessionRequest) {
      return { agentSessionId: 'as_1' };
    },
    async *runTurn(_id: string, _req: TurnRequest): AsyncIterable<AgentEvent> {
      for (const e of events) yield e;
    },
    async decidePermission(_id: string, d: PermissionDecision) {
      decisions.push(d);
    },
  } as AgentRunner & { decisions: PermissionDecision[] };
}

function fakeGit(code = 0): HostGitExec {
  return {
    async run() {
      return { stdout: '', stderr: '', code };
    },
  };
}

function fakeRestFactory(pull: Partial<PullRef> = {}): (t: string) => GitHubRestClient {
  const base: PullRef = {
    number: 42,
    htmlUrl: 'https://github.com/a/b/pull/42',
    state: 'open',
    merged: false,
    ...pull,
  };
  return () => ({
    async createPull() {
      return base;
    },
    async listOpenPullsByHead() {
      return [];
    },
    async getPull() {
      return base;
    },
  });
}

interface Harness {
  orch: Orchestrator;
  repos: Repositories;
  store: SecretStore;
  rendered: RenderCommand[];
  sandbox: SandboxCore;
  agent: ReturnType<typeof fakeAgent>;
}

function harness(over: Partial<Parameters<typeof buildOrch>[0]> = {}): Harness {
  return buildOrch(over);
}

function buildOrch(opts: {
  repos?: Repositories;
  agent?: ReturnType<typeof fakeAgent>;
  rest?: (t: string) => GitHubRestClient;
  revokeToken?: (t: string) => Promise<void>;
}): Harness {
  const repos = opts.repos ?? createInMemoryRepositories();
  const store = new SecretStore(repos.secrets, parseKeyring(KEY));
  const rendered: RenderCommand[] = [];
  const sandbox = fakeSandbox();
  const agent = opts.agent ?? fakeAgent();
  const orch = new Orchestrator({
    repos,
    sandbox,
    agents: agent,
    secrets: store,
    git: fakeGit(),
    githubRest: opts.rest ?? fakeRestFactory(),
    render: async (c) => {
      rendered.push(c);
    },
    revokeToken: opts.revokeToken,
    workdirFor: () => '/work',
  });
  return { orch, repos, store, rendered, sandbox, agent };
}

describe('conversation.created', () => {
  it('provisions an environment and reaches READY', async () => {
    const h = harness();
    const created = await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C1',
      userId: 'u1',
      repoChoice: { repoUrl: 'https://github.com/a/b.git', empty: false },
    });
    expect(h.sandbox.createEnvironment).toHaveBeenCalledOnce();
    const conv = await h.repos.workUnits.listByState('READY');
    expect(conv).toHaveLength(1);
    expect(conv[0]?.envId).toBe('env_1');
    expect(h.rendered.map((r) => r.type)).toContain('update_status');
    // The gateway binds its thread to this id (M4 Decision 1).
    expect(created).toEqual({ conversationId: conv[0]?.conversationId });
  });

  it('creates a bare conversation without a repo', async () => {
    const h = harness();
    const created = await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C2',
      userId: 'u1',
    });
    expect(h.sandbox.createEnvironment).not.toHaveBeenCalled();
    expect(await h.repos.workUnits.listByState('CREATED')).toHaveLength(1);
    expect(created).toMatchObject({ conversationId: expect.any(String) });
  });

  it('returns the created id even when provisioning fails (thread stays bound)', async () => {
    const h = harness();
    (h.sandbox.createEnvironment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    );
    const created = await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C-fail',
      userId: 'u1',
      repoChoice: { repoUrl: 'https://github.com/a/b.git', empty: false },
    });
    expect(created).toMatchObject({ conversationId: expect.any(String) });
    expect(await h.repos.workUnits.listByState('FAILED')).toHaveLength(1);
  });

  it('resolveConversationId maps a platform thread back to the conversation', async () => {
    const h = harness();
    const created = await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C9:1.000100',
      userId: 'u1',
    });
    await expect(h.orch.resolveConversationId('slack', 'C9:1.000100')).resolves.toBe(
      (created as { conversationId: string }).conversationId,
    );
    await expect(h.orch.resolveConversationId('slack', 'C9:9.999999')).resolves.toBeNull();
    await expect(h.orch.resolveConversationId('discord', 'C9:1.000100')).resolves.toBeNull();
  });

  it('marks the unit FAILED when provisioning throws', async () => {
    const h = harness();
    (h.sandbox.createEnvironment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    );
    await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C3',
      userId: 'u1',
      repoChoice: { repoUrl: 'https://github.com/a/b.git', empty: false },
    });
    expect(await h.repos.workUnits.listByState('FAILED')).toHaveLength(1);
    expect(h.rendered.some((r) => 'text' in r && r.text.includes('boom'))).toBe(true);
  });
});

/** Seed a conversation + work unit directly in a given state. */
async function seed(
  repos: Repositories,
  store: SecretStore,
  state: 'READY' | 'WORKING',
  userId = 'u1',
) {
  const conv = await repos.conversations.create({
    platform: 'slack',
    externalChannelId: 'Cx',
    userId,
  });
  let wu = await repos.workUnits.create({ conversationId: conv.id });
  wu = await repos.workUnits.transition(wu.id, 'repoChoice', {
    repoUrl: 'https://github.com/a/b.git',
    branch: `devspace/${wu.id}`,
  });
  wu = await repos.workUnits.transition(wu.id, 'envReady', { envId: 'env_1' });
  await store.put(userId, conv.id, SECRET_LLM_KEY, 'sk-llm');
  await store.put(userId, conv.id, SECRET_GH_TOKEN, 'ghs_push_token');
  if (state === 'WORKING') {
    wu = await repos.workUnits.transition(wu.id, 'firstMessage', { agentSessionId: 'as_1' });
  }
  return { conv, wu };
}

describe('message.posted', () => {
  it('starts a session on the first message and streams agent events', async () => {
    const h = harness();
    const { conv } = await seed(h.repos, h.store, 'READY');
    await h.orch.handleChatEvent({
      type: 'message.posted',
      conversationId: conv.id,
      userId: 'u1',
      text: 'do the thing',
    });
    const wu = await h.repos.workUnits.getByConversation(conv.id);
    expect(wu?.state).toBe('WORKING');
    expect(wu?.agentSessionId).toBe('as_1');
    expect(h.rendered.some((r) => r.type === 'post_message')).toBe(true);
  });

  it('redacts an agent echo of the LLM key — every turn, not just the first', async () => {
    // The runner resolves the key by record id OUTSIDE the conversation
    // registry; the handler must register the plaintext itself or an echo
    // reaches chat unredacted. Found by the M4 wiring smoke.
    const agent = fakeAgent([{ type: 'message', text: 'my key is sk-llm' }]);
    const h = harness({ agent });
    const { conv } = await seed(h.repos, h.store, 'WORKING'); // NOT the first message
    await h.orch.handleChatEvent({
      type: 'message.posted',
      conversationId: conv.id,
      userId: 'u1',
      text: 'echo your key',
    });
    const posted = h.rendered.filter((r) => r.type === 'post_message');
    expect(posted.some((r) => r.text.includes('«redacted»'))).toBe(true);
    expect(JSON.stringify(h.rendered)).not.toContain('sk-llm');
  });

  it('rejects a tenant mismatch before touching state', async () => {
    const h = harness();
    const { conv } = await seed(h.repos, h.store, 'READY');
    await expect(
      h.orch.handleChatEvent({
        type: 'message.posted',
        conversationId: conv.id,
        userId: 'attacker',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(OrchestratorError);
  });
});

describe('action.invoked', () => {
  it('approval routes to decidePermission', async () => {
    const h = harness();
    const { conv } = await seed(h.repos, h.store, 'WORKING');
    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: conv.id,
      userId: 'u1',
      actionId: 'approve:req-9',
      payload: {},
    });
    expect(h.agent.decisions).toEqual([{ requestId: 'req-9', decision: 'allow', scope: 'once' }]);
  });

  it('create-pr from an illegal state renders an explanation, not a throw', async () => {
    const h = harness();
    const { conv } = await seed(h.repos, h.store, 'READY'); // not WORKING/PRE_PR
    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: conv.id,
      userId: 'u1',
      actionId: 'create-pr',
      payload: {},
    });
    const wu = await h.repos.workUnits.getByConversation(conv.id);
    expect(wu?.state).toBe('READY'); // unchanged
    expect(h.rendered.some((r) => 'text' in r && /start working/i.test(r.text))).toBe(true);
  });

  it('create-pr from WORKING pushes and opens a PR', async () => {
    const h = harness();
    const { conv } = await seed(h.repos, h.store, 'WORKING');
    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: conv.id,
      userId: 'u1',
      actionId: 'create-pr',
      payload: {},
    });
    const wu = await h.repos.workUnits.getByConversation(conv.id);
    expect(wu?.state).toBe('PR_OPEN');
    expect(wu?.prNumber).toBe(42);
    expect(wu?.prUrl).toBe('https://github.com/a/b/pull/42');
  });
});

describe('bus events + teardown', () => {
  it('applies prMerged idempotently against redelivery', async () => {
    const h = harness();
    const { conv, wu } = await seed(h.repos, h.store, 'WORKING');
    await h.repos.workUnits.transition(wu.id, 'committedAndPushed');
    await h.repos.workUnits.transition(wu.id, 'prCreated', { prNumber: 1, prUrl: 'https://x/1' });

    const evt = await h.repos.events.append({
      topic: TOPIC_PR_MERGED,
      workUnitId: wu.id,
      payload: {},
    });
    await h.orch.handleBusEvent(evt);
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_MERGED');
    // Redelivery of the same event must not throw and must not change state.
    await expect(h.orch.handleBusEvent(evt)).resolves.toBeUndefined();
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_MERGED');
    expect(conv.id).toBeDefined();
  });

  it('reconcileOpenPrs publishes prMerged for a merged PR', async () => {
    const h = harness({ rest: fakeRestFactory({ state: 'closed', merged: true }) });
    const { wu } = await seed(h.repos, h.store, 'WORKING');
    await h.repos.workUnits.transition(wu.id, 'committedAndPushed');
    await h.repos.workUnits.transition(wu.id, 'prCreated', { prNumber: 9, prUrl: 'https://x/9' });

    const published: Array<{ topic: string; workUnitId: string }> = [];
    await h.orch.reconcileOpenPrs(async (e) => {
      published.push(e);
    });
    expect(published).toEqual([{ topic: TOPIC_PR_MERGED, workUnitId: wu.id }]);
  });

  it('teardown revokes the push token, deletes secrets, and is replay-safe', async () => {
    const revoked: string[] = [];
    const h = harness({ revokeToken: async (t) => void revoked.push(t) });
    const { conv, wu } = await seed(h.repos, h.store, 'WORKING');

    await h.orch.teardown(conv.id);
    expect(revoked).toEqual(['ghs_push_token']);
    expect(await h.repos.secrets.get('u1', SECRET_GH_TOKEN, conv.id)).toBeNull();
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('TORN_DOWN');
    expect(h.sandbox.destroyEnvironment).toHaveBeenCalledWith('env_1');

    // Replay: no throw, no second revoke.
    await expect(h.orch.teardown(conv.id)).resolves.toBeUndefined();
    expect(revoked).toEqual(['ghs_push_token']);
  });
});

describe('audit log (M5)', () => {
  it('audits the full privileged path: secrets, approval, push+PR, teardown', async () => {
    const revoked: string[] = [];
    const h = harness({ revokeToken: async (t) => void revoked.push(t) });
    const { conv } = await seed(h.repos, h.store, 'READY');

    await h.orch.handleChatEvent({
      type: 'message.posted',
      conversationId: conv.id,
      userId: 'u1',
      text: 'go',
    });
    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: conv.id,
      userId: 'u1',
      actionId: 'approve:req-1',
      payload: {},
    });
    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: conv.id,
      userId: 'u1',
      actionId: 'create-pr',
      payload: {},
    });
    await h.orch.teardown(conv.id);

    const actions = (await h.repos.audit.listByConversation(conv.id)).map((a) => a.action);
    expect(actions).toEqual([
      'secret.resolved', // LLM key for the turn
      'approval.decided',
      'secret.resolved', // push/PR token
      'pr.pushed',
      'pr.opened',
      'token.revoked',
      'teardown',
    ]);

    const entries = await h.repos.audit.listByConversation(conv.id);
    expect(entries.find((a) => a.action === 'approval.decided')?.detail).toEqual({
      requestId: 'req-1',
      decision: 'allow',
    });
    expect(entries.find((a) => a.action === 'pr.opened')?.detail).toMatchObject({ prNumber: 42 });
    expect(entries.every((a) => a.userId === 'u1')).toBe(true);
  });

  it('audits a budget-aborted turn', async () => {
    const agent = fakeAgent([
      { type: 'message', text: 'runaway' },
      { type: 'turn_end', reason: 'aborted' },
    ]);
    const h = harness({ agent });
    const { conv } = await seed(h.repos, h.store, 'WORKING');
    await h.orch.handleChatEvent({
      type: 'message.posted',
      conversationId: conv.id,
      userId: 'u1',
      text: 'loop forever',
    });
    const entries = await h.repos.audit.listByConversation(conv.id);
    expect(entries.map((a) => a.action)).toContain('turn.aborted');
  });

  it('never writes secret plaintext into audit detail (regression guard)', async () => {
    const h = harness();
    const { conv } = await seed(h.repos, h.store, 'READY');
    await h.orch.handleChatEvent({
      type: 'message.posted',
      conversationId: conv.id,
      userId: 'u1',
      text: 'go',
    });
    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: conv.id,
      userId: 'u1',
      actionId: 'create-pr',
      payload: {},
    });
    await h.orch.teardown(conv.id);

    const dump = JSON.stringify(await h.repos.audit.listByConversation(conv.id));
    expect(dump).not.toContain('sk-llm'); // the seeded LLM key
    expect(dump).not.toContain('ghs_push_token'); // the seeded push token
  });
});

describe('GitHub webhooks (M5)', () => {
  async function seedPrOpen(h: Harness) {
    const { conv, wu } = await seed(h.repos, h.store, 'WORKING');
    await h.repos.workUnits.transition(wu.id, 'committedAndPushed');
    await h.repos.workUnits.transition(wu.id, 'prCreated', {
      prNumber: 42,
      prUrl: 'https://github.com/a/b/pull/42',
    });
    return { conv, wu };
  }

  it('publishes the merged topic for the matching PR_OPEN unit and audits it', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h);

    const published: Array<{ topic: string; workUnitId: string }> = [];
    const result = await h.orch.handleGitHubWebhook(
      // The seeded unit's repoUrl is https://github.com/a/b.git — the webhook
      // carries the html form; sameRepo must bridge them.
      { repoUrl: 'https://github.com/a/b', prNumber: 42, outcome: 'merged' },
      async (e) => void published.push(e),
    );

    expect(result.matched).toBe(1);
    expect(published).toEqual([{ topic: TOPIC_PR_MERGED, workUnitId: wu.id }]);
    const audited = await h.repos.audit.listByConversation(conv.id);
    expect(audited.map((a) => a.action)).toContain('webhook.received');
  });

  it('ignores non-matching deliveries (wrong repo or PR number)', async () => {
    const h = harness();
    await seedPrOpen(h);
    const published: unknown[] = [];
    const wrongRepo = await h.orch.handleGitHubWebhook(
      { repoUrl: 'https://github.com/other/repo', prNumber: 42, outcome: 'merged' },
      async (e) => void published.push(e),
    );
    const wrongNumber = await h.orch.handleGitHubWebhook(
      { repoUrl: 'https://github.com/a/b', prNumber: 999, outcome: 'closed' },
      async (e) => void published.push(e),
    );
    expect(wrongRepo.matched).toBe(0);
    expect(wrongNumber.matched).toBe(0);
    expect(published).toEqual([]);
  });

  it('webhook + poll double-delivery stays a no-op (shared idempotent topics)', async () => {
    const h = harness();
    const { wu } = await seedPrOpen(h);

    const deliver = async () => {
      await h.orch.handleGitHubWebhook(
        { repoUrl: 'https://github.com/a/b.git', prNumber: 42, outcome: 'merged' },
        async (e) => {
          const evt = await h.repos.events.append({
            topic: e.topic,
            workUnitId: e.workUnitId,
            payload: {},
          });
          await h.orch.handleBusEvent(evt);
        },
      );
    };

    await deliver();
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_MERGED');
    // The reconciler (or a redelivered webhook) publishing again must no-op.
    await expect(deliver()).resolves.toBeUndefined();
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_MERGED');
  });
});
