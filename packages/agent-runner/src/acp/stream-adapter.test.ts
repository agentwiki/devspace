import { createScriptedExecStream, toBase64 } from '@devspace/sandbox-core';
import { describe, expect, it } from 'vitest';
import { execStreamToAcp } from './stream-adapter.js';

const enc = (s: string) => toBase64(new TextEncoder().encode(s));

async function readAll(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('execStreamToAcp', () => {
  it('surfaces stdout frames as readable bytes and stops at exit', async () => {
    const exec = createScriptedExecStream([
      { kind: 'stdout', data: enc('{"jsonrpc":"2.0"}\n') },
      { kind: 'stdout', data: enc('{"id":1}\n') },
      { kind: 'exit', code: 0 },
    ]);
    const { readable } = execStreamToAcp(exec);
    expect(await readAll(readable)).toBe('{"jsonrpc":"2.0"}\n{"id":1}\n');
  });

  it('routes stderr to onLog, never into the protocol channel', async () => {
    const logs: string[] = [];
    const exec = createScriptedExecStream([
      { kind: 'stderr', data: enc('warning: slow\n') },
      { kind: 'stdout', data: enc('ok') },
      { kind: 'exit', code: 0 },
    ]);
    const { readable } = execStreamToAcp(exec, (l) => logs.push(l));
    expect(await readAll(readable)).toBe('ok');
    expect(logs).toEqual(['warning: slow\n']);
  });

  it('writes to the exec stream stdin', async () => {
    const written: string[] = [];
    let closed = false;
    const exec = {
      writeStdin(bytes: Uint8Array) {
        written.push(Buffer.from(bytes).toString('utf8'));
        return true;
      },
      drain: () => Promise.resolve(),
      closeStdin() {
        closed = true;
      },
      frames: (async function* () {})(),
      done: Promise.resolve(0),
      kill() {},
    };
    const { writable } = execStreamToAcp(exec);
    const writer = writable.getWriter();
    await writer.write(new TextEncoder().encode('hello'));
    await writer.close();
    expect(written).toEqual(['hello']);
    expect(closed).toBe(true);
  });
});
