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
import { SandboxError, type SandboxCore } from '@devspace/sandbox-core';
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

describe('activity truth (M17)', () => {
  it('tenant-driven chat events stamp lastActivityAt on the work unit', async () => {
    let tick = 0;
    const repos = createInMemoryRepositories(() => new Date(tick).toISOString());
    const h = harness({ repos });
    const { conv, wu } = await seed(repos, h.store, 'WORKING');
    expect((await repos.workUnits.get(wu.id))?.lastActivityAt).toBeUndefined();

    tick = 10_000;
    await h.orch.handleChatEvent({
      type: 'message.posted',
      conversationId: conv.id,
      userId: 'u1',
      text: 'do the thing',
    });
    expect((await repos.workUnits.get(wu.id))?.lastActivityAt).toBe(new Date(10_000).toISOString());

    tick = 20_000;
    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: conv.id,
      userId: 'u1',
      actionId: 'view-pr',
    });
    expect((await repos.workUnits.get(wu.id))?.lastActivityAt).toBe(new Date(20_000).toISOString());

    tick = 30_000;
    await h.orch.handleChatEvent({
      type: 'secret.submitted',
      conversationId: conv.id,
      userId: 'u1',
      name: 'LLM_KEY',
      value: 'sk-rotated',
    });
    expect((await repos.workUnits.get(wu.id))?.lastActivityAt).toBe(new Date(30_000).toISOString());
  });

  it('a failed touch never fails the event it rode in on', async () => {
    const repos = createInMemoryRepositories();
    const h = harness({ repos });
    const { conv } = await seed(repos, h.store, 'WORKING');
    vi.spyOn(repos.workUnits, 'touch').mockRejectedValue(new Error('db hiccup'));
    await expect(
      h.orch.handleChatEvent({
        type: 'message.posted',
        conversationId: conv.id,
        userId: 'u1',
        text: 'still works',
      }),
    ).resolves.toBeUndefined();
    expect(h.rendered.length).toBeGreaterThan(0);
  });
});

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

