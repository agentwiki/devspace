import { describe, expect, it, vi } from 'vitest';
import { StatusRegistry, StreamCoalescer, type Clock } from './status.js';

/** Deterministic clock: time only moves via advance(), which fires due timers. */
class FakeClock implements Clock {
  private t = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.t = timer.at;
      timer.fn();
    }
    this.t = target;
  }
}

describe('StatusRegistry', () => {
  it('stores, returns, and clears the per-conversation status ts', () => {
    const reg = new StatusRegistry();
    expect(reg.get('c1')).toBeUndefined();
    reg.set('c1', '1.000100');
    expect(reg.get('c1')).toBe('1.000100');
    reg.clear('c1');
    expect(reg.get('c1')).toBeUndefined();
  });
});

describe('StreamCoalescer', () => {
  /** Drain the microtask queue (async flush settlement) without real time. */
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function setup(minIntervalMs = 1000) {
    const clock = new FakeClock();
    const flush = vi.fn(async (_streamId: string, _text: string) => {});
    const coalescer = new StreamCoalescer(flush, { minIntervalMs, clock });
    return { clock, flush, coalescer };
  }

  it('flushes the first chunk immediately (stream start is visible promptly)', () => {
    const { flush, coalescer } = setup();
    coalescer.append('s1', 'hello');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('s1', 'hello');
  });

  it('coalesces chunks inside the interval into ONE flush of the full concatenation', async () => {
    const { clock, flush, coalescer } = setup();
    coalescer.append('s1', 'a'); // immediate
    coalescer.append('s1', 'b'); // buffered
    coalescer.append('s1', 'c'); // buffered — no extra timer
    expect(flush).toHaveBeenCalledTimes(1);

    clock.advance(999);
    await tick();
    expect(flush).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await tick();
    expect(flush).toHaveBeenCalledTimes(2);
    // chat.update replaces the message → the flush carries the FULL text.
    expect(flush).toHaveBeenLastCalledWith('s1', 'abc');
  });

  it('respects the min interval across a sustained burst (≤1 flush per window)', async () => {
    const { clock, flush, coalescer } = setup();
    for (let i = 0; i < 10; i++) {
      coalescer.append('s1', `${i}`);
      clock.advance(300); // 3.3 appends per window
      await tick();
    }
    clock.advance(1000); // let the trailing debounce fire
    await tick();
    // 3s of appends + trailing edge ≈ 4 flushes, never 10.
    expect(flush.mock.calls.length).toBeLessThanOrEqual(4);
    expect(flush).toHaveBeenLastCalledWith('s1', '0123456789'); // nothing dropped
  });

  it('an append after a quiet period flushes immediately again', async () => {
    const { clock, flush, coalescer } = setup();
    coalescer.append('s1', 'a');
    clock.advance(2000);
    await tick(); // first delivery settles during the quiet period
    coalescer.append('s1', 'b');
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith('s1', 'ab');
  });

  it('streams are independent', () => {
    const { flush, coalescer } = setup();
    coalescer.append('s1', 'x');
    coalescer.append('s2', 'y');
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(1, 's1', 'x');
    expect(flush).toHaveBeenNthCalledWith(2, 's2', 'y');
  });

  it('end() cancels the debounce, flushes the remainder, and awaits delivery', async () => {
    const { flush, coalescer } = setup();
    coalescer.append('s1', 'a');
    coalescer.append('s1', 'b'); // pending behind the debounce
    await coalescer.end('s1');
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith('s1', 'ab');
  });

  it('endAll() drains every stream (adapter stop())', async () => {
    const { flush, coalescer } = setup();
    coalescer.append('s1', 'a');
    coalescer.append('s1', 'b');
    coalescer.append('s2', 'y');
    coalescer.append('s2', 'z');
    await coalescer.endAll();
    expect(flush).toHaveBeenCalledWith('s1', 'ab');
    expect(flush).toHaveBeenCalledWith('s2', 'yz');
  });

  it('flushes are serialized per stream — a slow transport never reorders edits', async () => {
    const clock = new FakeClock();
    const done: string[] = [];
    let releaseFirst!: () => void;
    const flush = vi.fn((_id: string, text: string) => {
      if (done.length === 0 && text === 'a') {
        return new Promise<void>((r) => {
          releaseFirst = () => {
            done.push(text);
            r();
          };
        });
      }
      done.push(text);
      return Promise.resolve();
    });
    const coalescer = new StreamCoalescer(flush, { minIntervalMs: 1000, clock });

    coalescer.append('s1', 'a'); // in-flight, held open
    coalescer.append('s1', 'b');
    clock.advance(1000); // second flush queued behind the first
    releaseFirst();
    await coalescer.end('s1');
    expect(done).toEqual(['a', 'ab']);
  });

  it('a flush error is routed to onError and never thrown from append', async () => {
    const clock = new FakeClock();
    const onError = vi.fn();
    const coalescer = new StreamCoalescer(async () => Promise.reject(new Error('rate limited')), {
      clock,
      onError,
    });
    expect(() => coalescer.append('s1', 'a')).not.toThrow();
    await coalescer.end('s1');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('s1', expect.any(Error));
  });
});
