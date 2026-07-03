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

    expect(b.calls).toEqual([`fsRead:${envB}:/x`, `fsList:${envB}:/z`]);
    expect(a.calls).toEqual([`fsWrite:${envA}:/y`, `forwardPort:${envA}:3000`]);
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
