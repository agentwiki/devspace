# M17 — Expansion XII: work-unit lifecycle reclamation (implementation plan)

Design of record for M17. `Orchestrator.teardown()` has existed since M3 and
been hardened ever since — it destroys the env, revokes and deletes the
conversation's secrets, writes the audit row, and applies `end` → TORN_DOWN
idempotently — but nothing in production has ever called it. Every
environment lives until an operator intervenes by hand: a merged PR leaves
its container running indefinitely, an abandoned conversation keeps its
encrypted GitHub and LLM keys forever, and the M1-era gap analysis has
carried "유휴 회수(GC): ❌" unchanged through sixteen milestones. M17 gives
teardown its production caller: work units track when their tenant last drove
them, and an elected reaper — the second holder of an M15 advisory lease,
exactly the "genuinely singleton periodic task" the M15 closeout said the
election would generalize to when one appeared — tears down what is idle past
a TTL and what is terminal past a grace period. Zero new mechanisms: one
additive column + contract field, one repo method, one `Orchestrator` method,
one boot hook, three knobs. Off by default.

> Prereqs already landed: the idempotent, audited `teardown()` itself
> (M3/M5), the `end` → TORN_DOWN transition legal from every non-terminal
> state (M3 FSM), the advisory `leases` table + `startElectedTask` loop
> (M15), multi-writer-safe transitions (`SELECT … FOR UPDATE`, M3) so a
> reaper and a live handler can never corrupt state, and the additive
> migration discipline (M11/M14/M15).

## What M17 fixes

1. **Nothing ever calls teardown.** The full cleanup path — env destroy,
   token revoke, secret delete, audit, TORN_DOWN — is implemented, tested,
   and dead code in production. Containers, per-env networks, and encrypted
   credentials accumulate until someone notices.
2. **There is no activity truth to reclaim on.** `updatedAt` moves only on
   FSM transitions, and an actively-chatting WORKING conversation never
   transitions — after the first message it is indistinguishable from one
   abandoned weeks ago. Reaping on `updatedAt` alone would kill live
   sessions mid-conversation.

## Scope

In:

- **Activity truth.** `lastActivityAt` on work units: an additive
  `work_units` column + optional `WorkUnit` contract field, bumped by
  `WorkUnitRepo.touch(id)` whenever a tenant drives the session
  (`message.posted`, `action.invoked`, `secret.submitted`). Idleness is
  measured against `max(lastActivityAt, updatedAt)`, so a fresh transition
  counts as life before the first touch and pre-M17 rows (null column)
  degrade to the old `updatedAt` semantics instead of misparsing.
- **The elected lifecycle reaper.** `Orchestrator.reapExpired(policy)` — one
  sweep over the non-terminal states: units in a pre-PR live state
  (CREATED…PRE_PR) idle past `idleTtlMs` are torn down with a status notice
  in their thread; units in a terminal state (PR_MERGED / PR_CLOSED /
  FAILED) unchanged past `terminalGraceMs` are torn down silently. Each
  knob enables its class independently; per-unit failures are counted and
  never stop the sweep. `bootOrchestrator` exposes `startReaper()` — the
  same `startElectedTask` shape as the reconciler, under a new
  `lifecycle-reaper` lease — and both service entrypoints wire it behind
  `reapPolicyFromEnv` (`DEVSPACE_IDLE_TTL_MS`, `DEVSPACE_TERMINAL_GRACE_MS`,
  `DEVSPACE_REAP_INTERVAL_MS`).
- **A reason on the teardown audit row.** `teardown(conversationId, reason)`
  records `requested | idle | expired` in the audit detail, so an operator
  reading the trail can tell reclamation from a user-driven end.

Out (seeded to M18+, with rationale):

- **Reclaiming PR_OPEN environments.** A PR under review holds its env and
  secrets deliberately (Decision 4) — reaping the env alone would need a
  second, partial destroy path for one state. If long reviews prove costly,
  that is its own milestone.
