/**
 * Multi-host placement/capacity/drain + routing rediscovery (m8-plan
 * workstream C), over fake per-host cores — the placement logic is pure
 * composition, so no network is needed here (the wire has its own suite).
 */
import { describe, expect, it } from 'vitest';
import type { CreateEnvironmentRequest, Environment } from '@devspace/contracts';
import { captureExec, createScriptedExecStream } from './exec.js';
import {
  DEFAULT_HOST_CAPACITY,
  MultiHostSandboxCore,
  parseSandboxHosts,
  sandboxHostsFromEnv,
} from './multihost.js';
import { SandboxError } from './sandbox.js';
import type { SandboxCore } from './sandbox.js';

const CREATE: CreateEnvironmentRequest = {
  resources: { cpu: 2, memMB: 4096, diskMB: 20480 },
  mounts: [],
  secrets: [],
};

/** A fake host: a real env table, call recording, deterministic ids. */
function fakeHost(name: string): SandboxCore & {
  envs: Map<string, Environment>;
  calls: string[];
} {
  let seq = 0;
  const envs = new Map<string, Environment>();
  const calls: string[] = [];
  return {
    envs,
    calls,
    async createEnvironment() {
      const envId = `env_${name}_${++seq}`;
      const env: Environment = {
        envId,
        status: 'ready',
        ports: [],
        createdAt: new Date().toISOString(),
      };
      envs.set(envId, env);
      return env;
    },
    async getEnvironment(envId) {
      return envs.get(envId) ?? null;
    },
    async listEnvironments() {
      return [...envs.values()];
    },
    async applySecrets(envId, secrets) {
      calls.push(`applySecrets:${envId}:${secrets.map((s) => s.name).join('+')}`);
    },
    async claimEnvironment(envId) {
      calls.push(`claim:${envId}`);
      const env = envs.get(envId);
      if (!env) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
      const { poolKey: _poolKey, ...claimed } = env;
      envs.set(envId, claimed);
      return claimed;
    },
    async destroyEnvironment(envId) {
      if (!envs.delete(envId)) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
    },
    async exec(envId) {
      calls.push(`exec:${envId}`);
      return createScriptedExecStream([{ kind: 'exit', code: 0 }]);
    },
    async fsRead(envId, path) {
      calls.push(`fsRead:${envId}:${path}`);
      return new Uint8Array();
    },
    async fsWrite(envId, path) {
      calls.push(`fsWrite:${envId}:${path}`);
    },
    async fsList(envId, path) {
      calls.push(`fsList:${envId}:${path}`);
      return [];
    },
    async forwardPort(envId, containerPort) {
      calls.push(`forwardPort:${envId}:${containerPort}`);
      return { proxyUrl: `http://${name}/t/x/`, token: 'x' };
    },
  };
}

