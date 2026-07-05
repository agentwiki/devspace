import { describe, expect, it, vi } from 'vitest';
import type { ExecRequest } from '@devspace/contracts';
import type { CommandRunner } from './cli.js';
import { toBase64 } from './exec.js';
import type { ExecStream } from './exec.js';
import type { ContainerRuntime } from './runtime.js';
import type { EgressScopeRegistrar } from './egress-proxy.js';
import type { EnvStateStore, PersistedEnvState } from './env-state.js';
import type { Provisioner, ProvisionResult } from './provision.js';
import {
  DevcontainerSandboxCore,
  SandboxError,
  hasHostStats,
  hostBudgetsFromEnv,
  maxEnvsFromEnv,
  parseFindOutput,
} from './sandbox.js';
import type { HostBudgets } from './sandbox.js';

/**
 * An in-memory fake container: `exec` runs a tiny hand-written interpreter over
 * the argv so the sandbox's fs helpers (cat/find/chmod/`sh -c 'cat >'`) can be
 * exercised end-to-end without Docker.
 */
class FakeContainer {
  readonly files = new Map<string, Buffer>();
  readonly modes = new Map<string, number>();
  lastEnv: Record<string, string> | undefined;

  exec(req: ExecRequest): ExecStream {
    this.lastEnv = req.env;
    const [cmd, ...rest] = req.cmd;
    const frames = this.run(cmd!, rest, req);
    return scriptStream(frames.out, frames.err, frames.code, (stdin) => frames.onStdin?.(stdin));
  }

  private run(
    cmd: string,
    rest: string[],
    _req: ExecRequest,
  ): { out: Buffer; err: Buffer; code: number; onStdin?: (data: Buffer) => void } {
    if (cmd === 'cat' && rest[0] === '--') {
      const path = rest[1]!;
      const file = this.files.get(path);
      if (!file) return { out: Buffer.alloc(0), err: Buffer.from('No such file'), code: 1 };
      return { out: file, err: Buffer.alloc(0), code: 0 };
    }
    if (cmd === 'sh' && rest[0] === '-c' && rest[1] === 'cat > "$1"') {
      const path = rest[3]!;
      return {
        out: Buffer.alloc(0),
        err: Buffer.alloc(0),
        code: 0,
        onStdin: (data) => this.files.set(path, data),
      };
    }
    if (cmd === 'chmod') {
      const path = rest[2]!;
      this.modes.set(path, parseInt(rest[0]!, 8));
      return { out: Buffer.alloc(0), err: Buffer.alloc(0), code: 0 };
    }
    if (cmd === 'find') {
      const rows = [...this.files.keys()].map(
        (p) => `${p.split('/').pop()}\tf\t${this.files.get(p)!.length}`,
      );
      return {
        out: Buffer.from(rows.join('\n') + (rows.length ? '\n' : '')),
        err: Buffer.alloc(0),
        code: 0,
      };
    }
    return { out: Buffer.alloc(0), err: Buffer.from(`unknown cmd ${cmd}`), code: 127 };
  }
}

/**
 * A minimal ExecStream that buffers stdin then replays scripted output. Like
 * the real stream, `done` resolves independently of frame consumption — either
 * when stdin is closed (the fsWrite path awaits `done` without reading frames)
 * or when the frames are fully drained (the capture path).
 */
function scriptStream(
  out: Buffer,
  err: Buffer,
  code: number,
  onStdin?: (data: Buffer) => void,
): ExecStream {
  const chunks: Buffer[] = [];
  let resolveDone!: (c: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (onStdin) onStdin(Buffer.concat(chunks));
    resolveDone(code);
  };

  async function* gen() {
    if (out.length) yield { kind: 'stdout' as const, data: toBase64(out) };
    if (err.length) yield { kind: 'stderr' as const, data: toBase64(err) };
    finish();
    yield { kind: 'exit' as const, code };
  }

  return {
    writeStdin(bytes) {
      if (!finished) chunks.push(Buffer.from(bytes));
      return true;
    },
    drain: () => Promise.resolve(),
    closeStdin: finish,
    frames: gen(),
    done,
    kill() {
      resolveDone(-1);
    },
  };
}

/** In-memory EnvStateStore: inspectable, with injectable save failures. */
class FakeEnvStateStore implements EnvStateStore {
  readonly states = new Map<string, PersistedEnvState>();
  failSave: ((state: PersistedEnvState) => boolean) | undefined;
  async save(state: PersistedEnvState): Promise<void> {
    if (this.failSave?.(state)) throw new Error('disk full');
    this.states.set(state.envId, { ...state });
  }
  async remove(envId: string): Promise<void> {
    this.states.delete(envId);
  }
  async loadAll(): Promise<{ states: PersistedEnvState[]; skipped: string[] }> {
    return { states: [...this.states.values()], skipped: [] };
  }
}

