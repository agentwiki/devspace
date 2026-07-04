# M15 — Expansion X: singleton reconciler election (implementation plan)

Design of record for M15. M14 made N controllers over one Postgres and one
sandbox fleet a supported shape, and its closeout left exactly two pieces of
multi-controller friction standing: every controller still runs the PR poll
reconciler (N× duplicate GitHub reads, growing with fleet size and shrinking
rate limits), and a clean shutdown of one controller still destroys the warm
stock it happens to track — which since M14 is FLEET stock, so a rolling
deploy torches the shared pool once per restarted instance. M15 closes both:
a lease — the same shape as the M14 event claim, generalized into a named
advisory-lease primitive — elects one poller, and warm pools learn to hand
their stock back to the fleet instead of destroying it on clean shutdown.
Zero contract changes; the surface is one additive `leases` migration, one
repo interface, and one sandbox-core config knob.

> Prereqs already landed: the claim-lease pattern and its TTL/at-least-once
> discipline (M14), idempotent reconciler topics consumed exactly once at
> the singleton bus consumer (M5/M14), host-side pool marks as the durable
> warm-stock ledger (M10/M11) and sibling-safe adoption of marked envs
> (M14) — which is precisely what makes "leave the stock alive" safe now
> when it wasn't in M9.

## What M15 fixes

1. **N reconcilers poll GitHub.** Correct since M14 (publishes are
   idempotent and consumed once) but wasteful: every controller polls every
   PR_OPEN unit on every tick, resolving tenant tokens N times and spending
   N× the GitHub rate limit. m14-plan explicitly seeded "electing a single
   poller" as the follow-up.
2. **A rolling deploy destroys the fleet's warm pool.** `stop()` destroys
   still-unclaimed warm envs (the m9-plan clean-shutdown decision — right
   when stock was orchestrator-private). Since M14 the local list can hold
   sibling-filled stock, and restarting controllers one by one destroys
   warm envs the SURVIVORS were about to claim. m14-plan documented this as
   accepted waste; with pool marks durable on the host (M10/M11) and every
   controller sweeping for marked stock (M14), handing the envs back is now
   strictly better — for multi-controller deployments.

## Scope

In (per roadmap M15+, the "singleton reconciler election" seed):

- **Advisory leases in the database.** A `leases` table (name → holder,
  acquired_at, renewed_at) and `LeaseRepo.acquire(name, owner, ttlMs)` —
  one atomic INSERT … ON CONFLICT that grants the named lease iff it is
  free, expired, or already ours (re-acquire = renew). `release(name,
  owner)` gives it up early; `get(name)` reads it for diagnostics. All
  arbitration happens in database time, like the M14 event claim — no
  cross-host clock arithmetic.
- **The elected reconciler.** The poll tick becomes: acquire the
  `pr-reconciler` lease; holders poll, everyone else skips silently. The
  holder renews by re-acquiring each tick; a crashed holder's lease
  expires after the TTL (default 2× the poll interval) and any sibling's
  next tick takes over; a cleanly-stopped controller releases on the way
  out so the role fails over immediately, not after a TTL. The election
  identity is the controller's instance id — shared with the M14 bus
  claim (`DEVSPACE_INSTANCE_ID`, else one per-boot random id for both).
- **Warm-stock handover on clean shutdown.** `SANDBOX_WARM_KEEP_ON_STOP=1`
  makes `stop()` leave still-unclaimed warm envs alive instead of
  destroying them: they stay pool-marked on the host, so siblings adopt
  them on their next miss/top-up sweep (M14) and a single-controller
  restart re-adopts them at the next boot's `fill()` (M10). Default
  unchanged (destroy) — keeping stock alive is only unambiguously right
  when someone is left (or coming back) to claim it, and that is the
  operator's call, not something the wrapper can sense.

Out (seeded to M16+, with rationale):

- **NATS bus.** Unchanged: LISTEN/NOTIFY + the M14 claim survives N
  controllers by construction; `EventBus` remains the seam.
- **Generalizing the election beyond the reconciler.** Nothing else wants
  it: warm-pool top-up converges on the global ledger by design (M14),
  the bus sweep is arbitrated per row by the claim, and chat events land
  on one controller via the load balancer. The lease primitive is there
  when a genuinely singleton periodic task appears.
- **Turn-level failover, live-utilization/disk-weighted placement,
  certificate rotation tooling, Forum dashboard.** Unchanged from the M14
  closeout.

## Decisions

1. **A named lease, not a claimed row.** The event claim (M14) arbitrates
   many short-lived rows; the reconciler needs one long-lived ROLE. Same
   TTL discipline, different lifecycle: `acquire` is an upsert on the role
   name, re-acquire by the holder renews (`renewed_at = now()`,
   `acquired_at` preserved so diagnostics show tenure), and a lease
   younger than the TTL held by someone else refuses. One atomic
   statement decides every case — no read-then-write window.
2. **The lease is advisory, and the system stays correct without it.**
   Election only deduplicates work that was already safe to duplicate:
   if two controllers ever both believe they hold the lease (clock skew
   cannot cause this — grants evaluate in database time — but a paused
   process resuming past its TTL can), the result is one redundant poll
   whose publishes no-op at the singleton consumer. Correctness never
   depends on the election; only efficiency does. That is why `release`
   on shutdown can be fire-and-forget.
3. **TTL = 2× the poll interval.** The holder renews every tick, so one
   missed tick (GC pause, transient DB error) does not lose the role, and
   a crashed holder is replaced within two intervals — bounded staleness
   that scales with how often the role actually matters. No separate
   knob: the interval is already the operator's cadence dial
   (`RECONCILE_INTERVAL_MS`), and a second number to mis-tune buys
   nothing.
