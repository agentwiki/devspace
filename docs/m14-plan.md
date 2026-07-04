# M14 — Expansion IX: multi-controller coordination (implementation plan)

Design of record for M14. The control-plane half of the seed M13 deliberately
split (m13-plan Scope): with per-service identity on every internal hop, the
remaining reason a deployment runs exactly ONE orchestrator is that two of
them would trip over each other — every controller processes every bus event,
and two warm-pool wrappers over the same fleet fight over (and can destroy)
each other's stock. M14 removes both hazards, so N orchestrators over one
Postgres and one sandbox fleet is a supported shape. Zero contract changes;
the surface is one `events`-table migration, two host-config knobs, and
warm-pool semantics that treat the host as the ledger it already is.

> Prereqs already landed: the durable `events` table with `consumed_at` and
> the at-least-once/idempotent-handlers discipline (M3), host-side pool marks
> and the atomic mark-clearing claim (M10), the durable host env table (M11),
> resource echoes on `Environment` (M12), and mTLS service identity (M13).
> What was NOT designed for siblings: bus delivery (every instance LISTENs
> and processes every row) and the warm-pool wrapper (in-memory `ready` lists
> assume they are the only tracker of the host's marked stock).

## What actually breaks with two controllers today

1. **Every bus event runs N times.** Both instances LISTEN on
   `devspace_events`; both race `listUnconsumed` past each other before
   either stamps `consumed_at`. The handlers are idempotent (that discipline
   holds and stays), so state converges — but every teardown revokes the
   push token N times, destroys the env N times, and appends N audit rows.
   Idempotence was designed for occasional webhook↔poll double-delivery,
   not for systematic N-times execution of every privileged effect.
2. **Warm pools can destroy a tenant's env.** Both controllers re-adopt the
   same marked envs into their own `ready` lists. Both may hand the same
   env out; the loser's `claimEnvironment` refuses with CONFLICT (the mark
   is the capability, M10) — and the wrapper's claim path treats every
   claim failure as "broken env" and DESTROYS it. The winner's tenant loses
   a live workspace. This is the one genuine safety bug; the rest is waste.
3. **Warm pools double-fill and flap.** Each wrapper tops up to `size`
   against its own memory, so two controllers hold 2× stock; each boot-time
   sweep then sees "excess beyond size" and destroys envs the sibling is
   tracking. Stock oscillates instead of converging.
4. **Placement budgets are per-controller beliefs.** Each controller's
   reservations (M8/M12) see only its own in-flight creates. The env-count
   overshoot has a host-side backstop (`SANDBOX_MAX_ENVS`, M9); the M12
   cpu/mem budgets have none — N controllers can jointly oversubscribe a
   host's resources while each one's arithmetic says it fits.

## Scope

In (per roadmap M14+, the "multi-controller coordination" seed):

- **Singleton event consumption.** A bus row is CLAIMED before it is
  processed: an atomic `claimed_by`/`claimed_at` stamp (one `UPDATE … WHERE
consumed_at IS NULL AND (claimed_at IS NULL OR claimed_at < now() - ttl)`)
  decides which instance runs the handlers. Losers skip. A claimer that
  crashes mid-handler is covered by the lease TTL: the recovery sweep
  re-claims and re-runs — delivery stays at-least-once, handlers stay
  idempotent, but the steady state is exactly-one-controller per event.
- **Sibling-safe warm pools.** The host's env table becomes the pool's only
  ledger (it already was the durable one, M10/M11): a lost claim race
  (CONFLICT/NOT_FOUND) drops the env and moves on — never destroys; a
  local miss re-sweeps the host for sibling-filled stock before going
  cold; and top-up counts the GLOBAL marked stock, not local memory, so N
  controllers converge on `size` warm envs instead of N×size.
- **Host-side resource budget backstop.** `SANDBOX_CPU_BUDGET` /
  `SANDBOX_MEM_BUDGET` (MB) on a sandbox host refuse admission when the sum
  of live env grants plus the request's grant exceeds the budget — the M12
  counterpart of `SANDBOX_MAX_ENVS`, enforced where the truth lives, so no
  number of mis-counting controllers can jointly oversubscribe a host.

Out (seeded to M15+, with rationale):

- **NATS bus.** Still unnecessary at this scale-out step: LISTEN/NOTIFY
  survives N orchestrators by construction (every instance hears every
  NOTIFY; the claim decides who acts). `EventBus` remains the seam.
