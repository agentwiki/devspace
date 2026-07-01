/**
 * The load-bearing primitive: a full-duplex exec stream.
 *
 * ACP rides entirely inside this abstraction. The agent-runner launches an
 * agent process via exec, gets a {stdin, stdout} byte channel, and wraps it in
 * ACP's ndJsonStream. sandbox-core never interprets the bytes — it only
 * transports them. stdout and stderr are kept separate because ACP uses stdout
 * for protocol framing and stderr for logs.
 */
import type { ExecFrame } from '@devspace/contracts';

export interface ExecStream {
  /**
   * Write raw bytes to the process stdin. Returns `false` when the write buffer
   * is full — callers streaming large payloads should then `await drain()`
   * before writing more, so we never build an unbounded backlog in memory
   * (the stdin half of flow-control).
   */
  writeStdin(bytes: Uint8Array): boolean;
  /** Resolves once the stdin buffer has drained below its high-water mark. */
  drain(): Promise<void>;
  /** Signal EOF on stdin. */
  closeStdin(): void;
  /**
   * Frames flowing from the process (stdout/stderr/exit). Consuming this
   * iterable slowly applies real backpressure: the implementation pauses the
   * underlying readable streams, which fills the OS pipe buffer and blocks the
   * process's own writes — no unbounded buffering, no OOM on large diffs.
   */
  frames: AsyncIterable<ExecFrame>;
  /** Resolves with the process exit code. */
  done: Promise<number>;
  /**
   * Forcibly terminate the process. NOTE: over the docker-exec transport this
   * signals the local `docker exec` client only — it does NOT reach the process
   * tree inside the container (Docker doesn't propagate the signal). Use the
   * runtime's `destroy()` to actually reap in-container processes. See the M5
   * auto-abort caveat in docs/roadmap.md.
   */
  kill(signal?: NodeJS.Signals): void;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

export function encodeStdin(bytes: Uint8Array): ExecFrame {
  return { kind: 'stdin', data: toBase64(bytes) };
}

/** Convenience: drain an exec stream's stdout into a single Buffer (tests/util). */
export async function collectStdout(stream: ExecStream): Promise<Buffer> {
  return (await captureExec(stream)).stdout;
}

/** The result of running a command to completion and buffering its output. */
export interface ExecCapture {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Drain an exec stream to completion, buffering stdout and stderr separately
 * and returning the exit code. Used by the fs helpers, which run small
 * commands (`cat`, `find`) whose output comfortably fits in memory. Do NOT use
 * this for agent turns — those must be consumed frame-by-frame so backpressure
 * stays intact.
 */
export async function captureExec(stream: ExecStream): Promise<ExecCapture> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let code = -1;
  for await (const frame of stream.frames) {
    if (frame.kind === 'stdout') out.push(Buffer.from(fromBase64(frame.data)));
    else if (frame.kind === 'stderr') err.push(Buffer.from(fromBase64(frame.data)));
    else if (frame.kind === 'exit') code = frame.code;
  }
  return {
    code: await stream.done.catch(() => code),
    stdout: Buffer.concat(out),
    stderr: Buffer.concat(err),
  };
}

/**
 * In-memory exec stream for tests and local boot. Echoes scripted frames and
 * exposes the same surface the real (gRPC/WS over docker exec) stream will.
 */
export function createScriptedExecStream(scriptedFrames: ExecFrame[]): ExecStream {
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));

  async function* gen(): AsyncIterable<ExecFrame> {
    for (const f of scriptedFrames) {
      yield f;
      if (f.kind === 'exit') resolveDone(f.code);
    }
  }

  return {
    writeStdin() {
      /* no-op for the scripted stream */
      return true;
    },
    drain() {
      return Promise.resolve();
    },
    closeStdin() {
      /* no-op */
    },
    frames: gen(),
    done,
    kill() {
      resolveDone(-1);
    },
  };
}