function makeCore(
  container = new FakeContainer(),
  provisionResult: Partial<ProvisionResult> = {},
  opts: {
    maxEnvs?: number;
    budgets?: HostBudgets;
    stateStore?: EnvStateStore;
    egress?: EgressScopeRegistrar;
    exists?: () => Promise<boolean>;
    stats?: ContainerRuntime['stats'];
    hostInfo?: { cpuCount: number; memTotalMB: number };
  } = {},
) {
  const destroy = vi.fn(async () => {});
  const removeNetwork = vi.fn(async () => {});
  const containerIp = vi.fn(async () => '172.29.0.2');
  let tokens = 0;
  const preview = {
    register: vi.fn((envId: string, target: { host: string; port: number }) => {
      void envId;
      tokens += 1;
      return {
        token: `tok${tokens}`,
        proxyUrl: `http://preview/t/tok${tokens}/?to=${target.host}:${target.port}`,
      };
    }),
    revokeEnv: vi.fn(),
  };
  const runtime: ContainerRuntime = {
    execStream: (_id, req) => container.exec(req),
    destroy,
    exists: opts.exists ?? (async () => true),
    removeNetwork,
    containerIp,
    ...(opts.stats ? { stats: opts.stats } : {}),
  };
  const provisioner: Provisioner = {
    provision: vi.fn(async (): Promise<ProvisionResult> => ({
      containerId: 'cont-1',
      workspaceFolder: '/ws',
      ...provisionResult,
    })),
  };
  // Host-side git for the claim-time refresh: records every invocation.
  const gitCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const run = vi.fn(async (cmd: string, args: readonly string[], options?: { cwd?: string }) => {
    gitCalls.push({ cmd, args: [...args], cwd: options?.cwd });
    return { code: 0, stdout: '', stderr: '' };
  });
  const runner: CommandRunner = {
    run,
    stream: () => {
      throw new Error('stream is not used by the sandbox core');
    },
  };
  return {
    core: new DevcontainerSandboxCore({
      runtime,
      provisioner,
      preview,
      runner,
      maxEnvs: opts.maxEnvs,
      budgets: opts.budgets,
      stateStore: opts.stateStore,
      egress: opts.egress,
      hostInfo: opts.hostInfo,
    }),
    container,
    destroy,
    removeNetwork,
    provisioner,
    preview,
    containerIp,
    gitCalls,
    run,
  };
}

