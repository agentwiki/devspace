/**
 * Lifecycle reclamation (M17): the policy parser and the reaper's sweep over
 * the in-memory repositories with a hand-driven clock. The election loop the
 * reaper runs under is covered by election.test.ts — here we prove the sweep
 * itself honors the policy, the exemptions, and teardown's invariants.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Environment, RenderCommand, WorkEvent } from '@devspace/contracts';
import { createInMemoryRepositories, type Repositories } from '@devspace/db';
import { SandboxError, type SandboxCore } from '@devspace/sandbox-core';
import type { AgentRunner } from '@devspace/agent-runner';
import { Orchestrator, SECRET_GH_TOKEN, SECRET_LLM_KEY } from './index.js';
import { approxDuration, reapPolicyFromEnv } from './reaper.js';
import { generateKeyEntry, parseKeyring, SecretStore } from './secrets.js';

const KEY = generateKeyEntry('k1');
const HOUR = 3_600_000;

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

interface Harness {
  orch: Orchestrator;
  repos: Repositories;
  store: SecretStore;
  rendered: RenderCommand[];
  sandbox: SandboxCore;
  clock: { set: (ms: number) => void };
}

function harness(): Harness {
  let tick = 0;
  const repos = createInMemoryRepositories(() => new Date(tick).toISOString());
  const store = new SecretStore(repos.secrets, parseKeyring(KEY));
  const rendered: RenderCommand[] = [];
  const sandbox = fakeSandbox();
  const orch = new Orchestrator({
    repos,
    sandbox,
    agents: {
      createSession: vi.fn(),
      runTurn: vi.fn(),
      decidePermission: vi.fn(),
    } as unknown as AgentRunner,
    secrets: store,
    git: { run: async () => ({ stdout: '', stderr: '', code: 0 }) },
    githubRest: () =>
      ({
        createPull: vi.fn(),
        listOpenPullsByHead: vi.fn(),
        getPull: vi.fn(),
      }) as never,
    render: async (c) => {
      rendered.push(c);
    },
  });
  return { orch, repos, store, rendered, sandbox, clock: { set: (ms) => (tick = ms) } };
}

/** Seed a conversation + work unit walked to `state` at the current clock. */
async function seedAt(h: Harness, state: string, channel: string) {
  const conv = await h.repos.conversations.create({
    platform: 'slack',
    externalChannelId: channel,
    userId: 'u1',
  });
  let wu = await h.repos.workUnits.create({ conversationId: conv.id });
  await h.store.put('u1', conv.id, SECRET_LLM_KEY, 'sk-llm');
  await h.store.put('u1', conv.id, SECRET_GH_TOKEN, 'ghs_push_token');
  const walk: Array<[string, WorkEvent]> = [
    ['PROVISIONING', 'repoChoice'],
    ['READY', 'envReady'],
    ['WORKING', 'firstMessage'],
    ['PRE_PR', 'committedAndPushed'],
    ['PR_OPEN', 'prCreated'],
    ['PR_MERGED', 'prMerged'],
  ];
  for (const [target, event] of walk) {
    if (wu.state === state) break;
    const patch =
      event === 'repoChoice'
        ? { repoUrl: 'https://github.com/a/b.git', branch: `devspace/${wu.id}` }
        : event === 'envReady'
          ? { envId: 'env_1' }
          : event === 'firstMessage'
            ? { agentSessionId: 'as_1' }
            : event === 'prCreated'
              ? { prNumber: 1, prUrl: 'https://github.com/a/b/pull/1' }
              : {};
    wu = await h.repos.workUnits.transition(wu.id, event, patch);
    void target;
  }
  return { conv, wu };
}

