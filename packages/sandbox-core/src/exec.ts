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
  /** Write raw bytes to the process stdin. */
  writeStdin(bytes: Uint8Array): void;
  /** Signal EOF on stdin. */
  closeStdin(): void;
  /** Frames flowing from the process (stdout/stderr/exit). */
  frames: AsyncIterable<ExecFrame>;
  /** Resolves with the process exit code. */
  done: Promise<number>;
  /** Forcibly terminate the process. */
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
  const chunks: Buffer[] = [];
  for await (const frame of stream.frames) {
    if (frame.kind === 'stdout') chunks.push(Buffer.from(fromBase64(frame.data)));
  }
  return Buffer.concat(chunks);
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
