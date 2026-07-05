/**
 * Warm pools (m9-plan workstream C) over a fake inner core — claim, refill,
 * fall-through, and shutdown are pure composition, so no Docker/network here.
 */
import { describe, expect, it } from 'vitest';
import type { CreateEnvironmentRequest, Environment, SecretSpec } from '@devspace/contracts';
import { createScriptedExecStream } from './exec.js';
import { SandboxError } from './sandbox.js';
import type { SandboxCore } from './sandbox.js';
import {
  WarmPoolSandboxCore,
  canonicalRequestKey,
  parseWarmPools,
  warmKeepOnStopFromEnv,
  warmPoolsFromEnv,
} from './warm-pool.js';

const TEMPLATE: CreateEnvironmentRequest = {
  repoUrl: 'https://github.com/acme/widgets.git',
  ref: 'main',
  resources: { cpu: 2, memMB: 4096, diskMB: 20480 },
  mounts: [{ source: 'agent-runtime', target: '/opt/agent-runtime', ro: true }],
  secrets: [],
};

/** The same request a tenant would make: template shape + their secrets. */
function tenantRequest(secrets: SecretSpec[] = []): CreateEnvironmentRequest {
  return { ...TEMPLATE, secrets };
}

/** A fake inner core recording creates/destroys/claims/secret applications. */
function fakeInner(): SandboxCore & {
  envs: Map<string, Environment>;
  created: number;
  destroyed: string[];
  claimed: string[];
  secretsApplied: Array<{ envId: string; names: string[] }>;
} {
  let seq = 0;
  const envs = new Map<string, Environment>();
  const self = {
    envs,
    created: 0,
    destroyed: [] as string[],
    claimed: [] as string[],
    secretsApplied: [] as Array<{ envId: string; names: string[] }>,
    async createEnvironment(req: CreateEnvironmentRequest): Promise<Environment> {
      self.created += 1;
      const env: Environment = {
        envId: `env_${++seq}`,
        status: 'ready',
        ports: [],
        createdAt: new Date().toISOString(),
        ...(req.poolKey ? { poolKey: req.poolKey } : {}),
      };
      envs.set(env.envId, env);
      return env;
    },
    async getEnvironment(envId: string): Promise<Environment | null> {
      return envs.get(envId) ?? null;
    },
    async listEnvironments(): Promise<Environment[]> {
      return [...envs.values()];
    },
    async applySecrets(envId: string, secrets: SecretSpec[]): Promise<void> {
      self.secretsApplied.push({ envId, names: secrets.map((s) => s.name) });
    },
    async claimEnvironment(envId: string): Promise<Environment> {
      const env = envs.get(envId);
      if (!env) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
      if (env.status !== 'ready' || !env.poolKey) {
        throw new SandboxError('CONFLICT', `environment ${envId} is not pool-owned`);
      }
      self.claimed.push(envId);
      const { poolKey: _poolKey, ...rest } = env;
      envs.set(envId, rest);
      return rest;
    },
    async destroyEnvironment(envId: string): Promise<void> {
      if (!envs.delete(envId)) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
      self.destroyed.push(envId);
    },
    async exec() {
      return createScriptedExecStream([{ kind: 'exit' as const, code: 0 }]);
    },
    async fsRead() {
      return new Uint8Array();
    },
    async fsWrite() {},
    async fsList() {
      return [];
    },
    async forwardPort() {
      return { proxyUrl: 'http://preview/t/x/', token: 'x' };
    },
  };
  return self;
}

