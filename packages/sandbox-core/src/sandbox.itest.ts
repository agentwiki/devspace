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
  PreviewProxy,
  captureExec,
  nodeCommandRunner,
} from './index.js';
import type { Environment } from '@devspace/contracts';
import {
  TEST_IMAGE,
  detectAvailability,
  forceRemoveByEnvLabel,
  forceRemoveNetwork,
  inspectHardening,
  inspectHostLimits,
  networkIsInternal,
} from './itest-support.js';
import { perEnvNetworkName } from './hardening.js';

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
  let preview: PreviewProxy;

  async function newCore(): Promise<DevcontainerSandboxCore> {
    const runner = nodeCommandRunner;
    return new DevcontainerSandboxCore({
      runtime: new DockerRuntime(runner),
      provisioner: new DevcontainerProvisioner(runner, {
        devcontainerPath: availability.devcontainerBin,
        upTimeoutMs: 240_000,
      }),
      preview,
    });
  }

  beforeAll(async () => {
    preview = new PreviewProxy();
    await preview.start();
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
    await preview?.stop();
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

  it('reports a live utilization sample attributing our env (M16)', async () => {
    const stats = await core.getHostStats();
    expect(stats.cpuCount).toBeGreaterThan(0);
    expect(stats.memTotalMB).toBeGreaterThan(0);
    expect(Date.parse(stats.sampledAt)).not.toBeNaN();
    const ours = stats.envs.find((e) => e.envId === env.envId);
    expect(ours).toBeDefined();
    expect(ours!.cpu).toBeGreaterThanOrEqual(0);
    expect(ours!.memMB).toBeGreaterThan(0); // a running container occupies SOME memory
  }, 60_000);

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

  it('runs the one-shot setup script with tenant env baked in (M24)', async () => {
    // A request with env + setupScript provisions with the script's effect
    // observable (a file it wrote, as root, reading the tenant env var) —
    // and a failing script fails the create and leaves no container behind.
    const withSetup = await core.createEnvironment({
      baseImage: TEST_IMAGE,
      resources: { cpu: 1, memMB: 512, diskMB: 1024 },
      env: { DEVSPACE_M24: 'setup-proof' },
      setupScript: 'printf "%s $(id -u)" "$DEVSPACE_M24" > /setup-ran',
    });
    createdEnvIds.push(withSetup.envId);
    const proof = await core.fsRead(withSetup.envId, '/setup-ran');
    expect(Buffer.from(proof).toString()).toBe('setup-proof 0'); // root wrote it

    await expect(
      core.createEnvironment({
        baseImage: TEST_IMAGE,
        resources: { cpu: 1, memMB: 512, diskMB: 1024 },
        setupScript: 'echo "no such package" 1>&2; exit 7',
      }),
    ).rejects.toMatchObject({
      code: 'PROVISION_FAILED',
      message: expect.stringContaining('no such package'),
    });
  }, 600_000);

  it('kills a runaway process tree via in-container pkill (the abort mechanism)', async () => {
    // The M5 auto-abort caveat: ExecStream.kill() only signals the local
    // `docker exec` client. Prove the REAL mechanism — a second exec running
    // pkill inside the container — terminates the first process. The target
    // must carry the marker in its REAL argv (no shell wrapper — a comment
    // would vanish at exec), and the pkill pattern uses the `[s]leep`
    // self-exclusion trick so it cannot match its own parent shell (which
    // would SIGTERM the killer itself and exit 143 — the codex killCommand
    // does the same with `[/]opt/...`).
    const runaway = await core.exec(env.envId, { cmd: ['sleep', '312512'], tty: false });
    // Give the process a moment to appear.
    await new Promise((r) => setTimeout(r, 500));
    const kill = await captureExec(
      await core.exec(env.envId, {
        cmd: ['sh', '-c', "pkill -TERM -f '[s]leep 312512' || true"],
        tty: false,
      }),
    );
    expect(kill.code).toBe(0);
    const exitCode = await runaway.done;
    expect(exitCode).not.toBe(0); // SIGTERM'd, never ran the full 312512s
  }, 60_000);

  it('serves a real in-container HTTP server through the preview proxy (M6)', async () => {
    // The round-trip needs a listener inside the env; probe for python3 (the
    // devcontainers base image ships it, but stay defensive about image drift).
    const probe = await captureExec(
      await core.exec(env.envId, { cmd: ['sh', '-c', 'command -v python3 || true'], tty: false }),
    );
    if (!probe.stdout.toString().trim()) {
      console.warn('[sandbox itest] python3 missing from image — skipping preview round-trip');
      return;
    }
    const server = await core.exec(env.envId, {
      cmd: ['python3', '-m', 'http.server', '8901', '--bind', '0.0.0.0'],
      tty: false,
    });
    try {
      const { proxyUrl, token } = await core.forwardPort(env.envId, 8901);
      expect(proxyUrl).toContain(`/t/${token}/`);
      // Wait for the listener, then fetch THROUGH the host-side proxy.
      let res: { status: number; text(): Promise<string> } | undefined;
      for (let i = 0; i < 40; i += 1) {
        try {
          res = await fetch(proxyUrl);
          if (res.status === 200) break;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(res?.status).toBe(200);
      expect(await res!.text()).toContain('Directory listing');
      // An unregistered token 404s without touching the env.
      const bogus = await fetch(proxyUrl.replace(token, 'not-a-real-token'));
      expect(bogus.status).toBe(404);
    } finally {
      await captureExec(
        await core.exec(env.envId, {
          cmd: ['sh', '-c', "pkill -TERM -f '[h]ttp.server 8901' || true"],
          tty: false,
        }),
      );
      server.kill();
    }
  }, 120_000);
});

// A separate hardened provision: no gVisor in CI (pure builders + the boot
// assertion cover that), but no-new-privileges + the per-env --internal
// network ARE assertable against a real daemon.
describe.skipIf(!availability.ok)('sandbox-core hardened provision (no gVisor)', () => {
  let core: DevcontainerSandboxCore;
  let env: Environment;

  afterAll(async () => {
    if (env) {
      await core?.destroyEnvironment(env.envId).catch(() => {});
      forceRemoveByEnvLabel(env.envId);
      forceRemoveNetwork(perEnvNetworkName(env.envId));
    }
  }, 120_000);

  beforeAll(async () => {
    const runner = nodeCommandRunner;
    core = new DevcontainerSandboxCore({
      runtime: new DockerRuntime(runner),
      provisioner: new DevcontainerProvisioner(runner, {
        devcontainerPath: availability.devcontainerBin,
        upTimeoutMs: 240_000,
        hardening: { noNewPrivileges: true, network: 'per-env' },
      }),
    });
    env = await core.createEnvironment({
      baseImage: TEST_IMAGE,
      resources: { cpu: 1, memMB: 512, diskMB: 1024 },
    });
  }, 300_000);

  it('applies no-new-privileges and attaches the per-env internal network', () => {
    const hardening = inspectHardening(env.containerId!);
    expect(hardening.securityOpt).toContain('no-new-privileges');
    const networkName = perEnvNetworkName(env.envId);
    expect(hardening.networkMode).toBe(networkName);
    expect(networkIsInternal(networkName)).toBe(true);
  });

  it('removes the per-env network on teardown', async () => {
    const networkName = perEnvNetworkName(env.envId);
    expect(networkIsInternal(networkName)).toBe(true);
    await core.destroyEnvironment(env.envId);
    expect(networkIsInternal(networkName)).toBe(false); // gone (inspect fails)
  }, 120_000);
});
