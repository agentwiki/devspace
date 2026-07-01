import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from './cli.js';
import { createScriptedExecStream } from './exec.js';
import { DockerRuntime, dockerExecArgs, dockerInspectArgs, dockerRmArgs } from './runtime.js';

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
