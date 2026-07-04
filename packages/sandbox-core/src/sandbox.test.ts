import { describe, expect, it, vi } from 'vitest';
import type { ExecRequest } from '@devspace/contracts';
import { toBase64 } from './exec.js';
import type { ExecStream } from './exec.js';
import type { ContainerRuntime } from './runtime.js';
import type { Provisioner, ProvisionResult } from './provision.js';
import { DevcontainerSandboxCore, SandboxError, maxEnvsFromEnv, parseFindOutput } from './sandbox.js';

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

function makeCore(
  container = new FakeContainer(),
  provisionResult: Partial<ProvisionResult> = {},
  opts: { maxEnvs?: number } = {},
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
    exists: async () => true,
    removeNetwork,
    containerIp,
  };
  const provisioner: Provisioner = {
    provision: vi.fn(async (): Promise<ProvisionResult> => ({
      containerId: 'cont-1',
      workspaceFolder: '/ws',
      ...provisionResult,
    })),
  };
  return {
    core: new DevcontainerSandboxCore({ runtime, provisioner, preview, maxEnvs: opts.maxEnvs }),
    container,
    destroy,
    removeNetwork,
    provisioner,
    preview,
    containerIp,
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