describe('WarmPoolSandboxCore', () => {
  it('fills every pool to size', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    await pool.fill();
    expect(inner.created).toBe(2);
    expect(pool.warmCount(TEMPLATE)).toBe(2);
    // fill() is idempotent once full.
    await pool.fill();
    expect(inner.created).toBe(2);
  });

  it('claims a warm env on an exact match and applies the tenant secrets', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await pool.fill(); // warms env_1

    const env = await pool.createEnvironment(
      tenantRequest([{ name: 'GH_CLONE', value: 'tok', target: 'env' }]),
    );
    // The tenant got the pre-warmed env, not a cold create.
    expect(env.envId).toBe('env_1');
    expect(env.status).toBe('ready');
    expect(inner.secretsApplied).toEqual([{ envId: 'env_1', names: ['GH_CLONE'] }]);
  });

  it('refills after a claim', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await pool.fill();
    await pool.createEnvironment(tenantRequest());
    await pool.fill(); // deterministic stand-in for the background kick
    expect(pool.warmCount(TEMPLATE)).toBe(1);
    expect(inner.created).toBe(2);
  });

  it('misses cold on a near-miss request (different ref)', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await pool.fill();
    await pool.createEnvironment({ ...tenantRequest(), ref: 'develop' });
    // The warm env is untouched; the request went to the inner core.
    expect(pool.warmCount(TEMPLATE)).toBe(1);
    expect(inner.created).toBe(2);
    expect(inner.secretsApplied).toEqual([]);
  });

  it('stamps every fill with the pool key and hands out the unmarked, refreshed env', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await pool.fill();
    // The HOST's env table records the warm stock, not orchestrator memory.
    expect(inner.envs.get('env_1')?.poolKey).toBe(canonicalRequestKey(TEMPLATE));

    const env = await pool.createEnvironment(tenantRequest());
    // claimEnvironment ran on the owning host (refresh + unmark)…
    expect(inner.claimed).toEqual(['env_1']);
    // …and the tenant receives the CLAIMED env: no pool mark left anywhere.
    expect(env.poolKey).toBeUndefined();
    expect(inner.envs.get('env_1')?.poolKey).toBeUndefined();
  });

  it('destroys a warm env whose claim (refresh) fails and falls back cold', async () => {
    const inner = fakeInner();
    const innerClaim = inner.claimEnvironment.bind(inner);
    inner.claimEnvironment = async (envId: string) => {
      if (envId === 'env_1') throw new SandboxError('EXEC_FAILED', 'fetch: could not resolve');
      return innerClaim(envId);
    };
    const logs: string[] = [];
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }], {
      onLog: (line) => logs.push(line),
    });
    await pool.fill(); // warms env_1

    const env = await pool.createEnvironment(tenantRequest());
    // env_1 was destroyed, never handed out stale; the tenant got a cold env.
    expect(inner.destroyed).toContain('env_1');
    expect(env.envId).not.toBe('env_1');
    expect(logs.join('\n')).toContain('refresh of env_1 failed');
  });

  it('matching is canonical: key order and stripped secrets never matter', () => {
    const shuffled = JSON.parse(
      JSON.stringify({
        secrets: [{ name: 'X', value: 'v', target: 'env' }],
        mounts: TEMPLATE.mounts,
        ref: 'main',
        resources: { diskMB: 20480, cpu: 2, memMB: 4096 },
        repoUrl: TEMPLATE.repoUrl,
      }),
    ) as CreateEnvironmentRequest;
    expect(canonicalRequestKey(shuffled)).toBe(canonicalRequestKey(TEMPLATE));
    expect(canonicalRequestKey({ ...TEMPLATE, ref: 'develop' })).not.toBe(
      canonicalRequestKey(TEMPLATE),
    );
    // The pool mark is bookkeeping, not shape (m10-plan Decision 1).
    expect(canonicalRequestKey({ ...TEMPLATE, poolKey: 'anything' })).toBe(
      canonicalRequestKey(TEMPLATE),
    );
  });

  it('an egress policy shapes the key; requests without one keep pre-M22 keys (M22)', () => {
    // Optional-absent, not defaulted (m22-plan Decision 1): a policy-less
    // request must serialize WITHOUT the keys, or every pool mark stamped on
    // live pre-M22 warm stock would be orphaned by the upgrade.
    expect(canonicalRequestKey(TEMPLATE)).not.toContain('networkAccess');
    expect(canonicalRequestKey({ ...TEMPLATE, networkAccess: 'none' })).not.toBe(
      canonicalRequestKey(TEMPLATE),
    );
    expect(
      canonicalRequestKey({ ...TEMPLATE, networkAccess: 'custom', allowedHosts: ['github.com'] }),
    ).not.toBe(canonicalRequestKey({ ...TEMPLATE, networkAccess: 'none' }));
  });

  it('env + setupScript shape the key; requests without them keep pre-M24 keys (M24)', () => {
    // Both fields are env SHAPE — a pool whose template carries a setup
    // script pre-runs it at fill time, and only an exactly-matching request
    // may claim that env. Optional-absent, per the M22 posture.
    expect(canonicalRequestKey(TEMPLATE)).not.toContain('setupScript');
    expect(canonicalRequestKey({ ...TEMPLATE, setupScript: 'pnpm install' })).not.toBe(
      canonicalRequestKey(TEMPLATE),
    );
    expect(canonicalRequestKey({ ...TEMPLATE, env: { A: '1' } })).not.toBe(
      canonicalRequestKey(TEMPLATE),
    );
    expect(canonicalRequestKey({ ...TEMPLATE, env: { A: '1' } })).not.toBe(
      canonicalRequestKey({ ...TEMPLATE, env: { A: '2' } }),
    );
  });

  it('goes cold when the pool is empty — and kicks a refill', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    const env = await pool.createEnvironment(tenantRequest()); // nothing warmed yet
    expect(env.status).toBe('ready');
    await pool.fill(); // join the kicked background refill
    expect(pool.warmCount(TEMPLATE)).toBe(1);
  });

  it('skips a vanished warm env and never hands out a dead one', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    await pool.fill();
    const [first] = [...inner.envs.keys()];
    inner.envs.delete(first!); // the host was wiped under the pool

    const env = await pool.createEnvironment(tenantRequest());
    expect(env.envId).not.toBe(first);
    expect(inner.envs.has(env.envId)).toBe(true);
  });

  it('destroys a warm env whose secret application fails and falls back', async () => {
    const inner = fakeInner();
    inner.applySecrets = async (envId: string) => {
      if (envId === 'env_1') throw new SandboxError('EXEC_FAILED', 'secrets boom');
      inner.secretsApplied.push({ envId, names: ['GH'] });
    };
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await pool.fill(); // warms env_1

    const env = await pool.createEnvironment(
      tenantRequest([{ name: 'GH', value: 'tok', target: 'env' }]),
    );
    // env_1 was destroyed, never handed out; the tenant got a fresh cold env
    // whose secrets ride the ordinary provision path (no late application).
    expect(inner.destroyed).toContain('env_1');
    expect(env.envId).not.toBe('env_1');
    expect(inner.envs.has(env.envId)).toBe(true);
    expect(inner.secretsApplied).toEqual([]);
  });

  it('drops an externally-destroyed env from the pool', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await pool.fill();
    const [warmed] = [...inner.envs.keys()];
    await pool.destroyEnvironment(warmed!);
    expect(pool.warmCount(TEMPLATE)).toBe(0);
  });

  it('stop() destroys still-unclaimed warm envs and halts refills', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    await pool.fill();
    await pool.stop();
    expect(inner.envs.size).toBe(0);
    expect(inner.destroyed).toHaveLength(2);
    await pool.fill(); // stopped: no new provisions
    expect(inner.created).toBe(2);
  });

  it('a fill failure logs and is retried on the next kick, never thrown', async () => {
    const inner = fakeInner();
    let failures = 1;
    const innerCreate = inner.createEnvironment.bind(inner);
    inner.createEnvironment = async (req) => {
      if (failures-- > 0) throw new SandboxError('PROVISION_FAILED', 'daemon hiccup');
      return innerCreate(req);
    };
    const logs: string[] = [];
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }], {
      onLog: (line) => logs.push(line),
    });
    await pool.fill(); // resolves despite the failure
    expect(logs.join('\n')).toContain('fill failed');
    expect(pool.warmCount(TEMPLATE)).toBe(0);
    await pool.fill();
    expect(pool.warmCount(TEMPLATE)).toBe(1);
  });

  it('rejects secret-carrying or duplicate templates and bad sizes at construction', () => {
    const inner = fakeInner();
    expect(
      () =>
        new WarmPoolSandboxCore(inner, [
          {
            template: { ...TEMPLATE, secrets: [{ name: 'X', value: 'v', target: 'env' }] },
            size: 1,
          },
        ]),
    ).toThrow('must not carry secrets');
    expect(
      () =>
        new WarmPoolSandboxCore(inner, [
          { template: { ...TEMPLATE, poolKey: 'pre-marked' }, size: 1 },
        ]),
    ).toThrow('must not carry poolKey');
    expect(
      () =>
        new WarmPoolSandboxCore(inner, [
          { template: TEMPLATE, size: 1 },
          { template: TEMPLATE, size: 2 },
        ]),
    ).toThrow('duplicate');
    expect(() => new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 0 }])).toThrow(
      'positive integer',
    );
  });
});

