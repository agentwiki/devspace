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
  statsIntervalFromEnv,
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

describe('weighted placement (M12)', () => {
  /** A host whose envs echo a fixed resource grant. */
  function sizedHost(name: string, cpu: number, memMB: number): ReturnType<typeof fakeHost> {
    const host = fakeHost(name);
    const create = host.createEnvironment.bind(host);
    host.createEnvironment = async (req: CreateEnvironmentRequest) => {
      const env = await create(req);
      const sized = { ...env, resources: { cpu, memMB, diskMB: 20480 } };
      host.envs.set(env.envId, sized);
      return sized;
    };
    return host;
  }

  const sized = (cpu: number, memMB: number): CreateEnvironmentRequest => ({
    resources: { cpu, memMB, diskMB: 20480 },
    mounts: [],
    secrets: [],
  });

  it('ranks by fractional utilization: the host with more free budget room wins', async () => {
    // b is bigger; every env is the default grant (2 cores, 4096MB).
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: fakeHost('a'), capacity: 8, cpu: 4, memMB: 65536 },
      { name: 'b', core: fakeHost('b'), capacity: 8, cpu: 16, memMB: 65536 },
    ]);
    expect((await multi.createEnvironment(CREATE)).envId).toContain('_a_'); // tie at 0: config order
    // a sits at cpu 2/4 = 0.5; b climbs 0.125 → 0.25 → 0.375 — b wins four times.
    for (let i = 0; i < 4; i++) {
      expect((await multi.createEnvironment(CREATE)).envId).toContain('_b_');
    }
    // b reaches max(4/8, 8/16) = 0.5 = a's score: the tie breaks in config order.
    expect((await multi.createEnvironment(CREATE)).envId).toContain('_a_');
    // a is now cpu-full (4/4): the fit-check sends the next one to b.
    expect((await multi.createEnvironment(CREATE)).envId).toContain('_b_');
  });

  it('fit-checks admission and refuses with a distinct message when slots exist but nothing fits', async () => {
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: fakeHost('a'), capacity: 8, cpu: 4, memMB: 8192 },
    ]);
    await multi.createEnvironment(sized(3, 4096));
    // An env-count slot is free, but 3+2 cores > 4.
    const err = await multi.createEnvironment(sized(2, 1024)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('PROVISION_FAILED');
    expect((err as SandboxError).message).toContain('fits the requested resources');
    expect((err as SandboxError).message).toContain('cpu=2');
    // A smaller request still lands.
    await multi.createEnvironment(sized(1, 1024));
  });

  it('the max keeps a cpu-saturated, memory-empty host from winning on an average', async () => {
    const a = sizedHost('a', 7, 1024); // fills a's cpu, barely touches memory
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 8, cpu: 8, memMB: 65536 },
      { name: 'b', core: fakeHost('b'), capacity: 8, cpu: 8, memMB: 65536 },
    ]);
    await multi.createEnvironment(sized(7, 1024)); // a: max(1/8, 7/8, tiny) = 0.875
    // Average would say a (mean ≈ 0.45 vs b's 0); the max says b.
    expect((await multi.createEnvironment(CREATE)).envId).toContain('_b_');
  });

  it('concurrent creates reserve their resource footprint, not just a slot', async () => {
    function slowHost(name: string): SandboxCore {
      const host = fakeHost(name);
      const create = host.createEnvironment.bind(host);
      return {
        ...host,
        async createEnvironment(req: CreateEnvironmentRequest) {
          await new Promise((r) => setTimeout(r, 30));
          return create(req);
        },
        async getEnvironment(envId) {
          return host.envs.get(envId) ?? null;
        },
      };
    }
    // Room for exactly one 3-core env: the overlapping second must refuse
    // even though the env-count capacity (8) has plenty of slots.
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: slowHost('a'), capacity: 8, cpu: 4, memMB: 65536 },
    ]);
    const results = await Promise.allSettled([
      multi.createEnvironment(sized(3, 1024)),
      multi.createEnvironment(sized(3, 1024)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('fits the requested resources');
  });

  it('census adoption weighs echoed grants; an echo-less env weighs the defaults', async () => {
    const big = sizedHost('a', 6, 4096);
    await big.createEnvironment(sized(6, 4096)); // pre-restart: 6 of a's 8 cores
    const plain = fakeHost('b');
    await plain.createEnvironment(CREATE); // echo-less: weighs default 2 cores
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: big, capacity: 8, cpu: 8, memMB: 65536 },
      { name: 'b', core: plain, capacity: 8, cpu: 8, memMB: 65536 },
    ]);
    expect((await multi.adoptFleet()).adopted).toBe(2);
    // a: 6/8 cpu; b: 2/8 — and a cannot even fit another 4-core env.
    expect((await multi.createEnvironment(sized(4, 1024))).envId).toContain('_b_');
    // b: 6/8 now. A 2-core env fits both; b is still fractionally even, a=0.75, b=0.75
    // — tie goes to config order, but a can only fit 2 more cores: it takes it.
    expect((await multi.createEnvironment(sized(2, 1024))).envId).toContain('_a_');
  });

  it('destroy frees the weight along with the slot', async () => {
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: fakeHost('a'), capacity: 8, cpu: 4, memMB: 65536 },
    ]);
    const env = await multi.createEnvironment(sized(4, 1024));
    await expect(multi.createEnvironment(sized(1, 1024))).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
    });
    await multi.destroyEnvironment(env.envId);
    await multi.createEnvironment(sized(4, 1024));
  });

  it('a fleet that declares no budgets keeps the M8 count comparator (uniform capacities)', async () => {
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: fakeHost('a'), capacity: 2 },
      { name: 'b', core: fakeHost('b'), capacity: 2 },
    ]);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) order.push((await multi.createEnvironment(CREATE)).envId);
    expect(order.map((id) => id.split('_')[1])).toEqual(['a', 'b', 'a', 'b']);
  });
});