- **Idle _warnings_ before reclamation** ("this session will be reclaimed
  in 1h"). Pure chat UX on top of the same activity truth; nothing
  structural blocks it later.
- **Conversation-transcript persistence / session resume.** Reclamation
  makes "the env is gone, start a new conversation" the normal end of an
  idle session; restoring history into a NEW session is the product feature
  the gap analysis tracks separately, unchanged.

## Decisions

1. **Reclamation is the missing caller of teardown, not a new mechanism.**
   `teardown()` already does everything reclamation needs, idempotently and
   audited, and `end` → TORN_DOWN is legal from every non-terminal state.
   M17 adds no second destroy path — a reaped unit dies exactly the way a
   user-ended one would, so every invariant teardown enforces (best-effort
   env destroy, revoke-before-delete, audit hygiene) holds for free.
2. **Activity is its own column, touched only by tenant-driven events.**
   `updatedAt` is FSM bookkeeping owned by `transition`; overloading it
   would make every future transition look like tenant activity. `touch()`
   bumps `lastActivityAt` alone, from exactly the three chat events that
   mean "the user is driving this session". The idle clock reads
   `max(lastActivityAt, updatedAt)`: a unit that just reached READY is not
   idle even though it was never touched, and a null column (every pre-M17
   row) simply falls back to the old semantics. Additive on the contract
   (`lastActivityAt` optional) — nothing existing re-parses.
3. **Two policies, one sweep.** Idle TTL covers the states whose env and
   secrets are their entire point (rank below PR_OPEN — CREATED through
   PRE_PR, a wedged PROVISIONING included: teardown's env destroy is
   best-effort and its `end` is legal there). Terminal grace covers what
   the FSM is already done with (PR_MERGED / PR_CLOSED / FAILED), where the
   thread has had its closing status and only cleanup remains. Either knob
   alone enables only its class — an operator can collect terminal units
   aggressively while never reaping a live session, or vice versa.
4. **PR_OPEN is deliberately exempt.** Its lifecycle belongs to GitHub, not
   the idle clock: teardown would delete the GitHub token the poll
   reconciler needs and advance the unit past PR_OPEN, so the merge/close
   would never be observed or announced. The webhook/poll moves the unit to
   a terminal state; the terminal grace collects it there. A unit idle _in
   review_ is the system working as designed.
5. **The reaper is the second elected role — the M15 seed cashes in.** N
   controllers each sweeping every work unit would multiply reads and
   teardown races for zero benefit; that is exactly the "genuinely
   singleton periodic task" bar the M15 closeout set. Same
   `startElectedTask`, new `lifecycle-reaper` lease, TTL 2× the interval,
   and the same advisory posture: teardown is idempotent and transitions
   are row-locked, so a paused holder resuming past its TTL costs a
   redundant no-op sweep, never a double destroy.
6. **Off by default, parse-or-refuse, announce idle reaps.** No TTL knob →
   no reaper, byte-for-byte pre-M17 behavior — the zero-config posture
   every milestone has kept. Garbage or non-positive values refuse loudly
   at boot; `DEVSPACE_REAP_INTERVAL_MS` without any TTL is a dead knob and
   refuses too (the boot.ts discipline for silently-dead config). An idle
   reap posts its status ("reclaimed after inactivity — start a new
   conversation") BEFORE the teardown, through the render path that never
   throws — a dead gateway cannot block reclamation. Terminal reaps are
   silent: the thread already ended with its PR status; the audit row is
   the record.
7. **The sweep enumerates by state, not with a new query surface.**
   `listByState` per swept state (8 small indexed reads on
   `work_units_state_idx`) keeps `WorkUnitRepo` at one additive method
   (`touch`). A dedicated "stale units" query is an optimization for a
   table size this system has never seen; the interval knob is the
   pressure valve.

## Workstreams

### A. Activity truth (contracts + db + orchestrator touch points)

- contracts: `lastActivityAt` (optional datetime) on `WorkUnitSchema`.
- db: `work_units.last_activity_at` (nullable, additive migration 0004);
  `WorkUnitRepo.touch(id)` — bumps only `lastActivityAt`, missing id is a
  no-op — on both the in-memory and Pg implementations; row mapping.
- orchestrator: touch on `message.posted`, `action.invoked`,
  `secret.submitted` (after ownership asserts; a failed touch must not
  fail the event).
- Tests: touch bumps `lastActivityAt` and nothing else (both repos, Pg via
  the existing itest suite); handler events stamp activity.

### B. The elected reaper (orchestrator + boot + svc wiring)

- `reaper.ts`: `ReapPolicy` (`idleTtlMs?`, `terminalGraceMs?`,
  `intervalMs`), `IDLE_REAP_STATES` / `TERMINAL_REAP_STATES`,
  `reapPolicyFromEnv(env)` (Decision 6).
- `index.ts`: `teardown(conversationId, reason = 'requested')` with the
  reason in the audit detail; `reapExpired(policy, nowMs?)` per Decisions
  3–6 — returns `{ reaped, failed }`, per-unit try/catch.
- `boot.ts`: `startReaper(policy)` on `BootedOrchestrator` — elected under
  `lifecycle-reaper`, logs each sweep that did work.
- orchestrator-svc + chat-gateway-svc (the in-process demo boots the same
  control plane): start when configured, stop on close; boot log states
  whether reclamation is on and with what policy.
- compose/.env.example knobs.
- Tests: idle unit past TTL reaped (env destroyed, secrets gone, status
  posted, audit reason `idle`); fresh touch defers reaping; PR_OPEN idle
  unit untouched; terminal unit past grace reaped silently with reason
  `expired`, within grace untouched; single-knob policies reap only their
  class; a teardown failure counts as failed and the sweep continues;
  election wiring reuses the M15 loop (holder sweeps, non-holder skips).

### C. Docs closeout

- roadmap: M17 landed; M18+ seeded (PR_OPEN env cost, idle warnings, the
  rest carried forward).
- architecture.md: one paragraph (activity truth + the reaper).
- README status paragraph; gap analysis 유휴 회수 row flipped.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above the wire —
  both repo implementations, `reapExpired` over the in-memory repos with an
  injected clock, `reapPolicyFromEnv` parse/refuse, the election loop with
  injected scheduler (existing election tests already cover the lease
  mechanics; the new tests cover the reaper's run).
- **Pg itest:** `touch` + `lastActivityAt` round-trip in the existing
  suite; migration 0004 applies via the same `runMigrations` path every
  itest already exercises.
- **Live-Docker itest:** untouched — reclamation calls the same
  `destroyEnvironment` the live suite already proves.

## Risks / notes

- **Reaping a session the user still wanted.** The TTL is the operator's
  dial and idleness requires BOTH no tenant event and no transition for the
  whole window; the reap announces itself in the thread, and the user's
  next message gets the existing "start a new conversation" guidance. Data
  loss is bounded by design: anything pushed/PR'd survives on GitHub — the
  env was always ephemeral (the M1 posture).
- **A turn longer than the idle TTL.** `lastActivityAt` stamps the message
  that started the turn, so a TTL shorter than a long turn could reap
  mid-turn. Turn budgets (M5) bound turns to minutes while TTLs are hours;
  documented rather than machinery (streaming agent events do not touch —
  they are the system talking, not the tenant).
- **Reaper vs. live handler races.** Transitions are row-locked and rank-
  guarded (`advance` no-ops at/past target), teardown is idempotent and
  replay-safe, and the env destroy is best-effort — the established
  multi-writer posture (M3/M14) already covers the new writer.
- **Terminal grace vs. PR archaeology.** Teardown deletes secrets and the
  env but never the conversation, work unit, or audit rows — `view-pr`
  and the session list still answer after reclamation.