describe('MultiHostSandboxCore placement', () => {
  it('places least-loaded, breaking ties in config order', async () => {
    const a = fakeHost('a');
    const b = fakeHost('b');
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 2 },
      { name: 'b', core: b, capacity: 2 },
    ]);

    const order: string[] = [];
    for (let i = 0; i < 4; i++) order.push((await multi.createEnvironment(CREATE)).envId);
    expect(order.map((id) => id.split('_')[1])).toEqual(['a', 'b', 'a', 'b']);
  });

  it('reserves in-flight placements so a concurrent burst cannot exceed capacity', async () => {
    // Slow provisioner: all three creates overlap, so without reservations
    // they would all read the same load snapshot and pile onto host a.
    function slowHost(name: string): SandboxCore {
      let seq = 0;
      const envs = new Map<string, Environment>();
      return {
        ...fakeHost(name),
        async createEnvironment() {
          await new Promise((r) => setTimeout(r, 30));
          const envId = `env_${name}_${++seq}`;
          const env: Environment = {
            envId,
            status: 'ready',
            ports: [],
            createdAt: new Date().toISOString(),
          };
          envs.set(envId, env);
          return env;
        },
        async getEnvironment(envId) {
          return envs.get(envId) ?? null;
        },
      };
    }
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: slowHost('a'), capacity: 1 },
      { name: 'b', core: slowHost('b'), capacity: 1 },
    ]);

    const results = await Promise.allSettled([
      multi.createEnvironment(CREATE),
      multi.createEnvironment(CREATE),
      multi.createEnvironment(CREATE),
    ]);
    const placed = results
      .filter((r): r is PromiseFulfilledResult<Environment> => r.status === 'fulfilled')
      .map((r) => r.value.envId.split('_')[1]);
    const failed = results.filter((r) => r.status === 'rejected');
    // Exactly one per host; the third refused instead of over-placing.
    expect(placed.sort()).toEqual(['a', 'b']);
    expect(failed).toHaveLength(1);
  });

  it('refuses placement when every host is at capacity', async () => {
    const a = fakeHost('a');
    const multi = new MultiHostSandboxCore([{ name: 'a', core: a, capacity: 1 }]);
    await multi.createEnvironment(CREATE);
    const err = await multi.createEnvironment(CREATE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('PROVISION_FAILED');
    expect((err as SandboxError).message).toContain('capacity');
  });

  it('skips draining hosts for placement but keeps routing to them', async () => {
    const a = fakeHost('a');
    const b = fakeHost('b');
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 4 },
      { name: 'b', core: b, capacity: 4 },
    ]);
    const onA = await multi.createEnvironment(CREATE); // least-loaded: a

    multi.setDraining('a', true);
    for (let i = 0; i < 3; i++) {
      expect((await multi.createEnvironment(CREATE)).envId).toContain('_b_');
    }
    // The env already on the draining host is still fully served.
    await captureExec(await multi.exec(onA.envId, { cmd: ['true'], tty: false }));
    expect(a.calls).toContain(`exec:${onA.envId}`);

    // Un-drain and placement resumes (a has 1 env, b has 3 — least loaded).
    multi.setDraining('a', false);
    expect((await multi.createEnvironment(CREATE)).envId).toContain('_a_');
  });

  it('distinguishes all-draining from out-of-capacity in the error', async () => {
    const a = fakeHost('a');
    const multi = new MultiHostSandboxCore([{ name: 'a', core: a, capacity: 4, draining: true }]);
    const err = await multi.createEnvironment(CREATE).catch((e: unknown) => e);
    expect((err as SandboxError).message).toContain('draining');
  });

  it('rejects an unknown host in setDraining', () => {
    const multi = new MultiHostSandboxCore([{ name: 'a', core: fakeHost('a'), capacity: 1 }]);
    expect(() => multi.setDraining('zzz', true)).toThrow('no such sandbox host');
  });

  it('requires unique names and at least one host', () => {
    expect(() => new MultiHostSandboxCore([])).toThrow('at least one host');
    expect(
      () =>
        new MultiHostSandboxCore([
          { name: 'a', core: fakeHost('a'), capacity: 1 },
          { name: 'a', core: fakeHost('a'), capacity: 1 },
        ]),
    ).toThrow('unique');
  });
});

