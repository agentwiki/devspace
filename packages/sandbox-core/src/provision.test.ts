import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandRunner, RunResult } from './cli.js';
import {
  DevcontainerProvisioner,
  GIT_REFRESH_RESET_ARGS,
  buildDevcontainerUpArgs,
  buildGitCloneArgs,
  buildGitRefreshArgs,
  mergeDevcontainerConfig,
  mountConfigEntries,
  parseDevcontainerUpOutput,
  resourceRunArgs,
} from './provision.js';
import type { DevcontainerConfig } from './provision.js';

describe('resourceRunArgs', () => {
  it('maps cpu/mem to enforceable docker flags plus a pids cap', () => {
    expect(resourceRunArgs({ cpu: 2, memMB: 4096, diskMB: 20480 })).toEqual([
      '--cpus=2',
      '--memory=4096m',
      '--pids-limit=4096',
    ]);
  });

  it('honors a custom pids limit', () => {
    expect(resourceRunArgs({ cpu: 1, memMB: 512, diskMB: 1024 }, 128)).toContain(
      '--pids-limit=128',
    );
  });
});

describe('mountConfigEntries', () => {
  it('classifies absolute paths as bind and names as volumes', () => {
    expect(
      mountConfigEntries([
        { source: '/host/cache', target: '/cache', ro: false },
        { source: 'agent-runtime', target: '/opt/agent', ro: true },
      ]),
    ).toEqual([
      'type=bind,source=/host/cache,target=/cache',
      'type=volume,source=agent-runtime,target=/opt/agent,readonly',
    ]);
  });
});

describe('mergeDevcontainerConfig', () => {
  it('defaults the image only when the repo config defines no build source', () => {
    const config = mergeDevcontainerConfig({
      baseImage: 'ubuntu:24.04',
      resources: { cpu: 1, memMB: 1024, diskMB: 1024 },
      mounts: [],
    });
    expect(config.image).toBe('ubuntu:24.04');
    expect(config.runArgs).toEqual(['--cpus=1', '--memory=1024m', '--pids-limit=4096']);
  });

  it('does not override a repo image and appends our runArgs/mounts', () => {
    const config = mergeDevcontainerConfig({
      repoConfig: {
        image: 'node:22',
        runArgs: ['--init'],
        mounts: ['type=volume,source=x,target=/x'],
      },
      baseImage: 'ubuntu:24.04',
      resources: { cpu: 4, memMB: 8192, diskMB: 1024 },
      mounts: [{ source: '/h', target: '/t', ro: false }],
    });
    expect(config.image).toBe('node:22');
    expect(config.runArgs).toEqual(['--init', '--cpus=4', '--memory=8192m', '--pids-limit=4096']);
    expect(config.mounts).toEqual([
      'type=volume,source=x,target=/x',
      'type=bind,source=/h,target=/t',
    ]);
  });

  it('lets an explicit override win over the repo config', () => {
    const config = mergeDevcontainerConfig({
      repoConfig: { image: 'node:22' },
      override: { image: 'node:20' },
      resources: { cpu: 1, memMB: 1024, diskMB: 1024 },
      mounts: [],
    });
    expect(config.image).toBe('node:20');
  });

  it('leaves the image unset when a Dockerfile build source is present', () => {
    const config = mergeDevcontainerConfig({
      repoConfig: { dockerFile: 'Dockerfile' },
      baseImage: 'ubuntu:24.04',
      resources: { cpu: 1, memMB: 1024, diskMB: 1024 },
      mounts: [],
    });
    expect(config.image).toBeUndefined();
  });

  it('appends hardening runArgs after resource args (never clobbering)', () => {
    const config = mergeDevcontainerConfig({
      repoConfig: { runArgs: ['--init'] },
      resources: { cpu: 1, memMB: 1024, diskMB: 2048 },
      mounts: [],
      hardening: { runtime: 'runsc', noNewPrivileges: true, enforceDiskQuota: true },
      networkName: 'devspace-net-e1',
    });
    expect(config.runArgs).toEqual([
      '--init',
      '--cpus=1',
      '--memory=1024m',
      '--pids-limit=4096',
      '--runtime=runsc',
      '--security-opt=no-new-privileges',
      '--network=devspace-net-e1',
      '--storage-opt=size=2048m',
    ]);
  });

  it('merges policy containerEnv OVER the repo config (policy wins)', () => {
    const config = mergeDevcontainerConfig({
      repoConfig: { containerEnv: { HTTP_PROXY: 'http://evil:1', KEEP: 'yes' } },
      resources: { cpu: 1, memMB: 1024, diskMB: 1024 },
      mounts: [],
      containerEnv: { HTTP_PROXY: 'http://gw:3128' },
    });
    expect(config.containerEnv).toEqual({ HTTP_PROXY: 'http://gw:3128', KEEP: 'yes' });
  });

  it('emits no containerEnv key when neither side sets one', () => {
    const config = mergeDevcontainerConfig({
      resources: { cpu: 1, memMB: 1024, diskMB: 1024 },
      mounts: [],
    });
    expect('containerEnv' in config).toBe(false);
  });
});

