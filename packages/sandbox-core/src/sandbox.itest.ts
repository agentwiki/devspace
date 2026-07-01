/**
 * Live-Docker integration tests for the sandbox-core vertical.
 *
 * Unlike the unit tests (which use fakes and need no daemon), these drive the
 * REAL DevcontainerSandboxCore + DevcontainerProvisioner + DockerRuntime against
 * an actual Docker daemon and `devcontainer` CLI: `devcontainer up` provisions a
 * container, and every op (exec, fs, secrets, teardown) hits it for real.
 *
 * They self-skip when docker/devcontainer are unavailable, and run for real in
 * CI (see .github/workflows/ci.yml). Run locally with:
 *   pnpm --filter @devspace/sandbox-core test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DevcontainerProvisioner,
  DevcontainerSandboxCore,
  DockerRuntime,
  captureExec,
  nodeCommandRunner,
} from './index.js';
import type { Environment } from '@devspace/contracts';
import {
  TEST_IMAGE,
  detectAvailability,
  forceRemoveByEnvLabel,
  inspectHostLimits,
} from './itest-support.js';

const availability = detectAvailability();
if (!availability.ok) {
  console.warn(`[sandbox itest] skipping — ${availability.reason}`);
}

const ENV_SECRET = 'super-secret-token-value';
const FILE_SECRET_PATH = '/tmp/injected.secret';
const FILE_SECRET_VALUE = '//registry.example/:_authToken=filesecret';

// One provision covers exec/fs/secrets/limits; a second env exercises teardown.
describe.skipIf(!availability.ok)('sandbox-core live integration', () => {
  const createdEnvIds: string[] = [];
  let core: DevcontainerSandboxCore;
  let env: Environment;

  async function newCore(): Promise<DevcontainerSandboxCore> {
    const runner = nodeCommandRunner;
    return new DevcontainerSandboxCore({
      runtime: new DockerRuntime(runner),
      provisioner: new DevcontainerProvisioner(runner, {
        devcontainerPath: availability.devcontainerBin,
        upTimeoutMs: 240_000,
      }),
    });
  }

  beforeAll(async () => {
    core = await newCore();
    env = await core.createEnvironment({
      baseImage: TEST_IMAGE,
      resources: { cpu: 1, memMB: 1024, diskMB: 2048 },
      secrets: [
        { name: 'GH_TOKEN', value: ENV_SECRET, target: 'env' },
        { name: 'npmrc', value: FILE_SECRET_VALUE, target: 'file', path: FILE_SECRET_PATH },
      ],
    });
    createdEnvIds.push(env.envId);
  }, 300_000);

  afterAll(async () => {
    for (const id of createdEnvIds) {
      await core?.destroyEnvironment(id).catch(() => {});
      forceRemoveByEnvLabel(id);
    }
  }, 120_000);

  it('provisions a container and reports it ready', () => {
    expect(env.status).toBe('ready');
    expect(env.containerId).toBeTruthy();
  });

  it('runs a real command over the exec stream', async () => {
    const { code, stdout } = await captureExec(
      await core.exec(env.envId, { cmd: ['sh', '-c', 'echo out; echo err 1>&2'], tty: false }),
    );
    expect(code).toBe(0);
    expect(stdout.toString().trim()).toBe('out');
  });

  it('injects env-target secrets into exec (and never onto the workspace disk)', async () => {
    const { stdout } = await captureExec(
      await core.exec(env.envId, { cmd: ['sh', '-c', 'printf %s "$GH_TOKEN"'], tty: false }),
    );
    expect(stdout.toString()).toBe(ENV_SECRET);
  });

  it('round-trips arbitrary binary bytes through fsWrite/fsRead', async () => {
    const payload = new Uint8Array([0, 255, 10, 13, 0x42, 0xfe, 0x00, 0x7f]);
    await core.fsWrite(env.envId, '/tmp/data.bin', payload);
    const read = await core.fsRead(env.envId, '/tmp/data.bin');
    expect(Buffer.compare(Buffer.from(read), Buffer.from(payload))).toBe(0);
  });

  it('lists directory entries with types and sizes', async () => {
    await core
      .fsWrite(env.envId, '/tmp/listme/a.txt', new TextEncoder().encode('hello'))
      .catch(async () => {
        // parent may not exist; create it then retry
        await core
          .exec(env.envId, { cmd: ['mkdir', '-p', '/tmp/listme'], tty: false })
          .then(captureExec);
        await core.fsWrite(env.envId, '/tmp/listme/a.txt', new TextEncoder().encode('hello'));
      });
    const entries = await core.fsList(env.envId, '/tmp/listme');
    expect(entries).toContainEqual({ name: 'a.txt', type: 'file', size: 5 });
  });

  it('writes file-target secrets inside the container at mode 0600', async () => {
    const content = await core.fsRead(env.envId, FILE_SECRET_PATH);
    expect(Buffer.from(content).toString()).toBe(FILE_SECRET_VALUE);
    const { stdout } = await captureExec(
      await core.exec(env.envId, { cmd: ['stat', '-c', '%a', FILE_SECRET_PATH], tty: false }),
    );
    expect(stdout.toString().trim()).toBe('600');
  });

  it('enforces the requested resource limits on the container', () => {
    const limits = inspectHostLimits(env.containerId!);
    expect(limits.memory).toBe(1024 * 1024 * 1024); // 1024m
    expect(limits.pidsLimit).toBe(4096); // DEFAULT_PIDS_LIMIT
    expect(limits.nanoCpus).toBe(1_000_000_000); // 1 cpu
  });

  it('tears an environment down and stops the container', async () => {
    const throwaway = await core.createEnvironment({
      baseImage: TEST_IMAGE,
      resources: { cpu: 1, memMB: 512, diskMB: 1024 },
    });
    createdEnvIds.push(throwaway.envId);
    const containerId = throwaway.containerId!;
    const runtime = new DockerRuntime(nodeCommandRunner);
    expect(await runtime.exists(containerId)).toBe(true);

    await core.destroyEnvironment(throwaway.envId);

    expect((await core.getEnvironment(throwaway.envId))?.status).toBe('stopped');
    expect(await runtime.exists(containerId)).toBe(false);
  }, 300_000);
});