describe('MultiHostSandboxCore routing', () => {
  it('routes every op to the owning host', async () => {
    const a = fakeHost('a');
    const b = fakeHost('b');
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 1 },
      { name: 'b', core: b, capacity: 1 },
    ]);
    const envA = (await multi.createEnvironment(CREATE)).envId;
    const envB = (await multi.createEnvironment(CREATE)).envId;

    await multi.fsRead(envB, '/x');
    await multi.fsWrite(envA, '/y', new Uint8Array());
    await multi.fsList(envB, '/z');
    await multi.forwardPort(envA, 3000);
    await multi.applySecrets(envA, [{ name: 'GH', value: 'v', target: 'env' }]);
    await multi.claimEnvironment(envA);

    expect(b.calls).toEqual([`fsRead:${envB}:/x`, `fsList:${envB}:/z`]);
    expect(a.calls).toEqual([
      `fsWrite:${envA}:/y`,
      `forwardPort:${envA}:3000`,
      `applySecrets:${envA}:GH`,
      `claim:${envA}`,
    ]);
    expect(multi.hostOf(envA)).toBe('a');
    expect(multi.hostOf(envB)).toBe('b');
  });

  it('rediscovers an env after a restart (cold routing miss) and counts it', async () => {
    const a = fakeHost('a');
    const b = fakeHost('b');
    const survivor = (await b.createEnvironment(CREATE)).envId; // pre-restart env

    // A fresh multi-host core (empty routing table) over the same fleet.
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 2 },
      { name: 'b', core: b, capacity: 1 },
    ]);
    expect(multi.hostOf(survivor)).toBeUndefined();
    expect((await multi.getEnvironment(survivor))?.envId).toBe(survivor);
    expect(multi.hostOf(survivor)).toBe('b');

    // The adopted env occupies b's only slot: both new envs land on a.
    expect((await multi.createEnvironment(CREATE)).envId).toContain('_a_');
    expect((await multi.createEnvironment(CREATE)).envId).toContain('_a_');
    const err = await multi.createEnvironment(CREATE).catch((e: unknown) => e);
    expect((err as SandboxError).code).toBe('PROVISION_FAILED');
  });

  it('surfaces a probe failure instead of reporting a live env as NOT_FOUND', async () => {
    const down: SandboxCore = {
      ...fakeHost('down'),
      async getEnvironment() {
        throw new SandboxError('EXEC_FAILED', 'connection refused');
      },
    };
    const multi = new MultiHostSandboxCore([
      { name: 'down', core: down, capacity: 1 },
      { name: 'up', core: fakeHost('up'), capacity: 1 },
    ]);
    const err = await multi.fsRead('env_unrouted', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('EXEC_FAILED');
    expect((err as SandboxError).message).toContain('probe');
    expect((err as SandboxError).message).toContain('down');
  });

  it('still adopts an env found on a later host even when an earlier probe fails', async () => {
    const down: SandboxCore = {
      ...fakeHost('down'),
      async getEnvironment() {
        throw new SandboxError('EXEC_FAILED', 'connection refused');
      },
    };
    const b = fakeHost('b');
    const survivor = (await b.createEnvironment(CREATE)).envId;
    const multi = new MultiHostSandboxCore([
      { name: 'down', core: down, capacity: 1 },
      { name: 'b', core: b, capacity: 1 },
    ]);
    expect((await multi.getEnvironment(survivor))?.envId).toBe(survivor);
    expect(multi.hostOf(survivor)).toBe('b');
  });

  it('evicts a stale route when the owning host no longer knows the env', async () => {
    const a = fakeHost('a');
    const multi = new MultiHostSandboxCore([{ name: 'a', core: a, capacity: 1 }]);
    const env = (await multi.createEnvironment(CREATE)).envId;
    a.envs.clear(); // the host was wiped out from under the orchestrator
    expect(await multi.getEnvironment(env)).toBeNull();
    expect(multi.hostOf(env)).toBeUndefined();
    // The phantom no longer counts against capacity.
    await multi.createEnvironment(CREATE);
  });

  it('returns null for an env no host knows', async () => {
    const multi = new MultiHostSandboxCore([{ name: 'a', core: fakeHost('a'), capacity: 1 }]);
    expect(await multi.getEnvironment('env_ghost')).toBeNull();
  });

  it('throws NOT_FOUND for ops on an env no host knows', async () => {
    const multi = new MultiHostSandboxCore([{ name: 'a', core: fakeHost('a'), capacity: 1 }]);
    const err = await multi.fsRead('env_ghost', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('NOT_FOUND');
  });

  it('destroy frees the placement slot', async () => {
    const a = fakeHost('a');
    const multi = new MultiHostSandboxCore([{ name: 'a', core: a, capacity: 1 }]);
    const env = (await multi.createEnvironment(CREATE)).envId;
    await multi.destroyEnvironment(env);
    expect(multi.hostOf(env)).toBeUndefined();
    // The slot is free again.
    await multi.createEnvironment(CREATE);
  });
});

