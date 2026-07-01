import { describe, expect, it } from 'vitest';
import { captureExec, fromBase64, toBase64 } from './exec.js';
import { spawnExecStream } from './process-stream.js';

// These run real child processes (sh/cat/etc). No Docker daemon needed — the
// flow-control logic is transport-agnostic, so /bin/sh exercises the exact same
// code path that `docker exec -i` will.

describe('spawnExecStream', () => {
  it('captures stdout and the exit code', async () => {
    const stream = spawnExecStream('sh', ['-c', 'printf hello']);
    const { code, stdout } = await captureExec(stream);
    expect(stdout.toString()).toBe('hello');
    expect(code).toBe(0);
    expect(await stream.done).toBe(0);
  });

  it('keeps stdout and stderr as separate frames', async () => {
    const stream = spawnExecStream('sh', ['-c', 'printf out; printf err 1>&2']);
    const { stdout, stderr } = await captureExec(stream);
    expect(stdout.toString()).toBe('out');
    expect(stderr.toString()).toBe('err');
  });

  it('propagates a non-zero exit code', async () => {
    const stream = spawnExecStream('sh', ['-c', 'exit 3']);
    expect((await captureExec(stream)).code).toBe(3);
  });

  // Signal-based tests spawn real processes and wait for OS-delivered signals;
  // on a box running every package's suite in parallel, spawn+signal+close
  // latency can spike past the default 5s timeout (the exit codes themselves
  // are deterministic — verified separately). Give them ample headroom.
  const SIGNAL_TIMEOUT = 30_000;

  it(
    'reports 128+n when the process is killed by a signal',
    async () => {
      const stream = spawnExecStream('sh', ['-c', 'kill -TERM $$']);
      // 128 + SIGTERM(15) = 143
      expect(await stream.done).toBe(143);
    },
    SIGNAL_TIMEOUT,
  );

  it('round-trips arbitrary bytes over stdin (full-duplex)', async () => {
    const stream = spawnExecStream('cat', []);
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x42, 0xfe]);
    stream.writeStdin(payload);
    stream.closeStdin();
    const { stdout } = await captureExec(stream);
    expect(Buffer.compare(stdout, payload)).toBe(0);
  });

  it('surfaces a spawn failure as stderr + exit -1 instead of throwing', async () => {
    const stream = spawnExecStream('this-binary-does-not-exist-xyz', []);
    const { code, stderr } = await captureExec(stream);
    expect(code).toBe(-1);
    expect(stderr.toString()).toContain('spawn error');
  });

  it(
    'kill() terminates a long-running process',
    async () => {
      const stream = spawnExecStream('sh', ['-c', 'sleep 30']);
      stream.kill('SIGKILL');
      // 128 + SIGKILL(9) = 137
      expect(await stream.done).toBe(137);
    },
    SIGNAL_TIMEOUT,
  );

  it('applies real backpressure: a paused consumer blocks the producer', async () => {
    // The producer emits ~2MB (2000 lines * 1001 bytes) — well past the ~64KB
    // OS pipe buffer, so it CANNOT run to completion while its stdout is paused.
    // We pull a few frames, then go idle: the channel crosses its high-water
    // mark, pauses stdout, the pipe buffer fills, and the producer's write(2)
    // blocks. A naive unbounded pipe would have buffered all 2MB in our process
    // and exited already. We assert `done` is still pending during the idle
    // window, then drain everything and verify the full byte count.
    const LINES = 2000;
    const LINE_BYTES = 1001; // 1000 'X' + newline
    const stream = spawnExecStream(
      'sh',
      [
        '-c',
        `s=$(head -c 1000 < /dev/zero | tr '\\0' X); i=0; while [ $i -lt ${LINES} ]; do echo "$s"; i=$((i+1)); done`,
      ],
      { highWaterMark: 8, lowWaterMark: 2 },
    );

    const iterator = stream.frames[Symbol.asyncIterator]();
    let total = 0;
    let sawExit = false;
    for (let i = 0; i < 5; i++) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.kind === 'stdout') total += fromBase64(value.data).length;
      if (value.kind === 'exit') sawExit = true;
    }

    // Idle window: ample time for an unbounded producer to have finished.
    await new Promise((r) => setTimeout(r, 150));

    // If the process had run to completion, `done` would already be resolved.
    // It must still be pending because stdout is paused.
    const pending = Symbol('pending');
    const raced = await Promise.race([stream.done, Promise.resolve(pending)]);
    expect(sawExit).toBe(false);
    expect(raced).toBe(pending);

    // Drain the rest — resuming flow — and confirm we received every byte.
    let final = -1;
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.kind === 'stdout') total += fromBase64(value.data).length;
      else if (value.kind === 'exit') final = value.code;
    }
    expect(total).toBe(LINES * LINE_BYTES);
    expect(final).toBe(0);
    expect(await stream.done).toBe(0);
  });

  it('drain() resolves after a large stdin write is flushed', async () => {
    const stream = spawnExecStream('cat', []);
    // Write ~1MB to push past the socket high-water mark and force a false.
    const big = Buffer.alloc(1024 * 1024, 0x61);
    const ok = stream.writeStdin(big);
    if (!ok) await stream.drain();
    stream.closeStdin();
    const { stdout, code } = await captureExec(stream);
    expect(stdout.length).toBe(big.length);
    expect(code).toBe(0);
  });

  it('encodes bytes as base64 in frames', () => {
    expect(toBase64(Buffer.from('hi'))).toBe('aGk=');
  });
});