- **Gateway/webhook/reconciler multiplexing.** Chat events arrive at ONE
  controller (whatever the operator's load balancer picks) and the FSM's
  `SELECT … FOR UPDATE` transitions were multi-writer-safe since M3; the
  poll reconciler and webhook ingress publish onto idempotent topics, so N
  of them running is already correct (double-publishes no-op at the
  consumer, which is now also singleton). No work needed — documented, not
  built.
- **Turn-level failover.** A controller that dies mid-turn loses that turn;
  the conversation resumes on whichever instance receives the next message
  (sticky env routing re-learns by probing, M8). Turn checkpointing is a
  product decision, not a coordination primitive.
- **Live-utilization / disk-weighted placement, Forum dashboard,
  certificate rotation tooling.** Unchanged from the M13 closeout.

## Decisions

1. **Claim, then process — with a lease, not a lock.** Mark-before-process
   alone would flip the bus to at-most-once (a crashed claimer strands the
   row); `SELECT … FOR UPDATE` across handler execution would hold a
   transaction (and a pool connection) open for the duration of a teardown.
   A `claimed_by`/`claimed_at` stamp with a TTL does neither: the atomic
   UPDATE is the race arbiter, the recovery sweep (which already exists for
   dropped NOTIFYs) re-claims leases older than the TTL, and `consumed_at`
   still terminates redelivery. A handler slower than the TTL can be
   double-run — which is exactly the at-least-once contract handlers have
   honored since M3. Default TTL 5 minutes (≫ any handler; ≪ operator
   patience for a stuck event after a crash).
2. **The claim is a repo operation, in both implementations.**
   `EventRepo.claim(id, owner, ttlMs)` returns the row or null, atomically:
   Pg does it in one UPDATE … RETURNING evaluated entirely in database time
   (no cross-host clock arithmetic); the in-memory repo mirrors the
   semantics for unit tests. The Pg bus routes ALL processing — NOTIFY and
   sweep alike — through the claim; the in-memory bus (single process by
   definition, used by unit tests and the demo) keeps its synchronous
   publish→handle path.
3. **`claimed_by` is diagnostics, not authorization.** The instance id
   (`DEVSPACE_INSTANCE_ID`, defaulting to a per-boot random id) answers
   "who is/was handling this row" during an incident; nothing checks it —
   the TTL, not the name, decides reclaimability. mTLS (M13) is the
   authorization story; this is bookkeeping.
4. **A lost warm claim is a race outcome, not a broken env.** The wrapper's
   claim path distinguishes by `SandboxError.code` (which survives the M8
   wire): CONFLICT (sibling claimed it first — it may be a TENANT env now)
   and NOT_FOUND (sibling destroyed/trimmed it) drop the id and try the
   next; EXEC_FAILED (refresh genuinely failed on an env we still own) and
   secret-application failures keep destroying, as since M9. The
   pre-claim verify also drops an already-unmarked env without touching it.
5. **The host's table is the pool ledger; memory is a hint.** Top-up
   gates on the GLOBAL count of marked ready envs (adopting untracked ones
   as it counts, so sibling-filled stock becomes claimable everywhere), and
   a local miss re-sweeps the host once before falling through cold. Two
   controllers can still both read `size-1` and both provision — the
   overshoot is bounded by the controller count, transient (refills gate on
   the global count; the boot sweep still trims), and strictly preferable
   to a coordination service. Listing failures fall back to local counts:
   an unreachable fleet must degrade to M13 behavior, never block fills.
6. **Budgets are enforced where they are physical.** The host refuses
   admission past `SANDBOX_CPU_BUDGET`/`SANDBOX_MEM_BUDGET` by summing the
   grants it echoes on its own live envs (M12 resource truth — which
   survives restart via the M11 table) plus the request's grant. Scheduling
   stays on grants, controller-side ranking is untouched, and the refusal
   is a distinguishable PROVISION_FAILED so the placement layer's existing
   failure path applies. Like `SANDBOX_MAX_ENVS` (M9), this is svc-boot
   config on the host — not a contract field a tenant could bargain with.
7. **Zero contract changes, zero new dependencies.** The migration adds two
   nullable columns to a table with one writer; `poolKey`, `Environment`,
   and every HTTP surface are untouched. No coordination service, no
   leader election: every shared decision rides an atomic operation on a
   thing that already exists (a Postgres row, a host-side pool mark).

## Workstreams

### A. db + orchestrator: singleton event consumption

- `schema.ts`: `claimed_by text`, `claimed_at timestamptz` on `events`;
  migration `0002` (generated, additive only).
- `EventRepo.claim(id, owner, ttlMs)` (Decision 2): Pg = single
  `UPDATE events SET claimed_by=$2, claimed_at=now() WHERE id=$1 AND
consumed_at IS NULL AND (claimed_at IS NULL OR claimed_at < now() -
ttl) RETURNING *`; in-memory mirrors it. `EventRecord` gains the two
  optional fields.
- `createPgEventBus(pool, repo, { instanceId?, claimTtlMs? })`: `process`
  becomes claim → fanOut → markConsumed (skip silently on a lost claim);
  the recovery sweep enumerates unconsumed rows as today and lets the
  claim arbitrate — a stale lease is re-claimable by construction.
- `boot.ts`: passes `DEVSPACE_INSTANCE_ID` when set (Decision 3).
- Tests: repo-level claim semantics (win once, second claimant null,
  stale lease reclaimable, consumed row never reclaimable) run against
  the in-memory repo in unit tests and Pg in pg.itest; bus-level pg.itest
  drives TWO live buses over one database — every event handled exactly
  once across the pair, and a row claimed by a dead instance is re-run
  after the TTL.

### B. sandbox-core: sibling-safe warm pools + host budget backstop

- `warm-pool.ts`:
  - `claim()`: verify drops an unmarked env; CONFLICT/NOT_FOUND from
    `claimEnvironment` drop WITHOUT destroy (Decision 4); other failures
    keep the destroy-and-go-cold path.
  - `createEnvironment()`: when the local list exhausts, one host sweep
    adopts sibling-filled marked envs for this pool and keeps trying
    before falling through cold (Decision 5).
  - `topUp()`: each iteration counts marked ready envs globally (adopting
    untracked ones), provisions only while the GLOBAL stock is short, and
    falls back to local counts when listing fails.
- `sandbox.ts`: `cpuBudget`/`memBudgetMB` constructor options + admission
  check (Decision 6) alongside the `maxEnvs` backstop;
  `hostBudgetsFromEnv` (`SANDBOX_CPU_BUDGET` positive cores,
  `SANDBOX_MEM_BUDGET` positive MB integer; config errors throw at boot).
- apps/sandbox-core-svc: budgets from env, logged when set; compose.yaml
  passthrough; README knobs.
- Tests: the two-wrapper suite — two `WarmPoolSandboxCore`s over ONE fake
  inner core: concurrent fills converge on `size` (not 2×size); racing
  claims hand every env out exactly once, the loser goes cold, and NO
  destroy of a claimed (tenant) env ever happens; a controller that
  didn't fill still claims sibling stock warm. Budget admission: refusal
  past either budget, distinguishable message, `maxEnvs` interplay,
  env-var parsing (rejects garbage, unset = unenforced).

### C. Docs closeout

- roadmap: M14 landed; M15+ seeded (NATS when the bus itself is the
  bottleneck, live-utilization scheduling, disk budgets, turn-level
  failover, Forum dashboard, certificate rotation tooling).
- architecture.md: one paragraph (N controllers: claimed bus rows,
  host-ledger pools, host-enforced budgets).
- README status paragraph.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** claim semantics on the
  in-memory repo; the two-wrapper warm-pool races over a fake inner core
  (deterministic interleavings — the fake resolves claims synchronously,
  so both interleaving orders are driven explicitly); budget admission
  and env parsing.
- **Pg itest (CI job with a live Postgres):** claim atomicity under two
  real connections; two live buses, one database — exactly-once steady
  state, TTL reclaim after a simulated crash.
- **Live-Docker itest:** unchanged. Nothing here touches the container
  path.

## Risks / notes

- **A handler slower than the claim TTL double-runs.** Accepted: that is
  the pre-existing at-least-once contract, now rare instead of systematic.
  The TTL is generous (5 min) and the effects were already idempotent.
- **Fill overshoot under races** (Decision 5): N controllers can
  transiently exceed a pool's size by up to N−1 envs. Converges without
  flapping because refills gate on the global count; the boot-time trim
  still bounds a shrunk config.
- **`stop()` still destroys the warm stock this controller tracks** — with
  shared stock that can include sibling-filled envs, so a clean shutdown
  of one controller may cost the fleet its warm pool for one refill cycle.
  Safe (siblings drop NOT_FOUND ids and refill); wasteful only at deploy
  time. Per-controller stock ownership was rejected: it re-introduces the
  orphan problem M10 closed.
- **Budgets count grants, not usage** — deliberately, unchanged from M12;
  the budget remains the oversubscription dial, now enforced at the host.
- **The reconciler still runs on every controller.** Its publishes are
  idempotent and now consumed once, so the only cost is duplicate GitHub
  polls; acceptable at N≤handful. Electing a single poller is seeded with
  multi-controller follow-ups, not built here.