describe('orphan re-adoption (M10 — the restart path)', () => {
  it('re-adopts pool-marked ready envs instead of provisioning new ones', async () => {
    const inner = fakeInner();
    const first = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    await first.fill(); // env_1, env_2 warmed and marked
    expect(inner.created).toBe(2);

    // The control plane crashed: a NEW wrapper over the same fleet re-learns
    // its warm stock from the host's env table instead of leaking it.
    const restarted = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    await restarted.fill();
    expect(inner.created).toBe(2); // nothing new provisioned
    expect(restarted.warmCount(TEMPLATE)).toBe(2);

    // Re-adopted stock is fully claimable.
    const env = await restarted.createEnvironment(tenantRequest());
    expect(['env_1', 'env_2']).toContain(env.envId);
    expect(env.poolKey).toBeUndefined();
  });

  it('destroys excess beyond a shrunk pool size — the leak closes, not re-homes', async () => {
    const inner = fakeInner();
    const first = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 3 }]);
    await first.fill();

    const restarted = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await restarted.fill();
    expect(restarted.warmCount(TEMPLATE)).toBe(1);
    expect(inner.destroyed).toHaveLength(2);
    expect(inner.envs.size).toBe(1);
  });

  it('never touches foreign marks or unmarked tenant envs', async () => {
    const inner = fakeInner();
    // A tenant env (no mark) and an env owned by some OTHER pool/config.
    const tenant = await inner.createEnvironment(tenantRequest());
    const foreign = await inner.createEnvironment({
      ...TEMPLATE,
      ref: 'develop',
      poolKey: 'other',
    });

    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await pool.fill();
    // Neither was adopted (a fresh env was provisioned) and neither was destroyed.
    expect(pool.warmCount(TEMPLATE)).toBe(1);
    expect(inner.created).toBe(3);
    expect(inner.envs.has(tenant.envId)).toBe(true);
    expect(inner.envs.get(foreign.envId)?.poolKey).toBe('other');
    expect(inner.destroyed).toEqual([]);
  });

  it('a sweep failure logs and the top-up still runs', async () => {
    const inner = fakeInner();
    inner.listEnvironments = async () => {
      throw new SandboxError('EXEC_FAILED', 'host b unreachable');
    };
    const logs: string[] = [];
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }], {
      onLog: (line) => logs.push(line),
    });
    await pool.fill();
    expect(logs.join('\n')).toContain('orphan sweep failed');
    expect(pool.warmCount(TEMPLATE)).toBe(1);
  });
});

