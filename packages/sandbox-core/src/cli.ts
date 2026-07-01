/**
 * The one place sandbox-core touches the outside world: spawning `docker`,
 * `devcontainer`, and `git`. Everything goes through the `CommandRunner`
 * seam so the higher layers (runtime, provisioner, sandbox) can be unit-tested
 * against a fake without a Docker daemon or these binaries installed.
 */
import { spawn } from 'node:child_process';
import type { ExecStream } from './exec.js';
import type { SpawnExecOptions } from './process-stream.js';
import { spawnExecStream } from './process-stream.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the process stdin, then EOF. */
  input?: string;
  /** Kill the command after this many ms (0 / undefined = no timeout). */
  timeoutMs?: number;
}

/** Seam for running external CLIs. Real impl below; tests inject a fake. */
export interface CommandRunner {
  /** Run a command to completion, buffering output. For one-shot commands. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Spawn a command as a full-duplex stream. For exec / streaming. */
  stream(command: string, args: readonly string[], options?: SpawnExecOptions): ExecStream;
}

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly result: RunResult,
  ) {
    super(
      `\`${command} ${args.join(' ')}\` exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
    this.name = 'CommandFailedError';
  }
}

/** The production runner: real child processes. */
export const nodeCommandRunner: CommandRunner = {
  run(command, args, options = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const timer =
        options.timeoutMs && options.timeoutMs > 0
          ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
          : undefined;

      const done = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', (e) =>
        done({ code: -1, stdout: Buffer.concat(out).toString(), stderr: `${e.message}` }),
      );
      child.on('close', (code, signal) =>
        done({
          code: code ?? (signal ? 137 : -1),
          stdout: Buffer.concat(out).toString(),
          stderr: Buffer.concat(err).toString(),
        }),
      );
      child.stdin.on('error', () => {});
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  },

  stream(command, args, options): ExecStream {
    return spawnExecStream(command, args, options);
  },
};

/** Run a command and throw `CommandFailedError` on a non-zero exit. */
export async function runOrThrow(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<RunResult> {
  const result = await runner.run(command, args, options);
  if (result.code !== 0) throw new CommandFailedError(command, args, result);
  return result;
}
