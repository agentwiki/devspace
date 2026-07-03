import type { AgentEvent } from '@devspace/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { BudgetBreach } from './budget.js';
import { describeBreach, guardTurn } from './budget.js';
import { DEFAULT_POLICY } from './guardrails.js';
import type { GuardrailPolicy } from './guardrails.js';

const message = (i: number): AgentEvent => ({ type: 'message', text: `m${i}` });
const toolCall = (i: number): AgentEvent => ({ type: 'tool_call', name: `t${i}`, args: {} });
const turnEnd: AgentEvent = { type: 'turn_end', reason: 'completed' };

function policyWith(overrides: Partial<GuardrailPolicy>): GuardrailPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

/** Deterministic timer seam that never fires unless told to. */
function manualTimer(): {
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (h: unknown) => void;
  fire: () => void;
  cleared: () => boolean;
} {
  let stored: (() => void) | undefined;
  let cleared = false;
  return {
    setTimeoutFn: (fn) => {
      stored = fn;
      return 'handle';
    },
    clearTimeoutFn: () => {
      cleared = true;
    },
    fire: () => stored?.(),
    cleared: () => cleared,
  };
}

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

async function* streamOf(events: AgentEvent[], onReturn?: () => void): AsyncIterable<AgentEvent> {
  try {
    for (const ev of events) yield ev;
    // Keep the stream open like a real turn (it ends only via turn_end or return()).
    await new Promise(() => {});
  } finally {
    onReturn?.();
  }
}

describe('guardTurn', () => {
  it('passes a within-budget turn through untouched', async () => {
    const timer = manualTimer();
    const onBreach = vi.fn();
    const events = await drain(
      guardTurn(streamOf([message(1), toolCall(1), message(2), turnEnd]), {
        policy: policyWith({ maxToolCallsPerTurn: 5 }),
        clock: () => 0,
        ...timer,
        onBreach,
      }),
    );
    expect(events).toEqual([message(1), toolCall(1), message(2), turnEnd]);
    expect(onBreach).not.toHaveBeenCalled();
    expect(timer.cleared()).toBe(true);
  });

  it('aborts on the tool-call budget: one onBreach, released source, aborted tail', async () => {
    const timer = manualTimer();
    const onBreach = vi.fn();
    let sourceReleased = false;
    const source = streamOf(
      [toolCall(1), toolCall(2), toolCall(3), toolCall(4), toolCall(5)],
      () => (sourceReleased = true),
    );

    const events = await drain(
      guardTurn(source, {
        policy: policyWith({ maxToolCallsPerTurn: 3 }),
        clock: () => 0,
        ...timer,
        onBreach,
      }),
    );

    expect(events.slice(0, 3)).toEqual([toolCall(1), toolCall(2), toolCall(3)]);
    expect(events.at(-2)).toMatchObject({ type: 'message', text: expect.stringContaining('3') });
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'aborted' });
    expect(onBreach).toHaveBeenCalledTimes(1);
    expect(onBreach.mock.calls[0]![0]).toEqual({ kind: 'tool_calls', limit: 3 });
    expect(sourceReleased).toBe(true);
  });

  it('counts command_run and file_edit as tool calls', async () => {
    const timer = manualTimer();
    const onBreach = vi.fn();
    const events = await drain(
      guardTurn(
        streamOf([
          { type: 'command_run', cmd: 'ls' },
          { type: 'file_edit', path: '/w/a', diff: 'd' },
          { type: 'command_run', cmd: 'pwd' },
        ]),
        { policy: policyWith({ maxToolCallsPerTurn: 2 }), clock: () => 0, ...timer, onBreach },
      ),
    );
    expect(onBreach).toHaveBeenCalledWith({ kind: 'tool_calls', limit: 2 });
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'aborted' });
  });

  it('aborts on wall clock measured at event arrival (fake clock)', async () => {
    const timer = manualTimer();
    const onBreach = vi.fn();
    let now = 0;
    const events = await drain(
      guardTurn(streamOf([message(1), message(2), message(3)]), {
        policy: policyWith({ turnWallClockMs: 10_000 }),
        clock: () => {
          const t = now;
          now += 6_000; // each observation advances 6s: 0, 6s, 12s…
          return t;
        },
        ...timer,
        onBreach,
      }),
    );
    expect(events[0]).toEqual(message(1));
    expect(onBreach).toHaveBeenCalledWith({ kind: 'wall_clock', limitMs: 10_000 });
    expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'aborted' });
  });

  it('aborts a SILENT hung agent via the real timer race', async () => {
    const timer = manualTimer();
    const breaches: BudgetBreach[] = [];
    const never: AsyncIterable<AgentEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    };

    const iter = guardTurn(never, {
      policy: policyWith({ turnWallClockMs: 10_000 }),
      clock: () => 0,
      ...timer,
      onBreach: (b) => void breaches.push(b),
    })[Symbol.asyncIterator]();

    const pending = iter.next();
    timer.fire(); // the wall-clock timer goes off with no event in sight
    const first = await pending;
    expect(first.value).toMatchObject({ type: 'message' });
    expect((await iter.next()).value).toEqual({ type: 'turn_end', reason: 'aborted' });
    expect((await iter.next()).done).toBe(true);
    expect(breaches).toEqual([{ kind: 'wall_clock', limitMs: 10_000 }]);
  });

  it('describes breaches for humans', () => {
    expect(describeBreach({ kind: 'tool_calls', limit: 100 })).toMatch(/100 tool calls/);
    expect(describeBreach({ kind: 'wall_clock', limitMs: 600_000 })).toMatch(/600s/);
  });
});