describe('multi-controller coordination (M14) — the host is the ledger', () => {
  it('two controllers converge on size, not 2×size', async () => {
    const inner = fakeInner();
    const a = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    const b = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    await a.fill();
    await b.fill();
    // b adopted a's marked stock off the host's table instead of refilling.
    expect(inner.created).toBe(2);
    expect(b.warmCount(TEMPLATE)).toBe(2);
  });

  it('a controller that never filled claims sibling stock warm on a local miss', async () => {
    const inner = fakeInner();
    const a = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await a.fill(); // env_1, marked by a
    const b = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);

    const env = await b.createEnvironment(tenantRequest());
    expect(env.envId).toBe('env_1'); // warm hand-out, not a cold create
    expect(env.poolKey).toBeUndefined();
    await b.fill(); // join the kicked background refill
    expect(inner.created).toBe(2); // env_1 + b's refill (never a cold tenant env)
  });

  it('losing the claim race NEVER destroys the winner’s (now tenant) env', async () => {
    const inner = fakeInner();
    const a = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    const b = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }]);
    await a.fill();
    await b.fill(); // both track env_1 — the shared-stock shape

    const winner = await a.createEnvironment(tenantRequest());
    expect(winner.envId).toBe('env_1');
    const loser = await b.createEnvironment(tenantRequest());
    // The loser saw the mark gone, dropped, and went cold — the M14 safety
    // property: pre-M14 this destroyed the winner's live tenant workspace.
    expect(loser.envId).not.toBe('env_1');
    expect(inner.destroyed).not.toContain('env_1');
    expect(inner.envs.has('env_1')).toBe(true);
  });

  it('CONFLICT from claimEnvironment (race lost between verify and claim) drops, never destroys', async () => {
    const inner = fakeInner();
    const innerClaim = inner.claimEnvironment.bind(inner);
    inner.claimEnvironment = async (envId: string) => {
      if (envId === 'env_1') throw new SandboxError('CONFLICT', 'not pool-owned');
      return innerClaim(envId);
    };
    const logs: string[] = [];
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }], {
      onLog: (line) => logs.push(line),
    });
    await pool.fill();

    const env = await pool.createEnvironment(tenantRequest());
    expect(env.envId).not.toBe('env_1');
    expect(inner.destroyed).not.toContain('env_1');
    expect(logs.join('\n')).toContain('lost env_1 to a sibling controller (CONFLICT)');
  });

  it('NOT_FOUND from claimEnvironment (sibling trimmed it) drops, never destroys', async () => {
    const inner = fakeInner();
    inner.claimEnvironment = async (envId: string) => {
      throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
    };
    const logs: string[] = [];
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }], {
      onLog: (line) => logs.push(line),
    });
    await pool.fill();

    const env = await pool.createEnvironment(tenantRequest());
    expect(env.envId).not.toBe('env_1');
    expect(inner.destroyed).toEqual([]);
    expect(logs.join('\n')).toContain('lost env_1 to a sibling controller (NOT_FOUND)');
  });

  it('top-up gates on the global count while claims drain concurrently', async () => {
    const inner = fakeInner();
    const a = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    await a.fill(); // env_1, env_2
    // A sibling claims one env directly off the host (a controller this
    // instance has never met): global stock is now 1.
    await inner.claimEnvironment('env_1');

    await a.fill();
    // The refill saw 1/2 globally and provisioned exactly one more.
    expect(inner.created).toBe(3);
    expect(inner.envs.get('env_3')?.poolKey).toBe(canonicalRequestKey(TEMPLATE));
  });

  it('a listing failure degrades top-up to local counts, never blocks fills', async () => {
    const inner = fakeInner();
    inner.listEnvironments = async () => {
      throw new SandboxError('EXEC_FAILED', 'host b unreachable');
    };
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    await pool.fill();
    expect(pool.warmCount(TEMPLATE)).toBe(2); // single-controller behavior
    expect(inner.created).toBe(2);
  });
});

