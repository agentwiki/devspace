import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './async-queue.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('AsyncQueue', () => {
  it('delivers buffered values then ends on close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    expect(await collect(q)).toEqual([1, 2]);
  });

  it('hands a value straight to a parked consumer', async () => {
    const q = new AsyncQueue<string>();
    const iterator = q[Symbol.asyncIterator]();
    const pending = iterator.next(); // parks before any push
    q.push('a');
    expect(await pending).toEqual({ value: 'a', done: false });
    q.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('ignores pushes after close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close();
    q.push(2);
    expect(await collect(q)).toEqual([1]);
  });

  it('surfaces a failure to a parked consumer', async () => {
    const q = new AsyncQueue<number>();
    const pending = q[Symbol.asyncIterator]().next();
    q.fail(new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
  });
});
