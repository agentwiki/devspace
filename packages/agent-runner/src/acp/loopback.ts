/**
 * In-memory ACP loopback.
 *
 * Pairs a client-facing {@link ExecStream} with an agent-facing ACP {@link Stream}
 * so a real `AgentSideConnection` (the SDK's agent half) can be wired to our
 * `connectAgent` client half with NO Docker and NO child process — the same role
 * `createScriptedExecStream` plays for sandbox-core. This is what lets the full
 * ACP handshake + a real prompt turn be exercised end-to-end in a unit test, and
 * it doubles as a local-boot harness for the orchestrator before a live sandbox
 * exists.
 *
 * Byte routing:
 *   runner.writeStdin ──▶ agent input  (agent reads its stdin)
 *   agent output      ──▶ runner stdout frames (the protocol channel)
 */
import { ndJsonStream } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';
import type { ExecFrame } from '@devspace/contracts';
import type { ExecStream } from '@devspace/sandbox-core';
import { toBase64 } from '@devspace/sandbox-core';
import { AsyncQueue } from './async-queue.js';

export interface AcpLoopback {
  /** Client-facing exec stream — hand this to `connectAgent` / the runner. */
  execStream: ExecStream;
  /** Agent-facing ACP byte stream — hand this to `new AgentSideConnection(..)`. */
  agentStream: Stream;
}

export function createAcpLoopback(): AcpLoopback {
  // client stdin -> agent input
  let agentInput!: ReadableStreamDefaultController<Uint8Array>;
  const agentInputReadable = new ReadableStream<Uint8Array>({
    start(controller) {
      agentInput = controller;
    },
  });
  const closeInput = () => {
    try {
      agentInput.close();
    } catch {
      /* already closed */
    }
  };

  // agent output -> client stdout frames
  const frames = new AsyncQueue<ExecFrame>();
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));
  const exit = (code: number) => {
    frames.push({ kind: 'exit', code });
    frames.close();
    resolveDone(code);
  };

  const agentOutput = new WritableStream<Uint8Array>({
    write(chunk) {
      frames.push({ kind: 'stdout', data: toBase64(chunk) });
    },
    close() {
      exit(0);
    },
  });

  const execStream: ExecStream = {
    writeStdin(bytes) {
      agentInput.enqueue(bytes);
      return true;
    },
    drain() {
      return Promise.resolve();
    },
    closeStdin() {
      closeInput();
    },
    frames,
    done,
    kill() {
      closeInput();
      exit(-1);
    },
  };

  return { execStream, agentStream: ndJsonStream(agentOutput, agentInputReadable) };
}
