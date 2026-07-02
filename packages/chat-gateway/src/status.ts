/**
 * Per-conversation render state (m4-plan Decision 4, workstream A).
 *
 * - `StatusRegistry`: the `ts` of each conversation's single status message,
 *   so `update_status` edits one message in place (`chat.update`) instead of
 *   posting a new line per FSM milestone.
 * - `StreamCoalescer`: buffers `stream_append` chunks and flushes the FULL
 *   accumulated text on a debounce (Slack's `chat.update` replaces the whole
 *   message), keeping ≲1 update/sec/message to respect rate limits. Bursty
 *   turns degrade to fewer, larger edits — never dropped content.
 *
 * Both take an injected clock so tests are deterministic (no real timers).
 */

/** conversationId → the ts of its lazily-created status message. */
export class StatusRegistry {
  private readonly tsByConversation = new Map<string, string>();

  get(conversationId: string): string | undefined {
    return this.tsByConversation.get(conversationId);
  }

  set(conversationId: string, ts: string): void {
    this.tsByConversation.set(conversationId, ts);
  }

  clear(conversationId: string): void {
    this.tsByConversation.delete(conversationId);
  }
}

/** Injectable time source; the default is the real clock + global timers. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export interface StreamCoalescerOptions {
  /** Minimum ms between flushes of the same stream (default 1000 ≈ Slack's chat.update budget). */
  minIntervalMs?: number;
  clock?: Clock;
  /** Flush failures never throw out of `append`; they land here (default: swallow). */
  onError?: (streamId: string, err: unknown) => void;
}

interface StreamState {
  /** Full accumulated text — every flush sends the whole message body. */
  text: string;
  dirty: boolean;
  lastFlushAt: number;
  timer?: unknown;
  /** Flushes currently in flight (0 → the next flush starts synchronously). */
  active: number;
  /** Serializes flushes per stream so a slow transport never reorders edits. */
  chain: Promise<void>;
}

export class StreamCoalescer {
  private readonly streams = new Map<string, StreamState>();
  private readonly minIntervalMs: number;
  private readonly clock: Clock;
  private readonly onError?: (streamId: string, err: unknown) => void;

  constructor(
    /** Ship the accumulated text (e.g. `chat.update` of the stream's message). */
    private readonly flush: (streamId: string, text: string) => Promise<void>,
    opts: StreamCoalescerOptions = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.clock = opts.clock ?? realClock;
    this.onError = opts.onError;
  }

  /** Buffer a chunk; flush now if the interval has elapsed, else debounce. */
  append(streamId: string, chunk: string): void {
    const state = this.stateFor(streamId);
    state.text += chunk;
    state.dirty = true;
    this.maybeFlush(streamId, state);
  }

  /** Flush anything pending for the stream and forget it. */
  async end(streamId: string): Promise<void> {
    const state = this.streams.get(streamId);
    if (!state) return;
    if (state.timer !== undefined) {
      this.clock.clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.dirty) this.doFlush(streamId, state);
    await state.chain;
    this.streams.delete(streamId);
  }

  /** Flush every stream (adapter `stop()` — nothing buffered may be lost). */
  async endAll(): Promise<void> {
    await Promise.all([...this.streams.keys()].map((id) => this.end(id)));
  }

  private stateFor(streamId: string): StreamState {
    let state = this.streams.get(streamId);
    if (!state) {
      state = {
        text: '',
        dirty: false,
        lastFlushAt: -Infinity,
        active: 0,
        chain: Promise.resolve(),
      };
      this.streams.set(streamId, state);
    }
    return state;
  }

  private maybeFlush(streamId: string, state: StreamState): void {
    if (state.timer !== undefined) return; // a flush is already scheduled
    const wait = state.lastFlushAt + this.minIntervalMs - this.clock.now();
    if (wait <= 0) {
      this.doFlush(streamId, state);
      return;
    }
    state.timer = this.clock.setTimeout(() => {
      state.timer = undefined;
      if (state.dirty) this.doFlush(streamId, state);
    }, wait);
  }

  private doFlush(streamId: string, state: StreamState): void {
    state.dirty = false;
    state.lastFlushAt = this.clock.now();
    const snapshot = state.text;
    const run = (): Promise<void> =>
      this.flush(streamId, snapshot)
        .catch((err) => this.onError?.(streamId, err))
        .finally(() => {
          state.active -= 1;
        });
    // Start synchronously when idle (an interval-elapsed edit ships at once);
    // queue behind the in-flight flush otherwise (never reorder edits).
    state.active += 1;
    state.chain = state.active === 1 ? run() : state.chain.then(run);
  }
}
