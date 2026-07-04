/**
 * Lifecycle reclamation (M17): the policy parser and the reaper's sweep over
 * the in-memory repositories with a hand-driven clock. The election loop the
 * reaper runs under is covered by election.test.ts — here we prove the sweep
 * itself honors the policy, the exemptions, and teardown's invariants.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Environment, RenderCommand, WorkEvent } from '@devspace/contracts';
import { createInMemoryRepositories, type Repositories } from '@devspace/db';
import type { SandboxCore } from '@devspace/sandbox-core';
import type { AgentRunner } from '@devspace/agent-runner';
import { Orchestrator, SECRET_GH_TOKEN, SECRET_LLM_KEY } from './index.js';
import { reapPolicyFromEnv } from './reaper.js';
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
});

describe('reapExpired (M17)', () => {
  it('tears an idle WORKING unit down: env, secrets, notice, audit reason', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'WORKING', 'C1');
    await h.repos.workUnits.touch(wu.id); // active at t=0

    // Inside the TTL nothing happens…
    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, HOUR - 1)).toEqual({
      reaped: 0,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('WORKING');

    // …at the TTL the unit dies the way a user-ended one would.
    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, HOUR)).toEqual({ reaped: 1, failed: 0 });
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
      failed: 0,
    });
    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, 11 * HOUR)).toEqual({
      reaped: 1,
      failed: 0,
    });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('TORN_DOWN');
  });

  it('PR_OPEN is exempt from both policies — GitHub owns that lifecycle', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'PR_OPEN', 'C4');
    expect(
      await h.orch.reapExpired({ idleTtlMs: HOUR, terminalGraceMs: HOUR }, 100 * HOUR),
    ).toEqual({ reaped: 0, failed: 0 });
    expect((await h.repos.workUnits.get(wu.id))?.state).toBe('PR_OPEN');
    // The reconciler's token survives with the unit.
    expect(await h.repos.secrets.get('u1', SECRET_GH_TOKEN, conv.id)).not.toBeNull();
  });

  it('collects a terminal unit past the grace, silently', async () => {
    const h = harness();
    const { conv, wu } = await seedAt(h, 'PR_MERGED', 'C5'); // updatedAt = 0
    expect(await h.orch.reapExpired({ terminalGraceMs: HOUR }, HOUR - 1)).toEqual({
      reaped: 0,
      failed: 0,
    });
    expect(await h.orch.reapExpired({ terminalGraceMs: HOUR }, HOUR)).toEqual({
      reaped: 1,
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
      failed: 0,
    });
    expect((await h.repos.workUnits.get(idle.wu.id))?.state).toBe('WORKING');
    expect((await h.repos.workUnits.get(done.wu.id))?.state).toBe('TORN_DOWN');

    expect(await h.orch.reapExpired({ idleTtlMs: HOUR }, 100 * HOUR)).toEqual({
      reaped: 1,
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
      failed: 1,
    });
    expect((await h.repos.workUnits.get(second.wu.id))?.state).toBe('TORN_DOWN');
  });
});