describe('MultiHostSandboxCore census (M9)', () => {
  it('adopts every live env across the fleet at once', async () => {
    const a = fakeHost('a');
    const b = fakeHost('b');
    const onA = (await a.createEnvironment(CREATE)).envId;
    const onB1 = (await b.createEnvironment(CREATE)).envId;
    const onB2 = (await b.createEnvironment(CREATE)).envId;

    const multi = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 2 },
      { name: 'b', core: b, capacity: 2 },
    ]);
    const census = await multi.adoptFleet();
    expect(census).toEqual({ adopted: 3, failures: [] });
    expect(multi.hostOf(onA)).toBe('a');
    expect(multi.hostOf(onB1)).toBe('b');
    expect(multi.hostOf(onB2)).toBe('b');

    // Adopted load steers placement immediately: a has the only free slots.
    expect((await multi.createEnvironment(CREATE)).envId).toContain('_a_');
    const err = await multi.createEnvironment(CREATE).catch((e: unknown) => e);
    expect((err as SandboxError).code).toBe('PROVISION_FAILED');
  });

  it('skips dead records and is idempotent', async () => {
    const a = fakeHost('a');
    const live = (await a.createEnvironment(CREATE)).envId;
    const dead = (await a.createEnvironment(CREATE)).envId;
    a.envs.set(dead, { ...a.envs.get(dead)!, status: 'stopped' });

    const multi = new MultiHostSandboxCore([{ name: 'a', core: a, capacity: 8 }]);
    expect(await multi.adoptFleet()).toEqual({ adopted: 1, failures: [] });
    expect(multi.hostOf(live)).toBe('a');
    expect(multi.hostOf(dead)).toBeUndefined();
    // Re-running adopts nothing new.
    expect((await multi.adoptFleet()).adopted).toBe(0);
  });

  it('reports an unreachable host without failing the census', async () => {
    const down: SandboxCore = {
      ...fakeHost('down'),
      async listEnvironments() {
        throw new SandboxError('EXEC_FAILED', 'connection refused');
      },
    };
    const b = fakeHost('b');
    const survivor = (await b.createEnvironment(CREATE)).envId;
    const multi = new MultiHostSandboxCore([
      { name: 'down', core: down, capacity: 1 },
      { name: 'b', core: b, capacity: 1 },
    ]);
    const census = await multi.adoptFleet();
    expect(census.adopted).toBe(1);
    expect(census.failures).toEqual([{ host: 'down', error: 'connection refused' }]);
    expect(multi.hostOf(survivor)).toBe('b');
  });

  it('listEnvironments aggregates the fleet strictly and adopts as it reads', async () => {
    const a = fakeHost('a');
    const b = fakeHost('b');
    const onA = (await a.createEnvironment(CREATE)).envId;
    await b.createEnvironment(CREATE);
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 8 },
      { name: 'b', core: b, capacity: 8 },
    ]);
    const all = await multi.listEnvironments();
    expect(all.map((e) => e.envId)).toHaveLength(2);
    expect(multi.hostOf(onA)).toBe('a');

    // Strict: a down host is an error, never an empty answer.
    const down: SandboxCore = {
      ...fakeHost('down'),
      async listEnvironments() {
        throw new SandboxError('EXEC_FAILED', 'connection refused');
      },
    };
    const strict = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 8 },
      { name: 'down', core: down, capacity: 8 },
    ]);
    await expect(strict.listEnvironments()).rejects.toMatchObject({ code: 'EXEC_FAILED' });
  });
});

describe('parseSandboxHosts', () => {
  it('parses names, urls, capacities, and drain flags', () => {
    expect(parseSandboxHosts('a=http://h1:4001, b=https://h2:4001/|4|drain')).toEqual([
      { name: 'a', url: 'http://h1:4001', capacity: DEFAULT_HOST_CAPACITY, draining: false },
      { name: 'b', url: 'https://h2:4001', capacity: 4, draining: true },
    ]);
  });

  it.each([
    ['http://no-name:1', 'not name=url'],
    ['a=not-a-url', 'http(s) url'],
    ['a=http://h:1|banana', 'unknown flag'],
    ['a=http://h:1,a=http://h2:1', 'unique'],
    ['  ,  ', 'names no hosts'],
  ])('rejects %s', (raw, message) => {
    expect(() => parseSandboxHosts(raw)).toThrow(message);
  });

  it('sandboxHostsFromEnv is undefined without SANDBOX_HOSTS', () => {
    expect(sandboxHostsFromEnv({})).toBeUndefined();
    expect(sandboxHostsFromEnv({ SANDBOX_HOSTS: '  ' })).toBeUndefined();
    expect(sandboxHostsFromEnv({ SANDBOX_HOSTS: 'a=http://h:1' })).toHaveLength(1);
  });
});