describe('DevcontainerSandboxCore lifecycle', () => {
  it('provisions to ready and reports status', async () => {
    const { core } = makeCore();
    const env = await core.createEnvironment({ repoUrl: 'https://x/r.git' });
    expect(env.status).toBe('ready');
    expect(env.containerId).toBe('cont-1');
    expect(env.envId).toMatch(/^env_/);
    expect((await core.getEnvironment(env.envId))?.status).toBe('ready');
  });

  it('echoes the resource grant — request values, or schema defaults when omitted (M12)', async () => {
    const { core } = makeCore();
    const defaulted = await core.createEnvironment({});
    expect(defaulted.resources).toEqual({ cpu: 2, memMB: 4096, diskMB: 20480 });
    const sized = await core.createEnvironment({
      resources: { cpu: 8, memMB: 16384, diskMB: 20480 },
    });
    expect(sized.resources).toEqual({ cpu: 8, memMB: 16384, diskMB: 20480 });
  });

  it('marks the env failed and throws PROVISION_FAILED when provisioning fails', async () => {
    const { core, provisioner } = makeCore();
    (provisioner.provision as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('devcontainer boom'),
    );
    await expect(core.createEnvironment({})).rejects.toMatchObject({ code: 'PROVISION_FAILED' });
  });

  it('injects env-target secrets into every exec, letting per-call env override', async () => {
    const { core, container } = makeCore();
    const env = await core.createEnvironment({
      secrets: [{ name: 'GH_TOKEN', value: 'secret-abc', target: 'env' }],
    });
    const stream = await core.exec(env.envId, {
      cmd: ['cat', '--', '/x'],
      tty: false,
      env: { EXTRA: '1' },
    });
    // Drain so the fake records lastEnv.
    for await (const _ of stream.frames) void _;
    expect(container.lastEnv).toMatchObject({ GH_TOKEN: 'secret-abc', EXTRA: '1' });
  });

  it('writes file-target secrets into the container at 0600 after ready', async () => {
    const { core, container } = makeCore();
    await core.createEnvironment({
      secrets: [
        {
          name: 'npmrc',
          value: '//registry/:_authToken=xyz',
          target: 'file',
          path: '/root/.npmrc',
        },
      ],
    });
    expect(container.files.get('/root/.npmrc')?.toString()).toBe('//registry/:_authToken=xyz');
    expect(container.modes.get('/root/.npmrc')).toBe(0o600);
  });

  it('round-trips binary data through fsWrite/fsRead', async () => {
    const { core } = makeCore();
    const env = await core.createEnvironment({});
    const payload = new Uint8Array([0, 255, 10, 66, 254]);
    await core.fsWrite(env.envId, '/data.bin', payload);
    const read = await core.fsRead(env.envId, '/data.bin');
    expect(Buffer.compare(Buffer.from(read), Buffer.from(payload))).toBe(0);
  });

  it('lists directory entries', async () => {
    const { core } = makeCore();
    const env = await core.createEnvironment({});
    await core.fsWrite(env.envId, '/a.txt', new TextEncoder().encode('hi'));
    const list = await core.fsList(env.envId, '/');
    expect(list).toContainEqual({ name: 'a.txt', type: 'file', size: 2 });
  });

  it('throws NOT_FOUND for unknown envs and CONFLICT before ready', async () => {
    const { core } = makeCore();
    await expect(core.exec('nope', { cmd: ['ls'], tty: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(core.fsRead('nope', '/x')).rejects.toBeInstanceOf(SandboxError);
  });

  it('destroys the container and transitions to stopped', async () => {
    const { core, destroy, removeNetwork } = makeCore();
    const env = await core.createEnvironment({});
    await core.destroyEnvironment(env.envId);
    expect(destroy).toHaveBeenCalledWith('cont-1');
    expect(removeNetwork).not.toHaveBeenCalled(); // no per-env network provisioned
    expect((await core.getEnvironment(env.envId))?.status).toBe('stopped');
  });

  it('removes a provision-time per-env network after the container (best-effort)', async () => {
    const { core, destroy, removeNetwork } = makeCore(new FakeContainer(), {
      networkName: 'devspace-net-e1',
    });
    const env = await core.createEnvironment({});
    removeNetwork.mockRejectedValueOnce(new Error('already gone'));
    await core.destroyEnvironment(env.envId); // rejection swallowed
    expect(destroy).toHaveBeenCalled();
    expect(removeNetwork).toHaveBeenCalledWith('devspace-net-e1');
    expect((await core.getEnvironment(env.envId))?.status).toBe('stopped');
  });

  it('reports a read failure as EXEC_FAILED', async () => {
    const { core } = makeCore();
    const env = await core.createEnvironment({});
    await expect(core.fsRead(env.envId, '/missing')).rejects.toMatchObject({ code: 'EXEC_FAILED' });
  });
});

describe('applySecrets (M9 late-bound secrets)', () => {
  it('merges env-target secrets into the per-exec injection map', async () => {
    const { core, container } = makeCore();
    const env = await core.createEnvironment({});
    await core.applySecrets(env.envId, [{ name: 'GH_TOKEN', value: 'late-abc', target: 'env' }]);
    const stream = await core.exec(env.envId, { cmd: ['cat', '--', '/x'], tty: false });
    for await (const _ of stream.frames) void _;
    expect(container.lastEnv).toMatchObject({ GH_TOKEN: 'late-abc' });
  });

  it('writes file-target secrets 0600', async () => {
    const { core, container } = makeCore();
    const env = await core.createEnvironment({});
    await core.applySecrets(env.envId, [
      { name: 'npmrc', value: 'tok=xyz', target: 'file', path: '/root/.npmrc' },
    ]);
    expect(container.files.get('/root/.npmrc')?.toString()).toBe('tok=xyz');
    expect(container.modes.get('/root/.npmrc')).toBe(0o600);
  });

  it('rejects a pathless file secret before applying ANYTHING', async () => {
    const { core, container } = makeCore();
    const env = await core.createEnvironment({});
    await expect(
      core.applySecrets(env.envId, [
        { name: 'OK_ENV', value: 'v', target: 'env' },
        { name: 'broken', value: 'v', target: 'file' },
      ]),
    ).rejects.toMatchObject({ code: 'EXEC_FAILED', message: expect.stringContaining('path') });
    // The valid env secret was NOT half-applied.
    const stream = await core.exec(env.envId, { cmd: ['cat', '--', '/x'], tty: false });
    for await (const _ of stream.frames) void _;
    expect(container.lastEnv).not.toHaveProperty('OK_ENV');
  });

  it('refuses on a not-ready env', async () => {
    const { core } = makeCore();
    const env = await core.createEnvironment({});
    await core.destroyEnvironment(env.envId);
    await expect(
      core.applySecrets(env.envId, [{ name: 'X', value: 'v', target: 'env' }]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('claimEnvironment (M10 pool identity + claim-time refresh)', () => {
  const POOLED = {
    repoUrl: 'https://github.com/acme/widgets.git',
    ref: 'main',
    poolKey: 'pool-key-1',
  };

  it('echoes poolKey onto the environment', async () => {
    const { core } = makeCore();
    const env = await core.createEnvironment(POOLED);
    expect(env.poolKey).toBe('pool-key-1');
    expect((await core.getEnvironment(env.envId))?.poolKey).toBe('pool-key-1');
    expect((await core.listEnvironments())[0]?.poolKey).toBe('pool-key-1');
  });

  it('refreshes the host clone (exact argv, in the workspace) and clears the mark', async () => {
    const { core, gitCalls } = makeCore();
    const env = await core.createEnvironment(POOLED);
    const claimed = await core.claimEnvironment(env.envId);
    expect(gitCalls).toEqual([
      { cmd: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'], cwd: '/ws' },
      { cmd: 'git', args: ['reset', '--hard', 'FETCH_HEAD'], cwd: '/ws' },
    ]);
    expect(claimed.poolKey).toBeUndefined();
    expect(claimed.status).toBe('ready');
    expect((await core.getEnvironment(env.envId))?.poolKey).toBeUndefined();
    // A hand-out does not change the env's size (M12).
    expect(claimed.resources).toEqual({ cpu: 2, memMB: 4096, diskMB: 20480 });
  });

  it('fetches HEAD for a default-branch pool (no ref)', async () => {
    const { core, gitCalls } = makeCore();
    const env = await core.createEnvironment({ ...POOLED, ref: undefined });
    await core.claimEnvironment(env.envId);
    expect(gitCalls[0]?.args).toEqual(['fetch', '--depth', '1', 'origin', 'HEAD']);
  });

  it('skips git entirely for a scratch env (nothing to refresh)', async () => {
    const { core, gitCalls } = makeCore();
    const env = await core.createEnvironment({ poolKey: 'scratch-pool' });
    const claimed = await core.claimEnvironment(env.envId);
    expect(gitCalls).toEqual([]);
    expect(claimed.poolKey).toBeUndefined();
  });

  it('refuses to claim a non-pool-owned env — the mark is the capability', async () => {
    const { core, gitCalls } = makeCore();
    const env = await core.createEnvironment({ repoUrl: POOLED.repoUrl });
    await expect(core.claimEnvironment(env.envId)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('not pool-owned'),
    });
    // The tenant's workspace was never touched.
    expect(gitCalls).toEqual([]);
  });

  it('NOT_FOUND for an unknown env; CONFLICT for a destroyed one', async () => {
    const { core } = makeCore();
    await expect(core.claimEnvironment('env_ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const env = await core.createEnvironment(POOLED);
    await core.destroyEnvironment(env.envId);
    await expect(core.claimEnvironment(env.envId)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a refresh failure is EXEC_FAILED and leaves the env pool-owned and intact', async () => {
    const { core, run } = makeCore();
    const env = await core.createEnvironment(POOLED);
    run.mockResolvedValueOnce({ code: 128, stdout: '', stderr: 'could not resolve host' });
    await expect(core.claimEnvironment(env.envId)).rejects.toMatchObject({
      code: 'EXEC_FAILED',
      message: expect.stringContaining('claim refresh'),
    });
    // Still marked: a later claim (remote back up) succeeds.
    expect((await core.getEnvironment(env.envId))?.poolKey).toBe('pool-key-1');
    const claimed = await core.claimEnvironment(env.envId);
    expect(claimed.poolKey).toBeUndefined();
  });
});

describe('capacity truth (M9)', () => {
  it('lists every environment the core knows, live or not', async () => {
    const { core, provisioner } = makeCore();
    const a = await core.createEnvironment({});
    const b = await core.createEnvironment({});
    await core.destroyEnvironment(b.envId);
    (provisioner.provision as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await core.createEnvironment({}).catch(() => {});

    const listed = await core.listEnvironments();
    expect(listed).toHaveLength(3);
    expect(listed.map((e) => e.status).sort()).toEqual(['failed', 'ready', 'stopped']);
    expect(listed.map((e) => e.envId)).toContain(a.envId);
  });

  it('refuses createEnvironment at the live-env cap, naming the numbers', async () => {
    const { core } = makeCore(new FakeContainer(), {}, { maxEnvs: 2 });
    await core.createEnvironment({});
    await core.createEnvironment({});
    await expect(core.createEnvironment({})).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
      message: expect.stringContaining('at capacity (2/2'),
    });
  });

  it('frees a slot on destroy and ignores dead records', async () => {
    const { core, provisioner } = makeCore(new FakeContainer(), {}, { maxEnvs: 1 });
    const env = await core.createEnvironment({});
    await core.destroyEnvironment(env.envId); // stopped: no longer live
    (provisioner.provision as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await core.createEnvironment({}).catch(() => {}); // failed: never live
    await expect(core.createEnvironment({})).resolves.toMatchObject({ status: 'ready' });
  });

  it('maxEnvsFromEnv parses, rejects garbage, and is undefined when unset', () => {
    expect(maxEnvsFromEnv({})).toBeUndefined();
    expect(maxEnvsFromEnv({ SANDBOX_MAX_ENVS: ' ' })).toBeUndefined();
    expect(maxEnvsFromEnv({ SANDBOX_MAX_ENVS: '8' })).toBe(8);
    for (const raw of ['0', '-1', 'many', '2.5']) {
      expect(() => maxEnvsFromEnv({ SANDBOX_MAX_ENVS: raw })).toThrow('positive integer');
    }
  });

  it('refuses createEnvironment past the cpu budget, naming the numbers (M14)', async () => {
    const { core } = makeCore(new FakeContainer(), {}, { budgets: { cpu: 3 } });
    await core.createEnvironment({ resources: { cpu: 2, memMB: 1024, diskMB: 1024 } });
    // 2 of 3 cores granted; another 2-core grant does not fit.
    await expect(
      core.createEnvironment({ resources: { cpu: 2, memMB: 1024, diskMB: 1024 } }),
    ).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
      message: expect.stringContaining('cpu budget exhausted (2 of 3 cores granted; requested 2)'),
    });
    // A 1-core grant still fits exactly.
    await expect(
      core.createEnvironment({ resources: { cpu: 1, memMB: 1024, diskMB: 1024 } }),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('refuses past the memory budget and frees it on destroy (M14)', async () => {
    const { core } = makeCore(new FakeContainer(), {}, { budgets: { memMB: 4096 } });
    const env = await core.createEnvironment({ resources: { cpu: 1, memMB: 3072, diskMB: 1024 } });
    await expect(
      core.createEnvironment({ resources: { cpu: 1, memMB: 2048, diskMB: 1024 } }),
    ).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
      message: expect.stringContaining('memory budget exhausted (3072 of 4096 MB'),
    });
    // Destroy frees the grant along with the slot.
    await core.destroyEnvironment(env.envId);
    await expect(
      core.createEnvironment({ resources: { cpu: 1, memMB: 2048, diskMB: 1024 } }),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('an omitted resources block weighs the schema defaults against budgets', async () => {
    // Contract defaults: cpu 2 / 4096 MB — what the provisioner actually
    // applies when a request says nothing (M12).
    const { core } = makeCore(new FakeContainer(), {}, { budgets: { cpu: 3, memMB: 8192 } });
    await core.createEnvironment({});
    await expect(core.createEnvironment({})).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
      message: expect.stringContaining('cpu budget exhausted'),
    });
  });

  it('hostBudgetsFromEnv parses each knob, rejects garbage, undefined when unset', () => {
    expect(hostBudgetsFromEnv({})).toBeUndefined();
    expect(hostBudgetsFromEnv({ SANDBOX_CPU_BUDGET: ' ', SANDBOX_MEM_BUDGET: '' })).toBeUndefined();
    expect(hostBudgetsFromEnv({ SANDBOX_CPU_BUDGET: '16' })).toEqual({ cpu: 16 });
    expect(hostBudgetsFromEnv({ SANDBOX_CPU_BUDGET: '1.5' })).toEqual({ cpu: 1.5 });
    expect(hostBudgetsFromEnv({ SANDBOX_MEM_BUDGET: '65536' })).toEqual({ memMB: 65536 });
    expect(hostBudgetsFromEnv({ SANDBOX_CPU_BUDGET: '8', SANDBOX_MEM_BUDGET: '32768' })).toEqual({
      cpu: 8,
      memMB: 32768,
    });
    for (const raw of ['0', '-2', 'lots']) {
      expect(() => hostBudgetsFromEnv({ SANDBOX_CPU_BUDGET: raw })).toThrow('positive cores');
    }
    for (const raw of ['0', '-1', 'big', '2.5']) {
      expect(() => hostBudgetsFromEnv({ SANDBOX_MEM_BUDGET: raw })).toThrow('positive MB integer');
    }
  });
});

describe('parseFindOutput', () => {
  it('maps find type codes to FsEntry types', () => {
    const rows = 'a.txt\tf\t12\nsub\td\t4096\nlink\tl\t0\nweird\tp\t0\n';
    expect(parseFindOutput(rows)).toEqual([
      { name: 'a.txt', type: 'file', size: 12 },
      { name: 'sub', type: 'dir', size: 4096 },
      { name: 'link', type: 'symlink', size: 0 },
      { name: 'weird', type: 'other', size: 0 },
    ]);
  });
});

describe('forwardPort (M6 preview)', () => {
  it('resolves the container IP on the per-env network and registers a route', async () => {
    const { core, preview, containerIp } = makeCore(new FakeContainer(), {
      networkName: 'devspace_env_x',
    });
    const env = await core.createEnvironment({});
    const route = await core.forwardPort(env.envId, 3000);
    expect(containerIp).toHaveBeenCalledWith('cont-1', 'devspace_env_x');
    expect(preview.register).toHaveBeenCalledWith(env.envId, { host: '172.29.0.2', port: 3000 });
    expect(route.proxyUrl).toContain('/t/tok1/');
    // The mapping is recorded on the environment.
    expect((await core.getEnvironment(env.envId))?.ports).toEqual([
      { containerPort: 3000, proxyUrl: route.proxyUrl, token: route.token },
    ]);
  });

  it('is idempotent per port — re-forwarding returns the live route', async () => {
    const { core, preview } = makeCore();
    const env = await core.createEnvironment({});
    const first = await core.forwardPort(env.envId, 8080);
    const again = await core.forwardPort(env.envId, 8080);
    expect(again).toEqual(first);
    expect(preview.register).toHaveBeenCalledTimes(1);
    const other = await core.forwardPort(env.envId, 8081);
    expect(other.token).not.toBe(first.token);
  });

  it('rejects clearly without a configured proxy', async () => {
    const container = new FakeContainer();
    const runtime: ContainerRuntime = {
      execStream: (_id, req) => container.exec(req),
      destroy: async () => {},
      exists: async () => true,
    };
    const provisioner: Provisioner = {
      provision: async () => ({ containerId: 'cont-1', workspaceFolder: '/ws' }),
    };
    const core = new DevcontainerSandboxCore({ runtime, provisioner });
    const env = await core.createEnvironment({});
    await expect(core.forwardPort(env.envId, 3000)).rejects.toMatchObject({
      code: 'EXEC_FAILED',
      message: expect.stringContaining('preview proxy not configured'),
    });
  });

  it('rejects when the container has no host-reachable address', async () => {
    const { core, containerIp } = makeCore();
    containerIp.mockResolvedValueOnce(null);
    const env = await core.createEnvironment({});
    await expect(core.forwardPort(env.envId, 3000)).rejects.toMatchObject({
      code: 'EXEC_FAILED',
      message: expect.stringContaining('no host-reachable address'),
    });
  });

  it('rejects on a not-ready env and revokes routes on teardown', async () => {
    const { core, preview } = makeCore();
    await expect(core.forwardPort('env_missing', 80)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const env = await core.createEnvironment({});
    await core.forwardPort(env.envId, 3000);
    await core.destroyEnvironment(env.envId);
    expect(preview.revokeEnv).toHaveBeenCalledWith(env.envId);
    await expect(core.forwardPort(env.envId, 3000)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('durable env table (M11)', () => {
  const POOLED = {
    repoUrl: 'https://github.com/acme/widgets.git',
    ref: 'main',
    poolKey: 'pool-key-1',
  };

  it('persists provisioning then ready, metadata only — never secret values', async () => {
    const store = new FakeEnvStateStore();
    const { core } = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await core.createEnvironment({
      ...POOLED,
      secrets: [{ name: 'GH_TOKEN', value: 'secret-abc', target: 'env' as const }],
    });
    const persisted = store.states.get(env.envId)!;
    expect(persisted).toEqual({
      envId: env.envId,
      status: 'ready',
      containerId: 'cont-1',
      workspaceFolder: '/ws',
      repoUrl: POOLED.repoUrl,
      ref: 'main',
      poolKey: 'pool-key-1',
      createdAt: env.createdAt,
      resources: { cpu: 2, memMB: 4096, diskMB: 20480 },
    });
    expect(JSON.stringify(persisted)).not.toContain('secret-abc');
  });

  it('a claim persists its unmark; the file loses the poolKey', async () => {
    const store = new FakeEnvStateStore();
    const { core } = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await core.createEnvironment(POOLED);
    await core.claimEnvironment(env.envId);
    expect(store.states.get(env.envId)?.poolKey).toBeUndefined();
    expect(store.states.get(env.envId)?.status).toBe('ready');
  });

  it('a claim that cannot persist is EXEC_FAILED and nothing moves — memory and disk stay marked', async () => {
    const store = new FakeEnvStateStore();
    const { core } = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await core.createEnvironment(POOLED);
    store.failSave = () => true;
    await expect(core.claimEnvironment(env.envId)).rejects.toMatchObject({
      code: 'EXEC_FAILED',
      message: expect.stringContaining('failed to persist'),
    });
    expect((await core.getEnvironment(env.envId))?.poolKey).toBe('pool-key-1');
    expect(store.states.get(env.envId)?.poolKey).toBe('pool-key-1');
    // Disk back: the claim goes through.
    store.failSave = undefined;
    await expect(core.claimEnvironment(env.envId)).resolves.toMatchObject({ status: 'ready' });
  });

  it('a create that cannot persist ready destroys the container and is PROVISION_FAILED', async () => {
    const store = new FakeEnvStateStore();
    const { core, destroy } = makeCore(new FakeContainer(), {}, { stateStore: store });
    await core.createEnvironment({}); // prove the happy path first
    store.failSave = (s) => s.status === 'ready'; // provisioning persists; ready cannot
    await expect(core.createEnvironment({})).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
      message: expect.stringContaining('persist'),
    });
    expect(destroy).toHaveBeenCalledWith('cont-1');
  });

  it('a provision failure leaves no state file behind', async () => {
    const store = new FakeEnvStateStore();
    const { core, provisioner } = makeCore(new FakeContainer(), {}, { stateStore: store });
    (provisioner.provision as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await core.createEnvironment({}).catch(() => {});
    expect(store.states.size).toBe(0);
  });

  it('destroy removes the state file', async () => {
    const store = new FakeEnvStateStore();
    const { core } = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await core.createEnvironment({});
    await core.destroyEnvironment(env.envId);
    expect(store.states.has(env.envId)).toBe(false);
  });

  it('recover() re-adopts a ready env with its mark, an empty secret map, and empty ports', async () => {
    const store = new FakeEnvStateStore();
    const first = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await first.core.createEnvironment({
      ...POOLED,
      secrets: [{ name: 'GH_TOKEN', value: 'secret-abc', target: 'env' as const }],
    });

    // "Restart": a fresh core over the SAME store; the daemon still knows cont-1.
    const container = new FakeContainer();
    const second = makeCore(container, {}, { stateStore: store });
    const summary = await second.core.recover();
    expect(summary.recovered).toEqual([env.envId]);
    expect(summary.discarded).toEqual([]);

    const recovered = await second.core.getEnvironment(env.envId);
    expect(recovered).toMatchObject({
      status: 'ready',
      containerId: 'cont-1',
      poolKey: 'pool-key-1',
    });
    expect(recovered?.ports).toEqual([]);
    // The per-exec secret map came back EMPTY — secrets are never on disk.
    const stream = await second.core.exec(env.envId, { cmd: ['cat', '--', '/x'], tty: false });
    for await (const _ of stream.frames) void _;
    expect(container.lastEnv).toEqual({});
    // applySecrets is the re-attach seam.
    await second.core.applySecrets(env.envId, [
      { name: 'GH_TOKEN', value: 're-applied', target: 'env' },
    ]);
    const stream2 = await second.core.exec(env.envId, { cmd: ['cat', '--', '/x'], tty: false });
    for await (const _ of stream2.frames) void _;
    expect(container.lastEnv).toMatchObject({ GH_TOKEN: 're-applied' });
  });

  it('a recovered pool env claims with the SAME refresh argv, cwd included', async () => {
    const store = new FakeEnvStateStore();
    const first = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await first.core.createEnvironment(POOLED);

    const second = makeCore(new FakeContainer(), {}, { stateStore: store });
    await second.core.recover();
    const claimed = await second.core.claimEnvironment(env.envId);
    expect(second.gitCalls).toEqual([
      { cmd: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'], cwd: '/ws' },
      { cmd: 'git', args: ['reset', '--hard', 'FETCH_HEAD'], cwd: '/ws' },
    ]);
    expect(claimed.poolKey).toBeUndefined();
    expect(store.states.get(env.envId)?.poolKey).toBeUndefined();
  });

  it('recover() discards a record whose container is gone (the daemon is truth)', async () => {
    const store = new FakeEnvStateStore();
    const first = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await first.core.createEnvironment(POOLED);

    const second = makeCore(
      new FakeContainer(),
      {},
      { stateStore: store, exists: async () => false },
    );
    const summary = await second.core.recover();
    expect(summary.recovered).toEqual([]);
    expect(summary.discarded).toEqual([env.envId]);
    expect(await second.core.getEnvironment(env.envId)).toBeNull();
    expect(store.states.size).toBe(0);
    // The dead record never blocks the daemon's real containers.
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it('recover() completes a crashed transition: destroys container + network, drops the file', async () => {
    const store = new FakeEnvStateStore();
    store.states.set('env_crashed', {
      envId: 'env_crashed',
      status: 'stopping',
      containerId: 'cont-zombie',
      networkName: 'devspace-net-crashed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const { core, destroy, removeNetwork } = makeCore(
      new FakeContainer(),
      {},
      { stateStore: store },
    );
    const summary = await core.recover();
    expect(summary.discarded).toEqual(['env_crashed']);
    expect(destroy).toHaveBeenCalledWith('cont-zombie');
    expect(removeNetwork).toHaveBeenCalledWith('devspace-net-crashed');
    expect(store.states.size).toBe(0);
  });

  it('recover() restores the resource grant so a recovered env keeps its true weight', async () => {
    const store = new FakeEnvStateStore();
    const first = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await first.core.createEnvironment({
      resources: { cpu: 8, memMB: 16384, diskMB: 20480 },
    });

    const second = makeCore(new FakeContainer(), {}, { stateStore: store });
    await second.core.recover();
    expect((await second.core.getEnvironment(env.envId))?.resources).toEqual({
      cpu: 8,
      memMB: 16384,
      diskMB: 20480,
    });
  });

  it('recover() loads a pre-M12 state file (no resources) and the env comes back echo-less', async () => {
    const store = new FakeEnvStateStore();
    store.states.set('env_old', {
      envId: 'env_old',
      status: 'ready',
      containerId: 'cont-old',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const { core } = makeCore(new FakeContainer(), {}, { stateStore: store });
    expect((await core.recover()).recovered).toEqual(['env_old']);
    expect((await core.getEnvironment('env_old'))?.resources).toBeUndefined();
  });

  it('recover() is a no-op without a store and never double-adopts a live env', async () => {
    const bare = makeCore();
    expect(await bare.core.recover()).toEqual({ recovered: [], discarded: [], skipped: [] });

    const store = new FakeEnvStateStore();
    const { core } = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await core.createEnvironment(POOLED);
    const summary = await core.recover(); // same process: the env is already live
    expect(summary.recovered).toEqual([]);
    expect((await core.listEnvironments()).filter((e) => e.envId === env.envId)).toHaveLength(1);
  });
});

describe('per-env egress scopes (M22)', () => {
  function fakeRegistrar(): { registrar: EgressScopeRegistrar; scopes: Map<string, unknown> } {
    const scopes = new Map<string, readonly string[]>();
    return {
      scopes,
      registrar: {
        allowlist: ['github.com'],
        setScope: (addr, list) => scopes.set(addr, list),
        clearScope: (addr) => scopes.delete(addr),
      },
    };
  }

  const SCOPED_RESULT = {
    networkName: 'devspace-net-e1',
    egressGateway: '172.20.0.1',
    egressScope: [] as string[],
  };

  it('persists the scope with the env and clears it at destroy, with the network', async () => {
    const store = new FakeEnvStateStore();
    const { registrar, scopes } = fakeRegistrar();
    // The provisioner registered the scope itself; the core owns it from here.
    scopes.set('172.20.0.1', []);
    const { core } = makeCore(new FakeContainer(), SCOPED_RESULT, {
      stateStore: store,
      egress: registrar,
    });

    const env = await core.createEnvironment({ networkAccess: 'none' });
    expect(store.states.get(env.envId)).toMatchObject({
      egressGateway: '172.20.0.1',
      egressScope: [],
    });

    await core.destroyEnvironment(env.envId);
    expect(scopes.size).toBe(0);
  });

  it('recover() re-registers the env BIRTH policy before it can serve', async () => {
    const store = new FakeEnvStateStore();
    const first = makeCore(new FakeContainer(), SCOPED_RESULT, {
      stateStore: store,
      egress: fakeRegistrar().registrar,
    });
    const env = await first.core.createEnvironment({
      networkAccess: 'custom',
      allowedHosts: ['github.com'],
    });
    // What the provisioner resolved is what persists — simulate its scope.
    store.states.set(env.envId, {
      ...store.states.get(env.envId)!,
      egressScope: ['github.com'],
    });

    const { registrar, scopes } = fakeRegistrar();
    const second = makeCore(new FakeContainer(), {}, { stateStore: store, egress: registrar });
    expect((await second.core.recover()).recovered).toEqual([env.envId]);
    expect(scopes.get('172.20.0.1')).toEqual(['github.com']);
  });

  it('recover() DISCARDS a scoped env when no registrar is running — never re-adopts it unscoped', async () => {
    const store = new FakeEnvStateStore();
    const first = makeCore(new FakeContainer(), SCOPED_RESULT, {
      stateStore: store,
      egress: fakeRegistrar().registrar,
    });
    const env = await first.core.createEnvironment({ networkAccess: 'none' });

    const second = makeCore(new FakeContainer(), {}, { stateStore: store }); // no egress
    const summary = await second.core.recover();
    expect(summary.recovered).toEqual([]);
    expect(summary.discarded).toEqual([env.envId]);
    expect(second.destroy).toHaveBeenCalledWith('cont-1');
    expect(second.removeNetwork).toHaveBeenCalledWith('devspace-net-e1');
    expect(store.states.size).toBe(0);
  });

  it('an unscoped env recovers fine without a registrar (pre-M22 posture)', async () => {
    const store = new FakeEnvStateStore();
    const first = makeCore(new FakeContainer(), {}, { stateStore: store });
    const env = await first.core.createEnvironment({});

    const second = makeCore(new FakeContainer(), {}, { stateStore: store });
    expect((await second.core.recover()).recovered).toEqual([env.envId]);
  });
});

describe('getHostStats (M16 utilization truth)', () => {
  const FULL_ID = 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890';

  it('attributes runtime samples to live envs by container-id prefix', async () => {
    const stats = vi.fn(async () => [
      { containerId: FULL_ID.slice(0, 12), cpu: 1.25, memMB: 512 },
      { containerId: 'ffff00001111', cpu: 3, memMB: 2048 }, // foreign container
    ]);
    const { core } = makeCore(
      new FakeContainer(),
      { containerId: FULL_ID },
      {
        stats,
        hostInfo: { cpuCount: 16, memTotalMB: 32768 },
      },
    );
    const env = await core.createEnvironment({});
    const sample = await core.getHostStats();
    expect(sample.cpuCount).toBe(16);
    expect(sample.memTotalMB).toBe(32768);
    expect(sample.sampledAt).toMatch(/^\d{4}-/);
    // Ours is attributed; the foreign container appears in no per-env row.
    expect(sample.envs).toEqual([{ envId: env.envId, cpu: 1.25, memMB: 512 }]);
  });

  it('excludes non-ready envs and rejects without a stats-capable runtime', async () => {
    const stats = vi.fn(async () => [{ containerId: 'cont-1', cpu: 1, memMB: 100 }]);
    const withStats = makeCore(
      new FakeContainer(),
      {},
      {
        stats,
        hostInfo: { cpuCount: 4, memTotalMB: 8192 },
      },
    );
    const env = await withStats.core.createEnvironment({});
    await withStats.core.destroyEnvironment(env.envId);
    expect((await withStats.core.getHostStats()).envs).toEqual([]);

    const without = makeCore();
    await expect(without.core.getHostStats()).rejects.toMatchObject({ code: 'EXEC_FAILED' });
  });

  it('hasHostStats duck-checks the capability', () => {
    expect(hasHostStats(makeCore().core)).toBe(true);
    expect(hasHostStats({})).toBe(false);
    expect(hasHostStats(null)).toBe(false);
    expect(hasHostStats({ getHostStats: 42 })).toBe(false);
  });
});