describe('reapPolicyFromEnv', () => {
  it('is off when no TTL knob is set', () => {
    expect(reapPolicyFromEnv({})).toBeUndefined();
    expect(reapPolicyFromEnv({ DEVSPACE_IDLE_TTL_MS: '' })).toBeUndefined();
  });

  it('enables per knob, with a default interval', () => {
    expect(reapPolicyFromEnv({ DEVSPACE_IDLE_TTL_MS: '3600000' })).toEqual({
      idleTtlMs: 3_600_000,
      terminalGraceMs: undefined,
      intervalMs: 60_000,
    });
    expect(
      reapPolicyFromEnv({
        DEVSPACE_TERMINAL_GRACE_MS: '900000',
        DEVSPACE_REAP_INTERVAL_MS: '30000',
      }),
    ).toEqual({ idleTtlMs: undefined, terminalGraceMs: 900_000, intervalMs: 30_000 });
  });

  it('refuses garbage and non-positive values loudly', () => {
    expect(() => reapPolicyFromEnv({ DEVSPACE_IDLE_TTL_MS: 'soon' })).toThrow(/positive integer/);
    expect(() => reapPolicyFromEnv({ DEVSPACE_IDLE_TTL_MS: '0' })).toThrow(/positive integer/);
    expect(() => reapPolicyFromEnv({ DEVSPACE_TERMINAL_GRACE_MS: '-5' })).toThrow(
      /positive integer/,
    );
  });

  it('refuses an interval with nothing to reap (dead knob)', () => {
    expect(() => reapPolicyFromEnv({ DEVSPACE_REAP_INTERVAL_MS: '30000' })).toThrow(
      /reaps nothing/,
    );
  });

  it('carries the warn window on the policy (M18)', () => {
    expect(
      reapPolicyFromEnv({ DEVSPACE_IDLE_TTL_MS: '3600000', DEVSPACE_IDLE_WARN_MS: '600000' }),
    ).toEqual({
      idleTtlMs: 3_600_000,
      idleWarnMs: 600_000,
      terminalGraceMs: undefined,
      intervalMs: 60_000,
    });
  });

  it('refuses a warn window without an idle TTL, or one at/over it (M18)', () => {
    expect(() => reapPolicyFromEnv({ DEVSPACE_IDLE_WARN_MS: '600000' })).toThrow(
      /no TTL to warn ahead of/,
    );
    expect(() =>
      reapPolicyFromEnv({ DEVSPACE_IDLE_TTL_MS: '600000', DEVSPACE_IDLE_WARN_MS: '600000' }),
    ).toThrow(/must be smaller/);
    expect(() => reapPolicyFromEnv({ DEVSPACE_IDLE_WARN_MS: 'soon' })).toThrow(/positive integer/);
  });

  it('the PR_OPEN env TTL is a third independent enabler (M18)', () => {
    expect(reapPolicyFromEnv({ DEVSPACE_PR_OPEN_ENV_TTL_MS: '86400000' })).toEqual({
      idleTtlMs: undefined,
      idleWarnMs: undefined,
      terminalGraceMs: undefined,
      prOpenEnvTtlMs: 86_400_000,
      intervalMs: 60_000,
    });
    expect(() => reapPolicyFromEnv({ DEVSPACE_PR_OPEN_ENV_TTL_MS: '-1' })).toThrow(
      /positive integer/,
    );
  });
});

describe('approxDuration', () => {
  it('renders chat-grade durations', () => {
    expect(approxDuration(30_000)).toBe('30s');
    expect(approxDuration(900_000)).toBe('15m');
    expect(approxDuration(5_400_000)).toBe('1.5h');
  });
});