describe('session resume (M19)', () => {
  /** Walk a seeded unit to PR_OPEN (prNumber 42, the seed's PR branch). */
  async function seedPrOpen(h: Harness) {
    const { conv, wu } = await seed(h.repos, h.store, 'WORKING');
    await h.repos.workUnits.transition(wu.id, 'committedAndPushed');
    const prOpen = await h.repos.workUnits.transition(wu.id, 'prCreated', {
      prNumber: 42,
      prUrl: 'https://github.com/a/b/pull/42',
    });
    return { conv, wu: prOpen };
  }

  const resume = (h: Harness, conversationId: string) =>
    h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId,
      userId: 'u1',
      actionId: 'resume-work',
      payload: {},
    });

  const message = (h: Harness, conversationId: string, text = 'address the review') =>
    h.orch.handleChatEvent({ type: 'message.posted', conversationId, userId: 'u1', text });

  it('a message in PR_OPEN offers the resume button instead of a dead end', async () => {
    const h = harness();
    const { conv } = await seedPrOpen(h);
    await message(h, conv.id);
    const offer = h.rendered.at(-1) as { type: string; actions: Array<{ actionId: string }> };
    expect(offer.type).toBe('post_actions');
    expect(offer.actions).toEqual([expect.objectContaining({ actionId: 'resume-work' })]);
  });

  it('resumes a released unit with a fresh env cloned from the PR branch', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h);
    await h.repos.workUnits.releaseEnv(wu.id); // the M18 release happened

    await resume(h, conv.id);

    // Re-provisioned at ref = the PR branch, not the repo default.
    expect(h.sandbox.createEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: 'https://github.com/a/b.git',
        ref: `devspace/${wu.id}`,
      }),
    );
    const after = await h.repos.workUnits.get(wu.id);
    expect(after?.state).toBe('WORKING');
    expect(after?.envId).toBe('env_1');
    expect(after?.agentSessionId).toBeUndefined(); // created lazily by the next message
    expect(after?.prNumber).toBe(42); // the PR association survives the resume

    const audit = await h.repos.audit.listByConversation(conv.id);
    expect(audit.find((a) => a.action === 'session.resumed')?.detail).toEqual({
      envId: 'env_1',
      reprovisioned: true,
    });
    expect(h.rendered.at(-1)).toMatchObject({
      type: 'update_status',
      state: 'WORKING',
      text: expect.stringContaining('resumed'),
    });
  });

  it('the next message creates ONE agent session and persists it', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h);
    await h.repos.workUnits.releaseEnv(wu.id);
    await resume(h, conv.id);
    const createSession = vi.spyOn(h.agent, 'createSession');

    await message(h, conv.id);
    expect(createSession).toHaveBeenCalledTimes(1);
    // The regression the advance-drop would cause: the id must land on the
    // row, or every later message would mint another orphan ACP session.
    expect((await h.repos.workUnits.get(wu.id))?.agentSessionId).toBe('as_1');

    await message(h, conv.id, 'and another thing');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('resumes in place when the environment is still alive', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h); // envId env_1, agentSessionId as_1 intact

    await resume(h, conv.id);

    expect(h.sandbox.createEnvironment).not.toHaveBeenCalled();
    const after = await h.repos.workUnits.get(wu.id);
    expect(after?.state).toBe('WORKING');
    expect(after?.envId).toBe('env_1');
    expect(after?.agentSessionId).toBe('as_1'); // env and session die together — both live
    const audit = await h.repos.audit.listByConversation(conv.id);
    expect(audit.find((a) => a.action === 'session.resumed')?.detail).toEqual({
      envId: 'env_1',
      reprovisioned: false,
    });

    // The live session is reused — no new one is created.
    const createSession = vi.spyOn(h.agent, 'createSession');
    await message(h, conv.id);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('a stale envId re-provisions — resume trusts the host, not the row', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h); // row still carries env_1
    (h.sandbox.getEnvironment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new SandboxError('NOT_FOUND', 'no such environment: env_1'),
    );

    await resume(h, conv.id);

    expect(h.sandbox.createEnvironment).toHaveBeenCalledOnce();
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');
  });

  it('a failed provisioning leaves the unit PR_OPEN and the button retries', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h);
    await h.repos.workUnits.releaseEnv(wu.id);
    (h.sandbox.createEnvironment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('no capacity'),
    );

    await resume(h, conv.id);
    const after = await h.repos.workUnits.get(wu.id);
    expect(after?.state).toBe('PR_OPEN'); // never FAILED — GitHub owns this lifecycle
    expect(after?.envId).toBeUndefined();
    expect((h.rendered.at(-1) as { text: string }).text).toContain('Could not resume');
    const audit = await h.repos.audit.listByConversation(conv.id);
    expect(audit.some((a) => a.action === 'session.resumed')).toBe(false);

    await resume(h, conv.id); // the retry succeeds
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');
  });

  it('a lost transition race destroys the freshly provisioned env', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h);
    await h.repos.workUnits.releaseEnv(wu.id);
    vi.spyOn(h.repos.workUnits, 'transition').mockRejectedValueOnce(
      new Error('unit advanced by a sibling'),
    );

    await resume(h, conv.id);

    // The env id was never persisted — leaving it would leak the container.
    expect(h.sandbox.destroyEnvironment).toHaveBeenCalledWith('env_1');
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_OPEN');
    expect((h.rendered.at(-1) as { text: string }).text).toContain('Could not resume');
  });

  it('drops a bus PR event for a resumed unit; the poll re-detects after suspend', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h);
    await resume(h, conv.id);

    const evt = await h.repos.events.append({
      topic: TOPIC_PR_MERGED,
      workUnitId: wu.id,
      payload: {},
    });
    // Pre-M19 this threw IllegalTransition — a bus handler that throws
    // redelivers forever. Now it drops.
    await expect(h.orch.handleBusEvent(evt)).resolves.toBeUndefined();
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');

    // Back in PR_OPEN (the reaper's suspend), the same publish lands.
    await h.repos.workUnits.transition(wu.id, 'suspend');
    await h.orch.handleBusEvent(evt);
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_MERGED');
  });

  it('create-pr after resume re-pushes and returns to PR_OPEN', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h);
    await resume(h, conv.id);

    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: conv.id,
      userId: 'u1',
      actionId: 'create-pr',
      payload: {},
    });
    const after = await h.repos.workUnits.get(wu.id);
    expect(after?.state).toBe('PR_OPEN');
    expect(after?.prNumber).toBe(42);
  });

  it('refuses to resume a settled unit, and answers gently when already active', async () => {
    const h = harness();
    const { conv, wu } = await seedPrOpen(h);
    await resume(h, conv.id);
    await resume(h, conv.id); // double click
    expect((h.rendered.at(-1) as { text: string }).text).toContain('already active');
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');

    await h.repos.workUnits.transition(wu.id, 'suspend');
    await h.repos.workUnits.transition(wu.id, 'prMerged');
    await resume(h, conv.id);
    expect((h.rendered.at(-1) as { text: string }).text).toContain('finished');
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_MERGED');
    expect(h.sandbox.createEnvironment).not.toHaveBeenCalled();
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

describe('listSessions (M6)', () => {
  it("joins a user's conversations with their work-unit state", async () => {
    const h = harness();
    await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C1:1',
      userId: 'u1',
      repoChoice: { repoUrl: 'https://github.com/a/b', empty: false },
    });
    await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C1:2',
      userId: 'u1',
    });
    await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C1:3',
      userId: 'u2',
    });

    const sessions = await h.orch.listSessions('slack', 'u1');
    expect(sessions).toHaveLength(2);
    const byChannel = new Map(sessions.map((s) => [s.externalChannelId, s]));
    expect(byChannel.get('C1:1')).toMatchObject({
      state: 'READY',
      repoUrl: 'https://github.com/a/b',
      platform: 'slack',
      conversationId: expect.stringContaining('conv'),
    });
    expect(byChannel.get('C1:2')).toMatchObject({ state: 'CREATED' });
    await expect(h.orch.listSessions('slack', 'u3')).resolves.toEqual([]);
  });
});