describe('warm-stock handover on clean shutdown (M15)', () => {
  it('keepStockOnStop leaves marked stock alive and a sibling claims it warm', async () => {
    const inner = fakeInner();
    const a = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }], {
      keepStockOnStop: true,
    });
    await a.fill();
    await a.stop();

    // Nothing destroyed; both envs still pool-marked on the host.
    expect(inner.destroyed).toEqual([]);
    expect([...inner.envs.values()].filter((e) => e.poolKey)).toHaveLength(2);

    // A sibling controller (fresh wrapper, never filled) claims the handed-
    // over stock warm via its miss-sweep — no cold create.
    const b = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 2 }]);
    const env = await b.createEnvironment(tenantRequest());
    expect(inner.created).toBe(2);
    expect(inner.claimed).toContain(env.envId);
  });

  it('keepStockOnStop halts refills like the default stop', async () => {
    const inner = fakeInner();
    const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }], {
      keepStockOnStop: true,
    });
    await pool.fill();
    await pool.stop();
    await pool.fill(); // stopped: no new provisions
    expect(inner.created).toBe(1);
  });

  it('a provision that loses the race with stop() honors the knob both ways', async () => {
    for (const keep of [true, false]) {
      const inner = fakeInner();
      // Gate the provision so stop() lands while the create is in flight.
      let releaseCreate: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        const innerCreate = inner.createEnvironment.bind(inner);
        inner.createEnvironment = async (req) => {
          resolve();
          await new Promise<void>((r) => {
            releaseCreate = r;
          });
          return innerCreate(req);
        };
      });
      const pool = new WarmPoolSandboxCore(inner, [{ template: TEMPLATE, size: 1 }], {
        keepStockOnStop: keep,
      });
      const filling = pool.fill();
      await started;
      const stopping = pool.stop();
      releaseCreate!();
      await Promise.all([filling, stopping]);

      // The env completed after stop: kept (marked, adoptable) or destroyed.
      expect(inner.envs.size).toBe(keep ? 1 : 0);
      if (keep) expect([...inner.envs.values()][0]?.poolKey).toBeTruthy();
    }
  });
});

