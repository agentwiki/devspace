/**
 * Lease-elected singleton task (M15) over the in-memory lease repo: two
 * candidates share one repo, ticks are driven by hand through the injected
 * scheduler, and time is the repo's injected clock — no real timers.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryRepositories, type LeaseRepo } from '@devspace/db';
import { startElectedTask } from './election.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A hand-ticked candidate: `tick()` fires one interval and settles it. */
function candidate(opts: {
  leases: LeaseRepo;
  id: string;
  logs: string[];
  runs: string[];
  run?: () => Promise<void>;
}): { tick: () => Promise<void>; stop: () => void } {
  let tickFn: (() => void) | undefined;
  const stop = startElectedTask({
    leases: opts.leases,
    name: 'pr-reconciler',
    instanceId: opts.id,
    intervalMs: 10_000, // TTL defaults to 2× = 20s
    run:
      opts.run ??
      (async () => {
        opts.runs.push(opts.id);
      }),
    onLog: (line) => opts.logs.push(`${opts.id}: ${line}`),
    setInterval: (fn) => {
      tickFn = fn;
      return {};
    },
    clearInterval: () => {
      tickFn = undefined;
    },
  });
  return {
    async tick() {
      tickFn?.();
      await flush();
    },
    stop,
  };
}

describe('startElectedTask (M15)', () => {
  it('elects exactly one candidate; the holder renews across ticks', async () => {
    let clock = 0;
    const repos = createInMemoryRepositories(() => new Date(clock).toISOString());
    const logs: string[] = [];
    const runs: string[] = [];
    const a = candidate({ leases: repos.leases, id: 'ctrl-a', logs, runs });
    const b = candidate({ leases: repos.leases, id: 'ctrl-b', logs, runs });

    await a.tick();
    await b.tick();
    expect(runs).toEqual(['ctrl-a']);
    expect(logs).toContain('ctrl-a: elected pr-reconciler');
    expect(logs).not.toContain('ctrl-b: elected pr-reconciler');

    // Renewal keeps the sibling out even as its clock ticks past the interval.
    clock = 10_000;
    await a.tick();
    clock = 19_000; // ctrl-a's lease renewed at 10s; 19s is inside the 20s TTL
    await b.tick();
    expect(runs).toEqual(['ctrl-a', 'ctrl-a']);
    // The loser skips silently — one candidacy log line, no per-tick noise.
    expect(logs.filter((l) => l.startsWith('ctrl-b'))).toEqual([]);
  });

  it('a clean stop releases the lease: failover on the next sibling tick', async () => {
    const repos = createInMemoryRepositories();
    const logs: string[] = [];
    const runs: string[] = [];
    const a = candidate({ leases: repos.leases, id: 'ctrl-a', logs, runs });
    const b = candidate({ leases: repos.leases, id: 'ctrl-b', logs, runs });

    await a.tick();
    a.stop();
    await flush(); // let the fire-and-forget release land
    expect(await repos.leases.get('pr-reconciler')).toBeNull();

    await b.tick(); // no TTL wait — the role moved immediately
    expect(runs).toEqual(['ctrl-a', 'ctrl-b']);
  });

  it('a crashed holder is replaced only after the TTL', async () => {
    let clock = 0;
    const repos = createInMemoryRepositories(() => new Date(clock).toISOString());
    const logs: string[] = [];
    const runs: string[] = [];
    const b = candidate({ leases: repos.leases, id: 'ctrl-b', logs, runs });

    await b.tick();
    expect(runs).toEqual(['ctrl-b']);

    // b "crashes": no more ticks, no release. A fresh candidate stays locked
    // out inside the TTL and takes over past it.
    const c = candidate({ leases: repos.leases, id: 'ctrl-c', logs, runs });
    clock = 19_000;
    await c.tick();
    expect(runs).toEqual(['ctrl-b']);
    clock = 21_000;
    await c.tick();
    expect(runs).toEqual(['ctrl-b', 'ctrl-c']);
    expect(logs).toContain('ctrl-c: elected pr-reconciler');
  });

  it('run failures log and never break the election loop', async () => {
    const repos = createInMemoryRepositories();
    const logs: string[] = [];
    const runs: string[] = [];
    let fail = true;
    const a = candidate({
      leases: repos.leases,
      id: 'ctrl-a',
      logs,
      runs,
      run: async () => {
        if (fail) throw new Error('github 500');
        runs.push('ctrl-a');
      },
    });

    await a.tick();
    expect(logs).toContain('ctrl-a: pr-reconciler: github 500');
    fail = false;
    await a.tick(); // still the holder; the job recovers
    expect(runs).toEqual(['ctrl-a']);
  });

  it('an acquire failure logs, keeps the candidacy, and never claims election', async () => {
    const repos = createInMemoryRepositories();
    const logs: string[] = [];
    const runs: string[] = [];
    let down = true;
    const flaky: LeaseRepo = {
      acquire: (name, owner, ttl) => {
        if (down) throw new Error('db unreachable');
        return repos.leases.acquire(name, owner, ttl);
      },
      release: (name, owner) => repos.leases.release(name, owner),
      get: (name) => repos.leases.get(name),
    };
    const a = candidate({ leases: flaky, id: 'ctrl-a', logs, runs });

    await a.tick();
    expect(runs).toEqual([]);
    expect(logs).toContain('ctrl-a: lease pr-reconciler: acquire failed: db unreachable');
    down = false;
    await a.tick();
    expect(runs).toEqual(['ctrl-a']);
  });

  it('stop is idempotent and a non-holder stop never releases the lease', async () => {
    const repos = createInMemoryRepositories();
    const logs: string[] = [];
    const runs: string[] = [];
    const a = candidate({ leases: repos.leases, id: 'ctrl-a', logs, runs });
    const b = candidate({ leases: repos.leases, id: 'ctrl-b', logs, runs });

    await a.tick();
    // ctrl-b never held the role; stopping it must not free ctrl-a's lease.
    b.stop();
    b.stop();
    await flush();
    expect((await repos.leases.get('pr-reconciler'))?.holder).toBe('ctrl-a');
  });
});
