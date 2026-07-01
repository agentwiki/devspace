/**
 * A single-consumer async channel used to hand normalized AgentEvents from the
 * ACP client's push-style callbacks to a pull-style `for await` loop that drives
 * a turn. It is intentionally tiny: one producer (`push`/`fail`/`close`), one
 * consumer (the async iterator). Backpressure on the AGENT side is already
 * enforced by sandbox-core's exec stream (kernel pipe watermarks), so this queue
 * only needs to bridge callback -> iterator, not re-implement flow-control.
 *
 * Invariant: the internal buffer is only non-empty when no consumer is parked —
 * a `push` hands straight to a waiting puller when one exists.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly pullers: Array<(r: IteratorResult<T>) => void> = [];
  private rejecters: Array<(err: unknown) => void> = [];
  private ended = false;
  private error: unknown = null;

  push(value: T): void {
    if (this.ended) return;
    const puller = this.pullers.shift();
    if (puller) {
      this.rejecters.shift();
      puller({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  /** Terminate the stream normally; the consumer sees iteration end. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const puller of this.pullers.splice(0)) puller({ value: undefined, done: true });
    this.rejecters = [];
  }

  /** Terminate the stream with an error surfaced to the consumer. */
  fail(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = err;
    for (const reject of this.rejecters.splice(0)) reject(err);
    this.pullers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.pullers.push(resolve);
          this.rejecters.push(reject);
        });
      },
    };
  }
}