describe('parseSandboxHosts', () => {
  it('parses names, urls, capacities, budgets, and drain flags', () => {
    expect(
      parseSandboxHosts(
        'a=http://h1:4001, b=https://h2:4001/|4|drain, c=http://h3:1|cpu=16|mem=65536',
      ),
    ).toEqual([
      { name: 'a', url: 'http://h1:4001', capacity: DEFAULT_HOST_CAPACITY, draining: false },
      { name: 'b', url: 'https://h2:4001', capacity: 4, draining: true },
      {
        name: 'c',
        url: 'http://h3:1',
        capacity: DEFAULT_HOST_CAPACITY,
        cpu: 16,
        memMB: 65536,
        draining: false,
      },
    ]);
    expect(parseSandboxHosts('a=http://h:1|cpu=7.5')[0]?.cpu).toBe(7.5);
  });

  it.each([
    ['http://no-name:1', 'not name=url'],
    ['a=not-a-url', 'http(s) url'],
    ['a=http://h:1|banana', 'unknown flag'],
    ['a=http://h:1|cpu=0', 'cpu budget'],
    ['a=http://h:1|cpu=lots', 'cpu budget'],
    ['a=http://h:1|mem=-5', 'mem budget'],
    ['a=http://h:1|mem=4.5', 'mem budget'],
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

describe('usage-aware ranking (M16)', () => {
  type Sample = {
    sampledAt: string;
    cpuCount: number;
    memTotalMB: number;
    envs: { envId: string; cpu: number; memMB: number }[];
  };
  const sample = (cpu: number, memMB: number, over: Partial<Sample> = {}): Sample => ({
    sampledAt: new Date(0).toISOString(),
    cpuCount: 4,
    memTotalMB: 8192,
    envs: [{ envId: 'env_x', cpu, memMB }],
    ...over,
  });

  /** A fake host whose getHostStats is swappable per test. */
  function statsHost(name: string, getHostStats: () => Promise<Sample>) {
    return Object.assign(fakeHost(name), { getHostStats });
  }

  it('a fresh hot sample demotes a host out of the tie it would win on grants', async () => {
    let clock = 1_000;
    const a = statsHost('a', async () => sample(3, 128)); // 3/4 cores busy
    const b = statsHost('b', async () => sample(0.1, 64)); // idle
    const multi = new MultiHostSandboxCore(
      [
        { name: 'a', core: a, capacity: 4 },
        { name: 'b', core: b, capacity: 4 },
      ],
      { now: () => clock, statsStaleMs: 1_000 },
    );
    await multi.sampleStats();

    // Grants tie at zero → config order says a; the live signal says b.
    expect((await multi.createEnvironment(CREATE)).envId).toMatch(/^env_b_/);

    // Past the freshness window the samples fall away: pure grant ranking
    // again, and with one env now counted on b the tie-break returns to a.
    clock += 1_001;
    expect((await multi.createEnvironment(CREATE)).envId).toMatch(/^env_a_/);
  });

  it('weighs live usage against the declared budget when one exists', async () => {
    const clock = 1_000;
    // Same measured heat; a's operator budgeted 2 cores (fraction 1.5 — over),
    // b is unbudgeted so the physical 16 cores apply (fraction ~0.19).
    const a = statsHost('a', async () => sample(3, 64, { cpuCount: 16 }));
    const b = statsHost('b', async () => sample(3, 64, { cpuCount: 16 }));
    const multi = new MultiHostSandboxCore(
      [
        { name: 'a', core: a, capacity: 4, cpu: 8 },
        { name: 'b', core: b, capacity: 4 },
      ],
      { now: () => clock, statsStaleMs: 1_000 },
    );
    await multi.sampleStats();
    void clock;
    expect((await multi.createEnvironment(CREATE)).envId).toMatch(/^env_b_/);
  });

  it('never vetoes admission: the only fitting host places even when scorching', async () => {
    const clock = 1_000;
    const a = statsHost('a', async () => sample(3.9, 8000));
    const multi = new MultiHostSandboxCore([{ name: 'a', core: a, capacity: 4 }], {
      now: () => clock,
      statsStaleMs: 1_000,
    });
    await multi.sampleStats();
    void clock;
    expect((await multi.createEnvironment(CREATE)).envId).toMatch(/^env_a_/);
  });

  it('is byte-for-byte grant ranking when sampling never ran', async () => {
    const a = statsHost('a', async () => sample(4, 8192)); // would demote if consulted
    const b = statsHost('b', async () => sample(0, 0));
    const multi = new MultiHostSandboxCore([
      { name: 'a', core: a, capacity: 2 },
      { name: 'b', core: b, capacity: 2 },
    ]);
    expect((await multi.createEnvironment(CREATE)).envId).toMatch(/^env_a_/);
  });

  it('tolerates failing hosts: old samples persist, errors log on transitions only', async () => {
    let clock = 1_000;
    const logs: string[] = [];
    let mode: 'ok' | 'boom' | 'unsupported' = 'ok';
    const a = statsHost('a', async () => {
      if (mode === 'boom') throw new SandboxError('EXEC_FAILED', 'connection refused');
      if (mode === 'unsupported')
        throw new SandboxError('NOT_FOUND', 'this sandbox core does not report host stats');
      return sample(3, 128);
    });
    const b = statsHost('b', async () => sample(0.1, 64));
    const multi = new MultiHostSandboxCore(
      [
        { name: 'a', core: a, capacity: 4 },
        { name: 'b', core: b, capacity: 4 },
      ],
      { now: () => clock, statsStaleMs: 1_000, onLog: (line) => logs.push(line) },
    );
    await multi.sampleStats();

    // The next two rounds fail — the old sample holds (still fresh) and the
    // identical error logs once, not per round.
    mode = 'boom';
    clock += 400;
    await multi.sampleStats();
    clock += 400;
    await multi.sampleStats();
    expect(logs).toEqual(['stats: host a: connection refused']);
    expect((await multi.createEnvironment(CREATE)).envId).toMatch(/^env_b_/); // sample from t=1000 still fresh

    // A host that answers NOT_FOUND is "cannot report", a distinct transition.
    mode = 'unsupported';
    await multi.sampleStats();
    expect(logs[1]).toBe('stats: host a: host does not report stats');

    // Recovery logs the flip back and fresh data flows again.
    mode = 'ok';
    await multi.sampleStats();
    expect(logs[2]).toBe('stats: host a reporting again');
  });

  it('startStatsSampling: immediate round, guarded restarts, stop ends live ranking', async () => {
    let calls = 0;
    const a = statsHost('a', async () => {
      calls += 1;
      return sample(1, 64);
    });
    const multi = new MultiHostSandboxCore([{ name: 'a', core: a, capacity: 4 }]);
    expect(() => multi.startStatsSampling(0)).toThrow(/positive/);
    const stop = multi.startStatsSampling(60_000);
    expect(() => multi.startStatsSampling(60_000)).toThrow(/already running/);
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1); // the immediate round; the next is 60s out
    stop();
    const again = multi.startStatsSampling(60_000); // restart after stop is fine
    again();
  });

  it('statsIntervalFromEnv parses, defaults off, and refuses garbage', () => {
    expect(statsIntervalFromEnv({})).toBeUndefined();
    expect(statsIntervalFromEnv({ SANDBOX_STATS_INTERVAL_MS: '' })).toBeUndefined();
    expect(statsIntervalFromEnv({ SANDBOX_STATS_INTERVAL_MS: '0' })).toBeUndefined();
    expect(statsIntervalFromEnv({ SANDBOX_STATS_INTERVAL_MS: '15000' })).toBe(15_000);
    expect(() => statsIntervalFromEnv({ SANDBOX_STATS_INTERVAL_MS: 'fast' })).toThrow(
      /SANDBOX_STATS_INTERVAL_MS/,
    );
    expect(() => statsIntervalFromEnv({ SANDBOX_STATS_INTERVAL_MS: '-5' })).toThrow(
      /SANDBOX_STATS_INTERVAL_MS/,
    );
  });
});
