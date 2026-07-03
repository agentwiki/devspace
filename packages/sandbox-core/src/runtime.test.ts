import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from './cli.js';
import { createScriptedExecStream } from './exec.js';
import {
  DockerRuntime,
  dockerExecArgs,
  dockerInspectArgs,
  dockerInspectNetworksArgs,
  dockerRmArgs,
  parseContainerIp,
} from './runtime.js';

describe('docker argv builders', () => {
  it('builds an interactive exec with cwd/user/env', () => {
    expect(
      dockerExecArgs('c1', {
        cmd: ['bash', '-lc', 'echo hi'],
        cwd: '/workspace',
        user: 'node',
        env: { A: '1', B: '2' },
        tty: false,
      }),
    ).toEqual([
      'exec',
      '-i',
      '-w',
      '/workspace',
      '-u',
      'node',
      '-e',
      'A=1',
      '-e',
      'B=2',
      'c1',
      'bash',
      '-lc',
      'echo hi',
    ]);
  });

  it('adds -t only when a tty is requested', () => {
    expect(dockerExecArgs('c1', { cmd: ['sh'], tty: true })).toEqual([
      'exec',
      '-i',
      '-t',
      'c1',
      'sh',
    ]);
    expect(dockerExecArgs('c1', { cmd: ['sh'], tty: false })).toEqual(['exec', '-i', 'c1', 'sh']);
  });

  it('force-removes with volumes and inspects by id', () => {
    expect(dockerRmArgs('c1')).toEqual(['rm', '--force', '--volumes', 'c1']);
    expect(dockerInspectArgs('c1')).toEqual(['inspect', '--format', '{{.Id}}', 'c1']);
  });
});

describe('DockerRuntime', () => {
  it('routes exec through the runner.stream seam with the built argv', () => {
    const stream = createScriptedExecStream([{ kind: 'exit', code: 0 }]);
    const runner: CommandRunner = {
      run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
      stream: vi.fn(() => stream),
    };
    const rt = new DockerRuntime(runner, { dockerPath: '/usr/bin/docker' });
    const result = rt.execStream('c1', { cmd: ['ls'], tty: false });
    expect(result).toBe(stream);
    expect(runner.stream).toHaveBeenCalledWith('/usr/bin/docker', ['exec', '-i', 'c1', 'ls']);
  });

  it('throws when destroy exits non-zero', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such container' })),
      stream: vi.fn(),
    };
    await expect(new DockerRuntime(runner).destroy('c1')).rejects.toThrow(/no such container/);
  });

  it('reports existence from the inspect exit code', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_c, args) => ({
        code: args.includes('gone') ? 1 : 0,
        stdout: '',
        stderr: '',
      })),
      stream: vi.fn(),
    };
    const rt = new DockerRuntime(runner);
    expect(await rt.exists('live')).toBe(true);
    expect(await rt.exists('gone')).toBe(false);
  });
});

describe('parseContainerIp (M6 preview)', () => {
  const NETWORKS = JSON.stringify({
    bridge: { IPAddress: '172.17.0.3' },
    devspace_env_1: { IPAddress: '172.29.0.2' },
  });

  it('builds the inspect argv', () => {
    expect(dockerInspectNetworksArgs('c1')).toEqual([
      'inspect',
      '--format',
      '{{json .NetworkSettings.Networks}}',
      'c1',
    ]);
  });

  it('prefers the named per-env network', () => {
    expect(parseContainerIp(NETWORKS, 'devspace_env_1')).toBe('172.29.0.2');
  });

  it('returns null when the named network is absent or unaddressed', () => {
    expect(parseContainerIp(NETWORKS, 'nope')).toBeNull();
    expect(parseContainerIp(JSON.stringify({ n: { IPAddress: '' } }), 'n')).toBeNull();
  });

  it('falls back to the first addressed network when unnamed', () => {
    expect(parseContainerIp(NETWORKS)).toBe('172.17.0.3');
    expect(
      parseContainerIp(JSON.stringify({ a: { IPAddress: '' }, b: { IPAddress: '10.0.0.9' } })),
    ).toBe('10.0.0.9');
  });

  it('is total: junk, null, and shapeless JSON all map to null', () => {
    expect(parseContainerIp('not json')).toBeNull();
    expect(parseContainerIp('null')).toBeNull();
    expect(parseContainerIp('{}')).toBeNull();
    expect(parseContainerIp('{"n": "weird"}')).toBeNull();
  });

  it('DockerRuntime.containerIp parses the runner output (and null on failure)', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_c, args) => ({
        code: (args as string[]).includes('gone') ? 1 : 0,
        stdout: NETWORKS,
        stderr: '',
      })),
      stream: vi.fn(),
    };
    const rt = new DockerRuntime(runner);
    expect(await rt.containerIp('c1', 'devspace_env_1')).toBe('172.29.0.2');
    expect(await rt.containerIp('gone')).toBeNull();
  });
});
