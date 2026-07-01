import { describe, expect, it } from 'vitest';
import {
  buildDevcontainerUpArgs,
  buildGitCloneArgs,
  mergeDevcontainerConfig,
  mountConfigEntries,
  parseDevcontainerUpOutput,
  resourceRunArgs,
} from './provision.js';

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
