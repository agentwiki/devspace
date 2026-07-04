/**
 * Lease-elected singleton task (M15, m15-plan workstream B): run a periodic
 * job on exactly one controller in steady state. Every instance ticks on the
 * same interval; each tick tries to acquire (= renew, for the holder) the
 * named advisory lease and runs the job only while holding it. A crashed
 * holder's lease expires after the TTL and any sibling's next tick takes the
 * role over; a clean stop releases it so the role fails over immediately.
 *
 * The election is advisory (m15-plan Decision 2): the job must already be
 * safe to run twice — here, the PR poll reconciler, whose publishes ride
 * idempotent topics into the singleton bus consumer (M5/M14). Losing the
 * dedup for one window costs a redundant poll, never a wrong transition.
 */
import type { LeaseRepo } from '@devspace/db';

export interface ElectedTaskOptions {
  leases: LeaseRepo;
  /** The role's lease name, e.g. `pr-reconciler`. */
  name: string;
  /** This controller's identity — shared with the bus claim (Decision 5). */
  instanceId: string;
  intervalMs: number;
  /**
   * Lease TTL; defaults to 2× the interval (m15-plan Decision 3): one missed
   * renewal doesn't lose the role, a crashed holder is replaced within two
   * ticks.
   */
  ttlMs?: number;
  /** The job. Failures are logged and never break the election loop. */
  run: () => Promise<void>;
  onLog?: (line: string) => void;
  /** Injected scheduler, so tests can drive ticks deterministically. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

/**
 * Start the election loop; returns the stop fn. Ticks never overlap: the job
 * is awaited inside its tick, so a slow run skips renewals instead of piling
 * up on itself — the TTL's one-interval slack absorbs a single skipped
 * renewal, and a run slower than the TTL can lose the role mid-run, which is
 * the advisory contract (one redundant poll, never a wrong transition).
 */
export function startElectedTask(opts: ElectedTaskOptions): () => void {
  const ttlMs = opts.ttlMs ?? opts.intervalMs * 2;
  const onLog = opts.onLog ?? (() => {});
  const schedule = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const unschedule =
    opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let holding = false;
  let stopped = false;
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      let held: boolean;
      try {
        held = await opts.leases.acquire(opts.name, opts.instanceId, ttlMs);
      } catch (err) {
        // A transient DB error must not silently end the candidacy — log and
        // keep ticking; the TTL keeps a genuinely dead holder replaceable.
        onLog(`lease ${opts.name}: acquire failed: ${message(err)}`);
        return;
      }
      if (held !== holding) {
        holding = held;
        onLog(held ? `elected ${opts.name}` : `lost ${opts.name}`);
      }
      if (!held || stopped) return;
      await opts.run().catch((err) => onLog(`${opts.name}: ${message(err)}`));
    } finally {
      ticking = false;
    }
  }

  const timer = schedule(() => void tick(), opts.intervalMs);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    unschedule(timer);
    if (holding) {
      holding = false;
      // Fire-and-forget (Decision 4): the TTL already covers a lost release.
      void opts.leases
        .release(opts.name, opts.instanceId)
        .catch((err: unknown) => onLog(`lease ${opts.name}: release failed: ${message(err)}`));
    }
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
