/**
 * Per-turn budget enforcement (M5): tool-call count + wall clock.
 *
 * `guardTurn` wraps a session's event stream. Within budget, events pass
 * through untouched. On a breach it stops forwarding, releases the underlying
 * iterator, invokes `onBreach` exactly once (the runner's REAL abort — parked
 * permissions cancelled, ACP `session/cancel`, in-container kill), and closes
 * the stream with an explanatory `message` + `turn_end { reason: 'aborted' }`
 * so consumers see a clean, renderable ending.
 *
 * Wall clock is enforced two ways: checked against the injected `clock` on
 * every event (deterministic in tests), AND raced against a real timer so an
 * agent that goes silent mid-turn still gets aborted — a hung turn is exactly
 * the runaway case budgets exist for.
 */
import type { AgentEvent } from '@devspace/contracts';
import type { GuardrailPolicy } from './guardrails.js';
import { DEFAULT_POLICY } from './guardrails.js';

export type BudgetBreach =
  { kind: 'tool_calls'; limit: number } | { kind: 'wall_clock'; limitMs: number };

export function describeBreach(breach: BudgetBreach): string {
  return breach.kind === 'tool_calls'
    ? `exceeded ${breach.limit} tool calls in one turn`
    : `exceeded the ${Math.round(breach.limitMs / 1000)}s turn budget`;
}

/** Events that represent one tool invocation against the per-turn budget. */
function countsAsToolCall(event: AgentEvent): boolean {
  return event.type === 'tool_call' || event.type === 'command_run' || event.type === 'file_edit';
}

export interface GuardTurnOptions {
  policy?: GuardrailPolicy;
  /** Millisecond clock (injected in tests). */
  clock?: () => number;
  /** Timer seams (injected in tests; real setTimeout/clearTimeout otherwise). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** The real abort. Invoked exactly once, before the aborted tail is emitted. */
  onBreach: (breach: BudgetBreach) => void | Promise<void>;
}

export async function* guardTurn(
  source: AsyncIterable<AgentEvent>,
  options: GuardTurnOptions,
): AsyncIterable<AgentEvent> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const clock = options.clock ?? Date.now;
  const setTimer = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  const start = clock();
  let toolCalls = 0;
  const iterator = source[Symbol.asyncIterator]();

  // The silent-agent path: a real timer resolves the race when no event ever
  // arrives. (`unref` where available so a pending turn never pins the process.)
  let fireTimeout!: () => void;
  const timedOut = new Promise<'timeout'>((resolve) => {
    fireTimeout = () => resolve('timeout');
  });
  const handle = setTimer(fireTimeout, policy.turnWallClockMs);
  (handle as { unref?: () => void } | null)?.unref?.();

  async function breachTail(breach: BudgetBreach): Promise<AgentEvent[]> {
    await iterator.return?.(undefined)?.catch?.(() => {});
    await options.onBreach(breach);
    return [
      { type: 'message', text: `⛔ Turn aborted: ${describeBreach(breach)}.` },
      { type: 'turn_end', reason: 'aborted' },
    ];
  }

  try {
    for (;;) {
      const raced = await Promise.race([iterator.next(), timedOut]);
      if (raced === 'timeout') {
        yield* await breachTail({ kind: 'wall_clock', limitMs: policy.turnWallClockMs });
        return;
      }
      if (raced.done) return;
      const event = raced.value;
      if (event.type === 'turn_end') {
        yield event;
        return;
      }
      if (clock() - start >= policy.turnWallClockMs) {
        yield* await breachTail({ kind: 'wall_clock', limitMs: policy.turnWallClockMs });
        return;
      }
      if (countsAsToolCall(event)) {
        toolCalls += 1;
        if (toolCalls > policy.maxToolCallsPerTurn) {
          yield* await breachTail({ kind: 'tool_calls', limit: policy.maxToolCallsPerTurn });
          return;
        }
      }
      yield event;
    }
  } finally {
    clearTimer(handle);
  }
}
