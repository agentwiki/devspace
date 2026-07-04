/**
 * Event bus over the durable `events` table.
 *
 * The `events` table has a SINGLE writer: `EventRepo.append`. `publish` appends
 * the row (the durable record) and only then signals subscribers, so a crash
 * between append and signal still leaves a recoverable row. Delivery is
 * at-least-once — a dropped Postgres NOTIFY (fire-and-forget, not buffered) is
 * recovered by a periodic scan of `consumed_at IS NULL`. Handlers must be
 * idempotent.
 *
 * Since M14 processing is CLAIMED: every instance still hears every NOTIFY,
 * but one atomic lease per row (`EventRepo.claim`) decides which controller
 * runs the handlers — N orchestrators no longer each execute every effect.
 * A claimer that crashes mid-handler is covered by the lease TTL: the
 * recovery sweep re-claims and re-runs, so delivery stays at-least-once.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { BusEvent } from '@devspace/contracts';
import type { EventRecord, EventRepo } from './index.js';

/** The one channel every orchestrator instance LISTENs on. Payload = row id. */
export const EVENT_CHANNEL = 'devspace_events';

export type EventHandler = (evt: EventRecord) => void | Promise<void>;

export interface EventBus {
  /** Append the durable row, then signal subscribers. Returns the stored row. */
  publish(evt: Omit<BusEvent, 'id' | 'emittedAt'>): Promise<BusEvent>;
  /** Register a handler; returns an unsubscribe fn. */
  subscribe(handler: EventHandler): () => void;
  /** Begin delivery (Pg: LISTEN + recovery scan). Idempotent. */
  start(): Promise<void>;
  /** Stop delivery and release resources. Idempotent. */
  stop(): Promise<void>;
}

function toBusEvent(rec: EventRecord): BusEvent {
  return {
    id: rec.id,
    topic: rec.topic,
    workUnitId: rec.workUnitId,
    payload: rec.payload,
    emittedAt: rec.emittedAt,
  };
}

/**
 * Synchronous in-process bus for unit tests and single-node local boot. Still
 * goes through `EventRepo` so the durable row exists and the single-writer
 * invariant holds identically to the Pg path.
 */
export function createInMemoryEventBus(repo: EventRepo): EventBus {
  const handlers = new Set<EventHandler>();
  return {
    async publish(evt) {
      const rec = await repo.append(evt);
      await fanOut(handlers, rec);
      await repo.markConsumed(rec.id);
      return toBusEvent(rec);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async start() {
      /* nothing to start — delivery is synchronous inside publish */
    },
    async stop() {
      handlers.clear();
    },
  };
}

export interface PgEventBusOptions {
  /** How often to sweep for unconsumed rows (missed-NOTIFY recovery). */
  recoveryIntervalMs?: number;
  /**
   * This controller's claim identity (M14) — diagnostics, not authorization
   * (m14-plan Decision 3). Defaults to a per-boot random id; deployments
   * that want readable incident logs set DEVSPACE_INSTANCE_ID and pass it.
   */
  instanceId?: string;
  /**
   * Claim lease TTL (M14): a row claimed longer ago than this is presumed
   * orphaned by a crashed controller and is re-claimable. Handlers slower
   * than the TTL can be double-run — the at-least-once contract, unchanged.
   */
  claimTtlMs?: number;
  /** Injected scheduler, so tests can drive recovery deterministically. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

export const DEFAULT_CLAIM_TTL_MS = 5 * 60_000;

/**
 * Postgres LISTEN/NOTIFY bus. A dedicated client holds the LISTEN; the pool is
 * used for row loads and `markConsumed`. On every notify (and on a periodic
 * recovery sweep) it loads the row, runs handlers, then stamps `consumed_at`.
 */
export function createPgEventBus(
  pool: Pool,
  repo: EventRepo,
  opts: PgEventBusOptions = {},
): EventBus {
  const handlers = new Set<EventHandler>();
  const recoveryIntervalMs = opts.recoveryIntervalMs ?? 30_000;
  const instanceId = opts.instanceId ?? `bus_${randomUUID()}`;
  const claimTtlMs = opts.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const schedule = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const unschedule =
    opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let listenClient: PoolClient | undefined;
  let timer: { unref?: () => void } | undefined;
  let started = false;
  // Serialize processing so a NOTIFY and a recovery sweep can't double-run a row
  // concurrently; markConsumed still makes a genuine double-delivery a no-op.
  let chain: Promise<void> = Promise.resolve();

  const inFlight = new Set<string>();

  async function process(id: string): Promise<void> {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      // The claim is the cross-instance arbiter (M14): losing it means a
      // sibling controller (or a live lease) owns the row — skip silently.
      const rec = await repo.claim(id, instanceId, claimTtlMs);
      if (!rec) return;
      await fanOut(handlers, rec);
      await repo.markConsumed(rec.id);
    } finally {
      inFlight.delete(id);
    }
  }

  function enqueue(id: string): void {
    chain = chain.then(() => process(id)).catch(() => undefined);
  }

  function onNotification(msg: { channel: string; payload?: string }): void {
    if (msg.channel === EVENT_CHANNEL && msg.payload) enqueue(msg.payload);
  }

  async function sweep(): Promise<void> {
    const rows = await repo.listUnconsumed();
    for (const r of rows) enqueue(r.id);
  }

  return {
    async publish(evt) {
      const rec = await repo.append(evt);
      // pg_notify from the pool; delivery happens on the LISTEN client. If no
      // one is listening yet, the recovery sweep still picks the row up.
      await pool.query('SELECT pg_notify($1, $2)', [EVENT_CHANNEL, rec.id]);
      return toBusEvent(rec);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async start() {
      if (started) return;
      started = true;
      listenClient = await pool.connect();
      listenClient.on('notification', onNotification);
      await listenClient.query(`LISTEN ${EVENT_CHANNEL}`);
      // Recover anything appended while we were down / any dropped NOTIFY.
      await sweep();
      timer = schedule(() => void sweep(), recoveryIntervalMs);
      timer.unref?.();
    },
    async stop() {
      if (!started) return;
      started = false;
      if (timer) unschedule(timer);
      timer = undefined;
      if (listenClient) {
        try {
          await listenClient.query(`UNLISTEN ${EVENT_CHANNEL}`);
        } catch {
          /* connection may already be gone */
        }
        // Detach BEFORE releasing: the client returns to the shared pool, and
        // a listener that rode along would keep enqueueing (and, since M14,
        // claiming + consuming with zero handlers) if a later bus's LISTEN
        // lands on this same pooled connection.
        listenClient.off('notification', onNotification);
        listenClient.release();
        listenClient = undefined;
      }
      await chain;
      handlers.clear();
    },
  };
}

async function fanOut(handlers: Iterable<EventHandler>, rec: EventRecord): Promise<void> {
  for (const h of handlers) await h(rec);
}