describe('argv builders', () => {
  it('builds a shallow clone, with and without a ref', () => {
    expect(buildGitCloneArgs('https://x/r.git', '/ws')).toEqual([
      'clone',
      '--depth',
      '1',
      '--',
      'https://x/r.git',
      '/ws',
    ]);
    expect(buildGitCloneArgs('https://x/r.git', '/ws', 'main')).toEqual([
      'clone',
      '--depth',
      '1',
      '--branch',
      'main',
      '--',
      'https://x/r.git',
      '/ws',
    ]);
  });

  it('builds the claim-time refresh fetch, HEAD when no ref is pinned', () => {
    expect(buildGitRefreshArgs('main')).toEqual(['fetch', '--depth', '1', 'origin', 'main']);
    expect(buildGitRefreshArgs()).toEqual(['fetch', '--depth', '1', 'origin', 'HEAD']);
    expect(GIT_REFRESH_RESET_ARGS).toEqual(['reset', '--hard', 'FETCH_HEAD']);
  });

  it('builds devcontainer up args with config + id label', () => {
    expect(
      buildDevcontainerUpArgs({
        workspaceFolder: '/ws',
        configPath: '/ws/.devspace/devcontainer.json',
        idLabel: 'devspace.envId=e1',
      }),
    ).toEqual([
      'up',
      '--workspace-folder',
      '/ws',
      '--config',
      '/ws/.devspace/devcontainer.json',
      '--id-label',
      'devspace.envId=e1',
    ]);
  });
});

describe('parseDevcontainerUpOutput', () => {
  it('extracts the containerId from the JSON result line', () => {
    const stdout = [
      '[12:00:00] resolving...',
      '{"outcome":"success","containerId":"abc123","remoteUser":"node"}',
    ].join('\n');
    const result = parseDevcontainerUpOutput(stdout);
    expect(result.containerId).toBe('abc123');
    expect(result.remoteUser).toBe('node');
  });

  it('ignores non-JSON noise and picks the last JSON result', () => {
    const stdout = [
      'warning: something',
      '{"foo":1}',
      '{"outcome":"success","containerId":"zzz"}',
    ].join('\n');
    expect(parseDevcontainerUpOutput(stdout).containerId).toBe('zzz');
  });

  it('throws on an error outcome', () => {
    expect(() => parseDevcontainerUpOutput('{"outcome":"error","message":"boom"}')).toThrow(
      /failed/,
    );
  });

  it('throws when no result is present', () => {
    expect(() => parseDevcontainerUpOutput('just logs, no json')).toThrow(/could not parse/);
  });
});

