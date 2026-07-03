/**
 * The real full-duplex exec stream, backed by a child process.
 *
 * This is the load-bearing primitive of the whole platform (ADR-0002): ACP
 * rides inside it, and it MUST have true flow-control in both directions or it
 * deadlocks / OOMs on a long agent turn or a large diff. The two halves:
 *
 *  - stdout/stderr (process -> consumer): frames land in a bounded queue. When
 *    the consumer falls behind and the queue crosses a high-water mark we
 *    `.pause()` the readables; Node stops reading from the pipes, the OS pipe
 *    buffer fills, and the child's own `write(2)` calls block. Draining below a
 *    low-water mark `.resume()`s them. Backpressure is thus enforced by the
 *    kernel, not by us buffering everything.
 *
 *  - stdin (consumer -> process): `writeStdin` returns `false` when Node's
 *    socket buffer is full; callers `await drain()` before continuing. We never
 *    accumulate an unbounded write backlog.
 *
 * `spawnExecStream` is deliberately transport-agnostic: it just spawns a
 * command. The Docker runtime points it at `docker exec -i`; the unit tests
 * point it at `/bin/sh` and friends, so the flow-control logic is exercised for
 * real without a Docker daemon in the loop.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import type { ExecFrame } from '@devspace/contracts';
import type { ExecStream } from './exec.js';
import { toBase64 } from './exec.js';

export interface SpawnExecOptions extends SpawnOptionsWithoutStdio {
  /** Buffered-frame count at which we pause the child's stdout/stderr. */
  highWaterMark?: number;
  /** Buffered-frame count at which we resume them again. */
  lowWaterMark?: number;
}

const DEFAULT_HIGH_WATER = 256;
const DEFAULT_LOW_WATER = 64;

/**
 * A single-consumer async channel of frames with pause/resume hooks fired on
 * high/low-water crossings. Invariant: the internal queue is only non-empty
 * when no puller is parked (a push hands straight to a waiting puller), so the
 * two arrays are never both non-empty.
 *
 * Exported since M8: the remote exec client (`remote-client.ts`) puts the same
 * watermark channel at the TCP rim — pause/resume the socket instead of the
 * child's pipes — so backpressure semantics are identical on both transports.
 */
export class FrameChannel<T = ExecFrame> {
  private readonly queue: T[] = [];
  private readonly pullers: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;
  private paused = false;

  constructor(
    private readonly high: number,
    private readonly low: number,
    private readonly onPause: () => void,
    private readonly onResume: () => void,
  ) {}

  push(frame: T): void {
    if (this.ended) return;
    const puller = this.pullers.shift();
    if (puller) {
      puller({ value: frame, done: false });
      return;
    }
    this.queue.push(frame);
    if (!this.paused && this.queue.length >= this.high) {
      this.paused = true;
      this.onPause();
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    // Parked pullers only exist when the queue is empty, so it is safe to
    // resolve them all as done here.
    while (this.pullers.length) this.pullers.shift()!({ value: undefined as never, done: true });
  }

  pull(): Promise<IteratorResult<T>> {
    const frame = this.queue.shift();
    if (frame !== undefined) {
      if (this.paused && this.queue.length <= this.low) {
        this.paused = false;
        this.onResume();
      }
      return Promise.resolve({ value: frame, done: false });
    }
    if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.pullers.push(resolve));
  }
}

export function spawnExecStream(
  command: string,
  args: readonly string[],
  options: SpawnExecOptions = {},
): ExecStream {
  const {
    highWaterMark = DEFAULT_HIGH_WATER,
    lowWaterMark = DEFAULT_LOW_WATER,
    ...spawnOptions
  } = options;

  const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
    ...spawnOptions,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const channel = new FrameChannel(
    highWaterMark,
    lowWaterMark,
    () => {
      child.stdout.pause();
      child.stderr.pause();
    },
    () => {
      child.stdout.resume();
      child.stderr.resume();
    },
  );

  child.stdout.on('data', (chunk: Buffer) =>
    channel.push({ kind: 'stdout', data: toBase64(chunk) }),
  );
  child.stderr.on('data', (chunk: Buffer) =>
    channel.push({ kind: 'stderr', data: toBase64(chunk) }),
  );

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));

  const finish = (code: number): void => {
    channel.push({ kind: 'exit', code });
    channel.end();
    resolveDone(code);
  };

  // 'close' fires after stdio streams have flushed and closed, so every
  // stdout/stderr 'data' event has already been pushed — the exit frame is
  // therefore always last, preserving ordering.
  let closed = false;
  child.on('close', (code, signal) => {
    if (closed) return;
    closed = true;
    finish(code ?? (signal ? 128 + signalNumber(signal) : -1));
  });

  child.on('error', (err) => {
    if (closed) return;
    closed = true;
    channel.push({ kind: 'stderr', data: toBase64(Buffer.from(`spawn error: ${err.message}\n`)) });
    finish(-1);
  });

  // spawn is async: a kill() issued before the OS process exists would be
  // dropped (child.kill() is a no-op with no pid), leaving a SIGKILL'd `sleep`
  // to run to completion. Track spawn state and defer any early signal until
  // the process actually exists, so kill() is race-free right after spawn.
  let spawned = false;
  let pendingSignal: NodeJS.Signals | null = null;
  child.on('spawn', () => {
    spawned = true;
    if (pendingSignal && !closed) {
      child.kill(pendingSignal);
      pendingSignal = null;
    }
  });

  // A broken pipe (process exits mid-write) must not crash the host process.
  child.stdin.on('error', () => {});

  return {
    writeStdin(bytes: Uint8Array): boolean {
      if (!child.stdin.writable) return false;
      return child.stdin.write(Buffer.from(bytes));
    },
    drain(): Promise<void> {
      if (!child.stdin.writableNeedDrain) return Promise.resolve();
      // Also settle on close/error: a child that exits with its stdin buffer
      // full never emits 'drain', and a parked writer must not hang forever
      // (the stdin 'error' no-op above swallows the EPIPE that would tell us).
      return new Promise((resolve) => {
        const settle = (): void => {
          child.stdin.off('drain', settle);
          child.stdin.off('close', settle);
          child.stdin.off('error', settle);
          resolve();
        };
        child.stdin.once('drain', settle);
        child.stdin.once('close', settle);
        child.stdin.once('error', settle);
      });
    },
    closeStdin(): void {
      if (child.stdin.writable) child.stdin.end();
    },
    frames: {
      [Symbol.asyncIterator](): AsyncIterator<ExecFrame> {
        return { next: () => channel.pull() };
      },
    },
    done,
    // WARNING: this signals ONLY the direct local child. For the docker-exec
    // transport (runtime.ts) that child is the `docker exec` client — Docker does
    // NOT propagate the signal into the container, so the in-container process
    // tree (e.g. codex-acp and anything it spawned) keeps running. Do NOT build
    // M5 auto-abort / turn-budget kill on top of this alone; hard-stopping an
    // agent needs in-container termination (`docker exec <ctr> kill`) or
    // `destroy()` (`docker rm --force`, which reaps the whole container).
    kill(signal: NodeJS.Signals = 'SIGTERM'): void {
      if (closed) return;
      if (spawned) child.kill(signal);
      else pendingSignal = signal; // deliver once the process actually exists
    },
  };
}

/** Best-effort POSIX signal-name -> number, for the 128+n exit convention. */
function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal] ?? 0;
}