describe('expose-port (M6)', () => {
  async function readyConversation(h: Harness): Promise<string> {
    const created = (await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C1:1',
      userId: 'u1',
      repoChoice: { repoUrl: 'https://github.com/a/b', empty: false },
    })) as { conversationId: string };
    return created.conversationId;
  }

  it('forwards the port, audits, and renders the capability URL', async () => {
    const h = harness();
    (h.sandbox.forwardPort as ReturnType<typeof vi.fn>).mockResolvedValue({
      proxyUrl: 'http://preview:4010/t/tok123/',
      token: 'tok123',
    });
    const conversationId = await readyConversation(h);

    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId,
      userId: 'u1',
      actionId: 'expose-port:3000',
      payload: {},
    });

    expect(h.sandbox.forwardPort).toHaveBeenCalledWith('env_1', 3000);
    const last = h.rendered.at(-1);
    expect(last).toMatchObject({ type: 'post_message' });
    expect((last as { text: string }).text).toContain('http://preview:4010/t/tok123/');

    const audits = await h.repos.audit.listByConversation(conversationId);
    const exposed = audits.find((a) => a.action === 'port.exposed');
    expect(exposed?.detail).toEqual({ envId: 'env_1', port: 3000 });
    // The capability token never lands in the audit trail.
    expect(JSON.stringify(exposed)).not.toContain('tok123');
  });

  it('refuses before an environment exists', async () => {
    const h = harness();
    const created = (await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C1:2',
      userId: 'u1',
    })) as { conversationId: string };

    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId: created.conversationId,
      userId: 'u1',
      actionId: 'expose-port:3000',
      payload: {},
    });
    expect(h.sandbox.forwardPort).not.toHaveBeenCalled();
    expect((h.rendered.at(-1) as { text: string }).text).toContain('No running environment');
  });

  it('refuses after the work unit is finished', async () => {
    const h = harness();
    const conversationId = await readyConversation(h);
    await h.orch.teardown(conversationId);

    await h.orch.handleChatEvent({
      type: 'action.invoked',
      conversationId,
      userId: 'u1',
      actionId: 'expose-port:3000',
      payload: {},
    });
    expect(h.sandbox.forwardPort).not.toHaveBeenCalled();
    expect((h.rendered.at(-1) as { text: string }).text).toContain('finished');
  });

  it('surfaces a forwardPort failure as a message, never a throw', async () => {
    const h = harness();
    (h.sandbox.forwardPort as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('preview proxy not configured'),
    );
    const conversationId = await readyConversation(h);

    await expect(
      h.orch.handleChatEvent({
        type: 'action.invoked',
        conversationId,
        userId: 'u1',
        actionId: 'expose-port:3000',
        payload: {},
      }),
    ).resolves.toBeUndefined();
    expect((h.rendered.at(-1) as { text: string }).text).toContain('Could not expose port 3000');
  });
});