describe('DevcontainerProvisioner with a per-env network profile', () => {
  interface Call {
    command: string;
    args: readonly string[];
  }

  /** Scripted runner: succeed everything; `devcontainer up` may be failed. */
  function fakeRunner(opts: { failUp?: boolean }): { runner: CommandRunner; calls: Call[] } {
    const calls: Call[] = [];
    const runner: CommandRunner = {
      async run(command, args): Promise<RunResult> {
        calls.push({ command, args });
        if (command === 'devcontainer') {
          return opts.failUp
            ? { code: 1, stdout: '', stderr: 'boom' }
            : { code: 0, stdout: '{"outcome":"success","containerId":"c1"}', stderr: '' };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          return { code: 0, stdout: '172.20.0.1\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      stream() {
        throw new Error('unused');
      },
    };
    return { runner, calls };
  }

  const req = {
    resources: { cpu: 1, memMB: 1024, diskMB: 1024 },
    mounts: [],
    secrets: [],
  };

  it('creates the internal network before `up` and reports it in the result', async () => {
    const { runner, calls } = fakeRunner({});
    const provisioner = new DevcontainerProvisioner(runner, {
      workspaceRoot: await mkdtemp(join(tmpdir(), 'prov-test-')),
      hardening: { network: 'per-env', egressProxyUrl: 'http://gw:3128' },
    });

    const result = await provisioner.provision('e1', req);
    expect(result.containerId).toBe('c1');
    expect(result.networkName).toBe('devspace-net-e1');

    const networkCreate = calls.findIndex(
      (c) => c.command === 'docker' && c.args[0] === 'network' && c.args[1] === 'create',
    );
    const up = calls.findIndex((c) => c.command === 'devcontainer');
    expect(networkCreate).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(networkCreate);
    expect(calls[networkCreate]!.args).toEqual([
      'network',
      'create',
      '--internal',
      'devspace-net-e1',
    ]);

    // The synthesized config carries the network runArg + the proxy env.
    const upArgs = calls[up]!.args;
    const configPath = upArgs[upArgs.indexOf('--config') + 1]!;
    const config = JSON.parse(await readFile(configPath, 'utf8')) as DevcontainerConfig;
    expect(config.runArgs).toContain('--network=devspace-net-e1');
    expect(config.containerEnv?.HTTPS_PROXY).toBe('http://gw:3128');
  });

  it('removes the created network and the workspace when `up` fails', async () => {
    const { runner, calls } = fakeRunner({ failUp: true });
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'prov-test-'));
    const provisioner = new DevcontainerProvisioner(runner, {
      workspaceRoot,
      hardening: { network: 'per-env' },
    });

    await expect(provisioner.provision('e2', req)).rejects.toThrow(/exited 1/);
    expect(
      calls.some((c) => c.command === 'docker' && c.args[0] === 'network' && c.args[1] === 'rm'),
    ).toBe(true);
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it("resolves the per-env network's own gateway for the proxy env", async () => {
    // An --internal network reaches the host only at ITS OWN bridge gateway,
    // so a static proxy URL cannot work — the provisioner must resolve it.
    const { runner, calls } = fakeRunner({});
    const provisioner = new DevcontainerProvisioner(runner, {
      workspaceRoot: await mkdtemp(join(tmpdir(), 'prov-test-')),
      hardening: { network: 'per-env', egressProxyPort: 3128 },
    });

    await provisioner.provision('e4', req);
    const upArgs = calls.find((c) => c.command === 'devcontainer')!.args;
    const configPath = upArgs[upArgs.indexOf('--config') + 1]!;
    const config = JSON.parse(await readFile(configPath, 'utf8')) as DevcontainerConfig;
    expect(config.containerEnv?.HTTP_PROXY).toBe('http://172.20.0.1:3128');
    expect(config.containerEnv?.HTTPS_PROXY).toBe('http://172.20.0.1:3128');
  });

  it('neither creates nor reports a network for a named-network profile', async () => {
    const { runner, calls } = fakeRunner({});
    const provisioner = new DevcontainerProvisioner(runner, {
      workspaceRoot: await mkdtemp(join(tmpdir(), 'prov-test-')),
      hardening: { network: 'shared-net' },
    });

    const result = await provisioner.provision('e3', req);
    expect(result.networkName).toBeUndefined();
    expect(calls.some((c) => c.args[0] === 'network')).toBe(false);
    const upArgs = calls.find((c) => c.command === 'devcontainer')!.args;
    const configPath = upArgs[upArgs.indexOf('--config') + 1]!;
    const config = JSON.parse(await readFile(configPath, 'utf8')) as DevcontainerConfig;
    expect(config.runArgs).toContain('--network=shared-net');
  });
});