4. **Failover is event-driven only at shutdown.** A clean stop releases
   the lease (idempotent, holder-guarded) so rolling deploys hand the
   role over immediately. Crash failover stays TTL-bounded — detecting a
   dead peer faster than its lease expiry is exactly the distributed
   problem the lease exists to avoid.
5. **One instance identity per controller.** `DEVSPACE_INSTANCE_ID` (else
   a per-boot random id) now names the controller once in `boot.ts` and
   feeds BOTH the bus claim and the reconciler lease, so an incident
   reads one name across `claimed_by` and `leases.holder`. Still
   diagnostics, never authorization (m14-plan Decision 3).
6. **Keep-on-stop is a knob, not a default, and not autodetected.** The
   wrapper cannot know whether siblings exist (it deliberately has no
   fleet view beyond `listEnvironments`), whether this shutdown is a
   rolling restart or a teardown, or whether the deployment is
   single-controller demo mode — and defaulting to "leak N containers on
   Ctrl-C" in the zero-config path is the wrong failure mode. Operators
   running multiple controllers (or one that restarts in place, M10) set
   `SANDBOX_WARM_KEEP_ON_STOP=1`; everyone else keeps the M9 behavior.
   The stop-races-provision path honors the same choice: a fill that
   completes after stop() is left alive (marked, adoptable) instead of
   destroyed.
7. **Zero contract changes, zero new dependencies.** The migration adds
   one table nothing else references; `Repositories` gains `leases`; the
   reconciler election lives entirely in the orchestrator boot layer; the
   warm-pool knob is svc-boot config like every SANDBOX_* before it.

## Workstreams

### A. db: the advisory lease primitive

- `schema.ts`: `leases` table — `name` (pk), `holder`, `acquired_at`,
  `renewed_at`; migration `0003` (generated, additive only).
- `LeaseRepo` on `Repositories`: `acquire(name, owner, ttlMs)` → boolean,
  `release(name, owner)` (holder-guarded delete, idempotent), `get(name)`.
  Pg: one `INSERT … ON CONFLICT (name) DO UPDATE … WHERE holder = excluded
  OR renewed_at < now() - ttl RETURNING`, granted iff a row returns;
  re-acquire preserves `acquired_at`. In-memory mirrors the semantics.
- Tests: unit (in-memory) — free/expired/own grants, live foreign lease
  refuses, renew preserves tenure, release is holder-guarded and
  idempotent; pg.itest — concurrent acquires yield exactly one winner,
  renewal under contention, expiry reclaim, release → immediate takeover.

### B. orchestrator + sandbox-core: the elected reconciler + handover

- `election.ts` (new, orchestrator): `startElectedTask({ leases, name,
  instanceId, intervalMs, ttlMs?, run, onLog })` → stop fn. Per tick:
  acquire (renew) → run when held, skip when not; logs only on
  gained/lost transitions; run failures log and never kill the loop; stop
  clears the timer and releases when holding. Injectable timers.
- `boot.ts`: one per-boot instance id feeds the bus and
  `startReconciler`, which now wraps the poll in `startElectedTask`
  (lease `pr-reconciler`, TTL 2× interval).
- `warm-pool.ts`: `WarmPoolOptions.keepStockOnStop`; `stop()` drops local
  tracking but leaves envs alive when set (log the handover), and the
  stop-races-provision path keeps the marked env instead of destroying
  it. `warmKeepOnStopFromEnv` parses `SANDBOX_WARM_KEEP_ON_STOP` (1/true;
  anything else refuses loudly).
- `boot.ts` + compose.yaml + README knobs: the new env var rides the same
  path as `SANDBOX_WARM_POOLS`.
- Tests: election over shared in-memory leases — two tasks, one runs;
  crash (stop renewing without release) fails over after the TTL; clean
  stop fails over on the next tick; run errors don't break election.
  Warm pool: keep-on-stop leaves envs alive and a sibling wrapper adopts
  and claims them warm; default stop still destroys; the raced-provision
  path honors the knob both ways.

### C. Docs closeout

- roadmap: M15 landed; M16+ seeded (leftovers unchanged).
- architecture.md: one paragraph (elected reconciler, warm-stock
  handover).
- README status paragraph; .env.example knob.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** lease semantics on the
  in-memory repo; election with injected timers over in-memory leases;
  two-wrapper handover over a fake inner core.
- **Pg itest (CI job with a live Postgres):** lease atomicity under
  concurrent acquires on real connections; expiry/renew/release timing in
  database time.
- **Live-Docker itest:** unchanged. Nothing here touches the container
  path.

## Risks / notes

- **A paused holder can double-poll once.** Accepted (Decision 2): the
  poll was N-plicated before M15; a transient 2× during a stall is
  strictly better, and the publishes no-op at the singleton consumer.
- **Failover latency is TTL-bounded (2× interval).** With webhooks
  configured the poll is a 5-minute drift backstop — a worst-case
  ~10-minute gap in the BACKSTOP is invisible; without webhooks the
  interval is 30s and the gap is a minute. Clean shutdowns don't wait at
  all (Decision 4).
- **Keep-on-stop can strand containers** when an operator sets it on a
  deployment that is actually going away for good. That is what the
  default protects; the knob's docs say "rolling deploys", and marked
  envs are visible (`GET /environments`, pool-marked) rather than
  invisible leaks.
- **The lease table is one more thing `runMigrations` owns.** Additive
  only; pre-M15 rows don't exist to migrate.