describe('reapExpired (M17)', () => {
  it('tears an idle WORKING unit down: env, secrets, notice, audit reason', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'WORKING', 'C1');
    await h.repos.workUnits.touch(wu.id); // active at t=0

    // Inside the TTL nothing happens…
    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, HOUR - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');

    // …at the TTL the unit dies the way a user-ended one would.
    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, HOUR)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('TORN_DOWN');
    expect(h.sandbox.destroyEnvironment).toHaveBeenCalledWith('env_1');
    expect(await h.repos.secrets.get('u1', SECRET_LLM_KEY, conv.id)).toBeNull();
    expect(await h.repos.secrets.get('u1', SECRET_GH_TOKEN, conv.id)).toBeNull();
    // The thread was told BEFORE the env died.
    expect(h.rendered).toContainEqual(
      expect.objectContaining({
        type: 'update_status',
        conversationId: conv.id,
        state: 'TORN_DOWN',
        text: expect.stringContaining('inactivity'),
      }),
    );
    const audit = await h.repos.audit.listByConversation(conv.id);
    expect(audit.find((a) => a.action === 'teardown')?.detail).toMatchObject({ reason: 'idle' });
    // A second sweep is a no-op — teardown's idempotency holds for the reaper.
    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, 2 * HOUR)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
  });

  it('fresh tenant activity defers the idle clock past a stale transition', async () => {
    const h = harness();
    const { wu } = await seedAt(h, 'WORKING', 'C2'); // transitions at t=0
    h.clock.set(5 * HOUR);
    await h.repos.workUnits.touch(wu.id); // the user spoke at t=5h

    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, 5 * HOUR + HOUR - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');
  });

  it('a fresh transition counts as life before the first touch', async () => {
    const h = harness();
    h.clock.set(10 * HOUR);
    const { wu } = await seedAt(h, 'READY', 'C3'); // updatedAt = 10h, never touched
    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, 10 * HOUR + HOUR - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, 11 * HOUR)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('TORN_DOWN');
  });

  it('PR_OPEN is exempt from both policies — GitHub owns that lifecycle', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'PR_OPEN', 'C4');
    expect(
      await h.orch.reapExpired({ idleTtlMs: HOUR, terminalGraceMs: HOUR }, 100 * HOUR),
    ).toEqual({ reaped: 0, warned: 0, suspended: 0, released: 0, failed: 0 });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_OPEN');
    // The reconciler's token survives with the unit.
    expect(await h.repos.secrets.get('u1', SECRET_GH_TOKEN, conv.id)).not.toBeNull();
  });

  it('collects a terminal unit past the grace, silently', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'PR_MERGED', 'C5'); // updatedAt = 0
    expect(await h.orch.reapExpired({ terminalGraceMs: HOUR }, HOUR - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(await h.orch.reapExpired({ terminalGraceMs: HOUR }, HOUR)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('TORN_DOWN');
    expect(h.rendered).toEqual([]); // the thread already ended with its PR status
    const audit = await h.repos.audit.listByConversation(conv.id);
    expect(audit.find((a) => a.action === 'teardown')?.detail).toMatchObject({
      reason: 'expired',
    });
  });

  it('each knob reaps only its class', async () => {
    const h = harness();
    const idle = await seedAt(h, 'WORKING', 'C6');
    const done = await seedAt(h, 'PR_MERGED', 'C7');

    expect(await h.orch.reapExpired({ terminalGraceMs: HOUR }, 100 * HOUR)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(idle.wu.id))?.state).toBe('WORKING');
    expect((await h.repos.workUnits.get(done.wu.id))?.state).toBe('TORN_DOWN');

    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, 100 * HOUR)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(idle.wu.id))?.state).toBe('TORN_DOWN');
  });

  it('one failing teardown never stops the sweep', async () => {
    const h = harness();
    await seedAt(h, 'WORKING', 'C8');
    const second = await seedAt(h, 'WORKING', 'C9');
    vi.spyOn(h.orch, 'teardown').mockRejectedValueOnce(new Error('db down'));

    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, 100 * HOUR)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 1,
    });
    expect((await h.repos.workUnits.get(second.wu.id))?.state).toBe('TORN_DOWN');
  });
});