describe('secret.submitted (M6)', () => {
  const created = async (h: Harness): Promise<string> => {
    const res = (await h.orch.handleChatEvent({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: 'C1:1',
      userId: 'u1',
    })) as { conversationId: string };
    return res.conversationId;
  };

  it('stores the value encrypted, audits the name only, and confirms without the value', async () => {
    const h = harness();
    const conversationId = await created(h);
    await h.orch.handleChatEvent({
      type: 'secret.submitted',
      conversationId,
      userId: 'u1',
      name: 'LLM_KEY',
      value: 'sk-live-submitted-via-modal',
    });

    // Stored and resolvable through the envelope store.
    await expect(h.store.resolve('u1', 'LLM_KEY', conversationId)).resolves.toBe(
      'sk-live-submitted-via-modal',
    );
    // At rest it is ciphertext, not plaintext.
    const rec = await h.repos.secrets.get('u1', 'LLM_KEY', conversationId);
    expect(rec?.ciphertext).not.toContain('sk-live-submitted-via-modal');

    // Audit carries the name and NEVER the value.
    const audits = await h.repos.audit.listByConversation(conversationId);
    const stored = audits.find((a) => a.action === 'secret.stored');
    expect(stored?.detail).toEqual({ name: 'LLM_KEY' });
    expect(JSON.stringify(audits)).not.toContain('sk-live-submitted-via-modal');

    // The confirmation message names the secret but not the value.
    const confirm = h.rendered.at(-1) as { type: string; text: string };
    expect(confirm).toMatchObject({ type: 'post_message' });
    expect(confirm.text).toContain('LLM_KEY');
    expect(confirm.text).not.toContain('sk-live-submitted-via-modal');
  });

  it('registers the plaintext immediately: an echo in the SAME conversation is redacted', async () => {
    const value = 'sk-live-echo-me-please';
    const agent = fakeAgent([{ type: 'message', text: `your key is ${value}` }]);
    const h = harness({ agent });
    const conversationId = (
      (await h.orch.handleChatEvent({
        type: 'conversation.created',
        platform: 'slack',
        externalChannelId: 'C1:1',
        userId: 'u1',
        repoChoice: { repoUrl: 'https://github.com/a/b', empty: false },
      })) as { conversationId: string }
    ).conversationId;

    await h.orch.handleChatEvent({
      type: 'secret.submitted',
      conversationId,
      userId: 'u1',
      name: 'LLM_KEY',
      value,
    });
    await h.orch.handleChatEvent({
      type: 'message.posted',
      conversationId,
      userId: 'u1',
      text: 'go',
    });

    const echoed = h.rendered.filter(
      (c): c is Extract<typeof c, { type: 'post_message' }> => c.type === 'post_message',
    );
    expect(echoed.some((c) => c.text.includes('your key is'))).toBe(true);
    expect(JSON.stringify(h.rendered)).not.toContain(value);
  });

  it('rejects a submission from a non-owner', async () => {
    const h = harness();
    const conversationId = await created(h);
    await expect(
      h.orch.handleChatEvent({
        type: 'secret.submitted',
        conversationId,
        userId: 'intruder',
        name: 'GITHUB_TOKEN',
        value: 'ghp_stolen',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await h.repos.secrets.get('intruder', 'GITHUB_TOKEN', conversationId)).toBeNull();
  });

  it('posts the set-secrets entry point with the conversation status (M6-D)', async () => {
    const h = harness();
    await created(h);
    const actionsCmd = h.rendered.find((c) => c.type === 'post_actions') as {
      actions: Array<{ actionId: string }>;
    };
    expect(actionsCmd).toBeTruthy();
    expect(actionsCmd.actions).toEqual([expect.objectContaining({ actionId: 'set-secrets' })]);
  });
});
