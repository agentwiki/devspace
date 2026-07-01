/**
 * Adapt sandbox-core's full-duplex ExecStream to the byte-stream pair ACP's
 * `ndJsonStream` consumes.
 *
 * The agent process runs INSIDE the sandbox; we reach its stdio only through the
 * exec stream's frames. ACP wants Web streams of raw bytes:
 *   - `readable`  <- agent stdout frames (the protocol channel)
 *   - `writable`  -> agent stdin (`writeStdin`, honoring `drain()` backpressure)
 * stderr frames are NOT protocol data — they are the agent's logs, so they are
 * diverted to `onLog` and never reach the JSON-RPC parser.
 *
 * Backpressure is preserved end-to-end: the WritableStream awaits `drain()` when
 * the stdin buffer is full, and the ReadableStream only pulls the next frame when
 * ACP pulls from it, so a slow parser pauses the underlying pipes (see
 * process-stream.ts) instead of buffering an entire turn in memory.
 */
import type { ExecStream } from '@devspace/sandbox-core';
import { fromBase64 } from '@devspace/sandbox-core';

export interface AcpByteStreams {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
}

export function execStreamToAcp(
  exec: ExecStream,
  onLog: (line: string) => void = () => {},
): AcpByteStreams {
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of exec.frames) {
          if (frame.kind === 'stdout') controller.enqueue(fromBase64(frame.data));
          else if (frame.kind === 'stderr')
            onLog(Buffer.from(fromBase64(frame.data)).toString('utf8'));
          else if (frame.kind === 'exit') break;
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (!exec.writeStdin(chunk)) await exec.drain();
    },
    close() {
      exec.closeStdin();
    },
    abort() {
      exec.closeStdin();
    },
  });

  return { writable, readable };
}
