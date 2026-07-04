import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from './cli.js';
import { createScriptedExecStream } from './exec.js';
import {
  DockerRuntime,
  dockerExecArgs,
  dockerInspectArgs,
  dockerInspectNetworksArgs,
  dockerRmArgs,
  dockerStatsArgs,
  parseByteSize,
  parseContainerIp,
  parseDockerStats,
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

describe('docker stats (M16 utilization truth)', () => {
  const LINE = (over: Record<string, string>): string =>
    JSON.stringify({
      ID: 'abc123def456',
      Container: 'abc123def456',
      Name: 'devspace_env',
      CPUPerc: '12.50%',
      MemPerc: '3.20%',
      MemUsage: '512MiB / 15.61GiB',
      NetIO: '1.2kB / 0B',
      BlockIO: '0B / 0B',
      PIDs: '7',
      ...over,
    });

  it('builds the argv (sample everything, never named ids)', () => {
    expect(dockerStatsArgs()).toEqual(['stats', '--no-stream', '--format', '{{json .}}']);
  });

  it('parses usage rows into grant units (cores + MB)', () => {
    const rows = parseDockerStats(
      `${LINE({})}\n${LINE({ ID: 'ffff00001111', CPUPerc: '250.00%', MemUsage: '1.5GiB / 15.61GiB' })}\n`,
    );
    expect(rows).toEqual([
      { containerId: 'abc123def456', cpu: 0.125, memMB: 512 },
      { containerId: 'ffff00001111', cpu: 2.5, memMB: 1536 },
    ]);
  });

  it('falls back to Container when ID is missing', () => {
    const raw = JSON.stringify({
      Container: 'cafe00000000',
      CPUPerc: '0.00%',
      MemUsage: '1MiB / 1GiB',
    });
    expect(parseDockerStats(raw)).toEqual([{ containerId: 'cafe00000000', cpu: 0, memMB: 1 }]);
  });

  it('is total: junk lines, bad percentages, and unknown units are skipped', () => {
    const garbage = [
      'not json',
      'null',
      '{}',
      LINE({ CPUPerc: 'hot' }),
      LINE({ MemUsage: 'lots' }),
      LINE({ MemUsage: '3parsecs / 1GiB' }),
      JSON.stringify({ CPUPerc: '1.00%', MemUsage: '1MiB / 1GiB' }), // no id at all
      LINE({ ID: 'good00000000' }),
    ].join('\n');
    expect(parseDockerStats(garbage)).toEqual([
      { containerId: 'good00000000', cpu: 0.125, memMB: 512 },
    ]);
  });

  it('parseByteSize handles binary and decimal units (and rejects garbage)', () => {
    expect(parseByteSize('512MiB')).toBe(512);
    expect(parseByteSize('1.5GiB')).toBe(1536);
    expect(parseByteSize('1024KiB')).toBe(1);
    expect(parseByteSize('1MB')).toBeCloseTo(1000 ** 2 / 1024 ** 2, 6);
    expect(parseByteSize('42B')).toBeCloseTo(42 / 1024 ** 2, 9);
    expect(parseByteSize('fast')).toBeNull();
    expect(parseByteSize('12XB')).toBeNull();
    expect(parseByteSize('')).toBeNull();
  });

  it('DockerRuntime.stats runs the argv and parses (throwing on failure)', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async () => ({ code: 0, stdout: `${LINE({})}\n`, stderr: '' })),
      stream: vi.fn(),
    };
    const rt = new DockerRuntime(runner, { dockerPath: '/usr/bin/docker' });
    expect(await rt.stats()).toEqual([{ containerId: 'abc123def456', cpu: 0.125, memMB: 512 }]);
    expect(runner.run).toHaveBeenCalledWith('/usr/bin/docker', dockerStatsArgs(), undefined);

    const failing: CommandRunner = {
      run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'daemon down' })),
      stream: vi.fn(),
    };
    await expect(new DockerRuntime(failing).stats()).rejects.toThrow(/daemon down/);
  });
});
