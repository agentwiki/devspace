/**
 * The M11 story end-to-end, no Docker: a sandbox HOST restart. A second
 * DevcontainerSandboxCore over the SAME real FileEnvStateStore and a fake
 * daemon that still knows the containers recovers its table, and the M9/M10
 * machinery upstream — the warm-pool orphan sweep — re-adopts recovered
 * warm stock exactly as it re-adopts an orchestrator crash's, because both
 * only ever read `listEnvironments()`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateEnvironmentRequest } from '@devspace/contracts';
import type { CommandRunner } from './cli.js';
import { FileEnvStateStore } from './env-state.js';
import type { ContainerRuntime } from './runtime.js';
import type { Provisioner, ProvisionResult } from './provision.js';
import { DevcontainerSandboxCore } from './sandbox.js';
import { WarmPoolSandboxCore } from './warm-pool.js';

/** The "daemon": containers survive a host-process restart; cores share it. */
class FakeDaemon {
  readonly live = new Set<string>();
  private seq = 0;

  provisioner(): Provisioner & { count: () => number } {
    let count = 0;
    return {
      count: () => count,
      provision: async (): Promise<ProvisionResult> => {
        count += 1;
        const containerId = `cont-${++this.seq}`;
        this.live.add(containerId);
        return { containerId, workspaceFolder: `/ws/${containerId}` };
      },
    };
  }

  runtime(): ContainerRuntime {
    return {
      execStream: () => {
        throw new Error('exec not used in this composition');
      },
      destroy: async (containerId) => {
        this.live.delete(containerId);
      },
      exists: async (containerId) => this.live.has(containerId),
      removeNetwork: async () => {},
    };
  }
}

const runner: CommandRunner = {
  run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  stream: () => {
    throw new Error('stream not used in this composition');
  },
};

const TEMPLATE: CreateEnvironmentRequest = {
  repoUrl: 'https://github.com/acme/widgets.git',
  ref: 'main',
  resources: { cpu: 2, memMB: 4096, diskMB: 20480 },
  mounts: [],
  secrets: [],
};

function host(daemon: FakeDaemon, store: FileEnvStateStore) {
  const provisioner = daemon.provisioner();
  const core = new DevcontainerSandboxCore({
    runtime: daemon.runtime(),
    provisioner,
    runner,
    stateStore: store,
  });
  return { core, provisioner };
}

describe('host restart composition (M11 over M9/M10)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devspace-restart-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recovered warm stock is re-adopted by fill() instead of re-provisioned', async () => {
    const daemon = new FakeDaemon();

    // Life before the crash: a warm pool of 2, filled and marked.
    const before = host(daemon, new FileEnvStateStore(dir));
    const poolBefore = new WarmPoolSandboxCore(before.core, [{ template: TEMPLATE, size: 2 }]);
    await poolBefore.fill();
    expect(before.provisioner.count()).toBe(2);
    expect(daemon.live.size).toBe(2);

    // The host process dies and comes back: same state dir, same daemon.
    const after = host(daemon, new FileEnvStateStore(dir));
    const summary = await after.core.recover();
    expect(summary.recovered).toHaveLength(2);

    const poolAfter = new WarmPoolSandboxCore(after.core, [{ template: TEMPLATE, size: 2 }], {
      onLog: () => {},
    });
    await poolAfter.fill();
    // The sweep re-adopted the recovered envs — nothing new was provisioned.
    expect(after.provisioner.count()).toBe(0);
    expect(poolAfter.warmCount(TEMPLATE)).toBe(2);

    // And a claim hands one out: unmarked, refreshed, in milliseconds.
    const claimed = await poolAfter.createEnvironment(TEMPLATE);
    expect(claimed.status).toBe('ready');
    expect(claimed.poolKey).toBeUndefined();
    expect(after.provisioner.count()).toBe(0);
  });

  it('a container that died with the host is discarded, and fill() replaces it', async () => {
    const daemon = new FakeDaemon();
    const before = host(daemon, new FileEnvStateStore(dir));
    const poolBefore = new WarmPoolSandboxCore(before.core, [{ template: TEMPLATE, size: 2 }]);
    await poolBefore.fill();

    // One warm container did not survive (OOM-killed while the host was down).
    const [dead] = [...daemon.live];
    daemon.live.delete(dead!);

    const after = host(daemon, new FileEnvStateStore(dir));
    const summary = await after.core.recover();
    expect(summary.recovered).toHaveLength(1);
    expect(summary.discarded).toHaveLength(1);

    const poolAfter = new WarmPoolSandboxCore(after.core, [{ template: TEMPLATE, size: 2 }], {
      onLog: () => {},
    });
    await poolAfter.fill();
    // One re-adopted + one freshly provisioned = back at size.
    expect(poolAfter.warmCount(TEMPLATE)).toBe(2);
    expect(after.provisioner.count()).toBe(1);
  });

  it('a recovered TENANT env is never touched by the sweep and still serves', async () => {
    const daemon = new FakeDaemon();
    const before = host(daemon, new FileEnvStateStore(dir));
    const tenant = await before.core.createEnvironment(TEMPLATE); // unmarked

    const after = host(daemon, new FileEnvStateStore(dir));
    await after.core.recover();
    const poolAfter = new WarmPoolSandboxCore(after.core, [{ template: TEMPLATE, size: 1 }], {
      onLog: () => {},
    });
    await poolAfter.fill();

    // The tenant env was not adopted (no mark) and was not destroyed.
    expect(poolAfter.warmCount(TEMPLATE)).toBe(1);
    expect((await after.core.getEnvironment(tenant.envId))?.status).toBe('ready');
    await expect(after.core.claimEnvironment(tenant.envId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
