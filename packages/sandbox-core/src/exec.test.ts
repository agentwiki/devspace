import { describe, expect, it } from 'vitest';
import {
  collectStdout,
  createScriptedExecStream,
  encodeStdin,
  fromBase64,
  toBase64,
} from './exec.js';

describe('exec stream primitive', () => {
  it('round-trips bytes through base64 frames', () => {
    const bytes = new TextEncoder().encode('hello');
    const frame = encodeStdin(bytes);
    expect(frame.kind).toBe('stdin');
    expect(Buffer.from(fromBase64(frame.data)).toString()).toBe('hello');
    expect(toBase64(bytes)).toBe('aGVsbG8=');
  });

  it('collects stdout and resolves the exit code', async () => {
    const stream = createScriptedExecStream([
      { kind: 'stdout', data: toBase64(new TextEncoder().encode('ok\n')) },
      { kind: 'exit', code: 0 },
    ]);
    const out = await collectStdout(stream);
    expect(out.toString()).toBe('ok\n');
    expect(await stream.done).toBe(0);
  });
});