describe('parseWarmPools', () => {
  it('parses repoUrl, optional ref, and size', () => {
    expect(
      parseWarmPools('https://github.com/a/b.git#main=2, https://github.com/c/d.git=1'),
    ).toEqual([
      { repoUrl: 'https://github.com/a/b.git', ref: 'main', size: 2 },
      { repoUrl: 'https://github.com/c/d.git', ref: undefined, size: 1 },
    ]);
  });

  it.each([
    ['https://github.com/a/b.git', 'not repoUrl'],
    ['https://github.com/a/b.git=zero', 'positive integer'],
    ['https://github.com/a/b.git=0', 'positive integer'],
    ['ftp://github.com/a/b.git=1', 'http(s) repo url'],
    ['  ,  ', 'names no pools'],
  ])('rejects %s', (raw, message) => {
    expect(() => parseWarmPools(raw)).toThrow(message);
  });

  it('warmPoolsFromEnv is undefined without SANDBOX_WARM_POOLS', () => {
    expect(warmPoolsFromEnv({})).toBeUndefined();
    expect(warmPoolsFromEnv({ SANDBOX_WARM_POOLS: ' ' })).toBeUndefined();
    expect(warmPoolsFromEnv({ SANDBOX_WARM_POOLS: 'https://github.com/a/b.git=1' })).toHaveLength(
      1,
    );
  });

  it('warmKeepOnStopFromEnv: 1/true on, 0/false/unset off, garbage refuses (M15)', () => {
    expect(warmKeepOnStopFromEnv({})).toBe(false);
    expect(warmKeepOnStopFromEnv({ SANDBOX_WARM_KEEP_ON_STOP: ' ' })).toBe(false);
    expect(warmKeepOnStopFromEnv({ SANDBOX_WARM_KEEP_ON_STOP: '0' })).toBe(false);
    expect(warmKeepOnStopFromEnv({ SANDBOX_WARM_KEEP_ON_STOP: 'false' })).toBe(false);
    expect(warmKeepOnStopFromEnv({ SANDBOX_WARM_KEEP_ON_STOP: '1' })).toBe(true);
    expect(warmKeepOnStopFromEnv({ SANDBOX_WARM_KEEP_ON_STOP: 'true' })).toBe(true);
    expect(() => warmKeepOnStopFromEnv({ SANDBOX_WARM_KEEP_ON_STOP: 'yes' })).toThrow(
      'SANDBOX_WARM_KEEP_ON_STOP',
    );
  });
});