describe('idle warnings (M18)', () => {
  const MIN = 60_000;
  // Warning window opens 15m before the hour TTL.
  const POLICY = { idleTtlMs: HOUR, idleWarnMs: 15 * MIN };

  it('warns once inside the window, then reaps at the TTL', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'WORKING', 'W1'); // alive at t=0

    // Before the window: nothing.
    expect(await h.orch.reapExpired(POLICY, 45 * MIN - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    // Window open: one warning, recorded on the row.
    h.clock.set(45 * MIN);
    expect(await h.orch.reapExpired(POLICY, 45 * MIN)).toEqual({
      reaped: 0,
      warned: 1,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(h.rendered).toContainEqual(
      expect.objectContaining({
        type: 'post_message',
        conversationId: conv.id,
        text: expect.stringContaining('reclaimed in about 15m'),
      }),
    );
    expect((await h.repos.workUnits.get(wu.id))?.idleWarnedAt).toBe(
      new Date(45 * MIN).toISOString(),
    );
    // A later sweep inside the window does not re-warn.
    h.clock.set(50 * MIN);
    expect(await h.orch.reapExpired(POLICY, 50 * MIN)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    // At the TTL the unit dies — the warning has stood for the full window.
    h.clock.set(60 * MIN);
    expect(await h.orch.reapExpired(POLICY, 60 * MIN)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('TORN_DOWN');
  });

  it('tenant activity after a warning invalidates it — the cycle restarts', async () => {
    const h = harness();
    const { wu } = await seedAt(h, 'WORKING', 'W2'); // alive at t=0
    h.clock.set(45 * MIN);
    await h.orch.reapExpired(POLICY, 45 * MIN); // warned at 45m

    h.clock.set(50 * MIN);
    await h.repos.workUnits.touch(wu.id); // the user speaks at 50m

    // Past the ORIGINAL TTL: the warning predates the activity — no reap.
    expect(await h.orch.reapExpired(POLICY, 60 * MIN)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    // The window reopens off the new activity clock (50m + 45m)…
    expect(await h.orch.reapExpired(POLICY, 95 * MIN - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    h.clock.set(95 * MIN);
    expect(await h.orch.reapExpired(POLICY, 95 * MIN)).toEqual({
      reaped: 0,
      warned: 1,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    // …and the reap honors the fresh warning's full window.
    expect(await h.orch.reapExpired(POLICY, 110 * MIN - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(await h.orch.reapExpired(POLICY, 110 * MIN)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
  });

  it('a unit discovered past the TTL is warned first, reaped a full window later', async () => {
    const h = harness();
    const { wu } = await seedAt(h, 'WORKING', 'W3'); // alive at t=0

    // First sweep lands at 10h — way past the TTL, but never warned: warn, don't reap.
    h.clock.set(10 * HOUR);
    expect(await h.orch.reapExpired(POLICY, 10 * HOUR)).toEqual({
      reaped: 0,
      warned: 1,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');
    // The reap waits out the whole window from the warning, not the TTL.
    expect(await h.orch.reapExpired(POLICY, 10 * HOUR + 15 * MIN - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(await h.orch.reapExpired(POLICY, 10 * HOUR + 15 * MIN)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
  });

  it('a failed warning mark counts as failed and re-warns next sweep', async () => {
    const h = harness();
    const { conv } = await seedAt(h, 'WORKING', 'W4');
    vi.spyOn(h.repos.workUnits, 'markIdleWarned').mockRejectedValueOnce(new Error('db down'));

    h.clock.set(45 * MIN);
    expect(await h.orch.reapExpired(POLICY, 45 * MIN)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 1,
    });
    // The retry re-posts once — annoying beats unwarned (m18-plan Decision 3).
    h.clock.set(46 * MIN);
    expect(await h.orch.reapExpired(POLICY, 46 * MIN)).toEqual({
      reaped: 0,
      warned: 1,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    const warnings = h.rendered.filter(
      (c) => c.type === 'post_message' && c.conversationId === conv.id,
    );
    expect(warnings).toHaveLength(2);
  });

  it('warnings cover only the idle class — terminal collection stays silent', async () => {
    const h = harness();
    const { conv } = await seedAt(h, 'PR_MERGED', 'W5'); // terminal at t=0
    expect(await h.orch.reapExpired({ ...POLICY, terminalGraceMs: HOUR }, 50 * MIN)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(await h.orch.reapExpired({ ...POLICY, terminalGraceMs: HOUR }, HOUR)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(h.rendered.filter((c) => c.conversationId === conv.id)).toEqual([]);
  });
});

describe('PR_OPEN env release (M18)', () => {
  const DAY = 24 * HOUR;
  const POLICY = { prOpenEnvTtlMs: DAY };

  it('releases the env past the TTL — the unit, secrets, and PR flow survive', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'PR_OPEN', 'P1'); // alive at t=0

    // Within the TTL: untouched.
    expect(await h.orch.reapExpired(POLICY, DAY - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(h.sandbox.destroyEnvironment).not.toHaveBeenCalled();

    // Past it: the container dies, the unit lives on.
    expect(await h.orch.reapExpired(POLICY, DAY)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 1,
      failed: 0,
    });
    expect(h.sandbox.destroyEnvironment).toHaveBeenCalledWith('env_1');
    const after = await h.repos.workUnits.get(wu.id);
    expect(after?.state).toBe('PR_OPEN');
    expect(after?.envId).toBeUndefined();
    expect(after?.agentSessionId).toBeUndefined();
    expect(after?.prNumber).toBe(1); // the reconciler's input is intact
    // The reconciler's token survives with the unit.
    expect(await h.repos.secrets.get('u1', SECRET_GH_TOKEN, conv.id)).not.toBeNull();
    // One notice, stating an accomplished fact — carrying the way back (M19).
    expect(h.rendered).toContainEqual(
      expect.objectContaining({
        type: 'post_actions',
        conversationId: conv.id,
        text: expect.stringContaining('Environment released'),
        actions: [expect.objectContaining({ actionId: 'resume-work' })],
      }),
    );
    const audit = await h.repos.audit.listByConversation(conv.id);
    expect(audit.find((a) => a.action === 'env.released')?.detail).toMatchObject({
      envId: 'env_1',
      reason: 'idle',
    });

    // A later sweep is a no-op — nothing left to release.
    expect(await h.orch.reapExpired(POLICY, 2 * DAY)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
  });

  it('tenant activity defers the release like every other reclamation', async () => {
    const h = harness();
    const { wu } = await seedAt(h, 'PR_OPEN', 'P2'); // transitions at t=0
    h.clock.set(5 * DAY);
    await h.repos.workUnits.touch(wu.id); // e.g. a view-pr click at t=5d

    expect(await h.orch.reapExpired(POLICY, 5 * DAY + DAY - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.envId).toBe('env_1');
  });

  it('NOT_FOUND from the destroy still releases — the env is already gone', async () => {
    const h = harness();
    const { wu } = await seedAt(h, 'PR_OPEN', 'P3');
    vi.mocked(h.sandbox.destroyEnvironment).mockRejectedValueOnce(
      new SandboxError('NOT_FOUND', 'no such environment: env_1'),
    );

    expect(await h.orch.reapExpired(POLICY, 2 * DAY)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 1,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.envId).toBeUndefined();
  });

  it('any other destroy failure keeps envId and retries — one notice total', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'PR_OPEN', 'P4');
    vi.mocked(h.sandbox.destroyEnvironment).mockRejectedValueOnce(new Error('host down'));

    expect(await h.orch.reapExpired(POLICY, 2 * DAY)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 1,
    });
    // The pointer survives the failure so the next sweep can retry the destroy…
    expect((await h.repos.workUnits.get(wu.id))?.envId).toBe('env_1');
    // …and no notice announced a release that did not happen.
    expect(h.rendered.filter((c) => c.conversationId === conv.id)).toEqual([]);

    expect(await h.orch.reapExpired(POLICY, 2 * DAY + 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 1,
      failed: 0,
    });
    expect(
      h.rendered.filter((c) => c.type === 'post_actions' && c.conversationId === conv.id),
    ).toHaveLength(1);
  });

  it('the terminal grace still collects a released unit', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'PR_OPEN', 'P5');
    await h.orch.reapExpired(POLICY, 2 * DAY); // released
    vi.mocked(h.sandbox.destroyEnvironment).mockClear();

    h.clock.set(3 * DAY);
    await h.repos.workUnits.transition(wu.id, 'prMerged'); // the PR merges at t=3d
    expect(await h.orch.reapExpired({ terminalGraceMs: HOUR }, 3 * DAY + HOUR)).toEqual({
      reaped: 1,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('TORN_DOWN');
    // teardown had no env left to destroy — and the secrets are gone now.
    expect(h.sandbox.destroyEnvironment).not.toHaveBeenCalled();
    expect(await h.repos.secrets.get('u1', SECRET_GH_TOKEN, conv.id)).toBeNull();
  });
});

describe('suspension of resumed units (M19)', () => {
  const POLICY = { idleTtlMs: HOUR };

  /** Seed to PR_OPEN and resume it — a WORKING unit carrying its prNumber. */
  async function seedResumed(h: Harness, channel: string) {
    const { conv, wu } = await seedAt(h, 'PR_OPEN', channel);
    const resumed = await h.repos.workUnits.transition(wu.id, 'resume', { envId: 'env_1' });
    return { conv, wu: resumed };
  }

  it('suspends an idle resumed unit back to PR_OPEN — never a teardown', async () => {
    const h = harness();
    const { conv, wu } = await seedResumed(h, 'S1'); // alive at t=0

    // Within the TTL: untouched.
    expect(await h.orch.reapExpired(POLICY, HOUR - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });

    // At the TTL: the env goes, the unit returns to waiting on its PR.
    expect(await h.orch.reapExpired(POLICY, HOUR)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 1,
      released: 0,
      failed: 0,
    });
    expect(h.sandbox.destroyEnvironment).toHaveBeenCalledWith('env_1');
    const after = await h.repos.workUnits.get(wu.id);
    expect(after?.state).toBe('PR_OPEN');
    expect(after?.envId).toBeUndefined();
    expect(after?.agentSessionId).toBeUndefined();
    expect(after?.prNumber).toBe(1); // the reconciler's input is intact
    // Secrets survive — the unit is alive and its PR still needs the token.
    expect(await h.repos.secrets.get('u1', SECRET_GH_TOKEN, conv.id)).not.toBeNull();
    const audit = await h.repos.audit.listByConversation(conv.id);
    expect(audit.find((a) => a.action === 'session.suspended')?.detail).toEqual({
      envId: 'env_1',
      reason: 'idle',
    });
    expect(audit.some((a) => a.action === 'teardown')).toBe(false);
    // One notice, carrying the way back.
    expect(h.rendered).toContainEqual(
      expect.objectContaining({
        type: 'post_actions',
        conversationId: conv.id,
        text: expect.stringContaining('paused'),
        actions: [expect.objectContaining({ actionId: 'resume-work' })],
      }),
    );

    // A later sweep finds a PR_OPEN unit with no env — nothing left to do.
    expect(await h.orch.reapExpired(POLICY, 2 * HOUR)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
  });

  it('a non-NOT_FOUND destroy failure keeps the unit WORKING and retries — one notice', async () => {
    const h = harness();
    const { conv, wu } = await seedResumed(h, 'S2');
    vi.mocked(h.sandbox.destroyEnvironment).mockRejectedValueOnce(new Error('host down'));

    expect(await h.orch.reapExpired(POLICY, 2 * HOUR)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 1,
    });
    // The pointer survives so the next sweep retries the destroy…
    const after = await h.repos.workUnits.get(wu.id);
    expect(after?.state).toBe('WORKING');
    expect(after?.envId).toBe('env_1');
    // …and nothing announced a suspension that did not happen.
    expect(h.rendered.filter((c) => c.conversationId === conv.id)).toEqual([]);

    expect(await h.orch.reapExpired(POLICY, 2 * HOUR + 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 1,
      released: 0,
      failed: 0,
    });
    expect(h.rendered.filter((c) => c.conversationId === conv.id)).toHaveLength(1);
  });

  it('NOT_FOUND from the destroy still suspends — the env is already gone', async () => {
    const h = harness();
    const { wu } = await seedResumed(h, 'S3');
    vi.mocked(h.sandbox.destroyEnvironment).mockRejectedValueOnce(
      new SandboxError('NOT_FOUND', 'no such environment: env_1'),
    );

    expect(await h.orch.reapExpired(POLICY, 2 * HOUR)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 1,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_OPEN');
  });

  it('an envless resumed unit still suspends (the crash-between-writes retry)', async () => {
    const h = harness();
    const { wu } = await seedResumed(h, 'S4');
    // A prior sweep crashed after releaseEnv but before the transition.
    await h.repos.workUnits.releaseEnv(wu.id);

    expect(await h.orch.reapExpired(POLICY, 2 * HOUR)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 1,
      released: 0,
      failed: 0,
    });
    expect(h.sandbox.destroyEnvironment).not.toHaveBeenCalled();
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_OPEN');
  });

  it('the warning discipline covers suspension too, with paused wording', async () => {
    const MIN = 60_000;
    const h = harness();
    const { conv, wu } = await seedResumed(h, 'S5'); // alive at t=0
    const policy = { idleTtlMs: HOUR, idleWarnMs: 15 * MIN };

    // Window open: one warning that says paused, not reclaimed.
    h.clock.set(45 * MIN);
    expect(await h.orch.reapExpired(policy, 45 * MIN)).toEqual({
      reaped: 0,
      warned: 1,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    expect(h.rendered).toContainEqual(
      expect.objectContaining({
        type: 'post_message',
        conversationId: conv.id,
        text: expect.stringContaining('paused in about 15m'),
      }),
    );
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');

    // No unwarned reclamation: the suspension waits out the full window.
    expect(await h.orch.reapExpired(policy, 60 * MIN - 1)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 0,
      released: 0,
      failed: 0,
    });
    h.clock.set(60 * MIN);
    expect(await h.orch.reapExpired(policy, 60 * MIN)).toEqual({
      reaped: 0,
      warned: 0,
      suspended: 1,
      released: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_OPEN');
  });
});
