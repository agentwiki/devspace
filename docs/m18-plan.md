# M18 — Expansion XIII: idle warnings + PR_OPEN env release (implementation plan)

Design of record for M18. M17 gave `teardown()` its production caller, and the
closeout seeded the two pieces of the reclamation story it deliberately left
unpaid: the tenant hears about an idle reap only when it happens (the notice
and the teardown land in the same sweep — there is no chance to object), and a
PR_OPEN unit keeps its container running for the entire review, however long
GitHub takes, because the only destroy path the system has kills the whole
session (Decision 4 exempted the state for exactly that reason). M18 pays
both: the reaper warns an idle tenant a configured window before it reaps, and
PR_OPEN units idle in review lose their ENVIRONMENT — the expensive part —
while the unit, its secrets, and the merge/close announcement survive intact.
Zero new mechanisms: one additive column + contract field, two additive repo
methods, two knobs, and new phases in the sweep the elected reaper already
runs. Off by default, independently of each other and of M17's knobs.

> Prereqs already landed: the elected reaper and its sweep (`reapExpired`,
> M17), activity truth (`lastActivityAt` + the max(activity, transition) idle
> clock, M17), the render path that never throws (M4/M6), the additive
> migration discipline (M11/M14/M15/M17), `SandboxError.NOT_FOUND` as the
> fleet-wide "already gone" signal (M8/M14), and expose-port/message guards
> that already answer gracefully when `envId` is absent (M6).

## What M18 fixes

1. **Reclamation is a surprise.** The idle notice posts in the same sweep
   that destroys the env — a tenant who stepped away for lunch a minute
   before the TTL fired comes back to a dead session with zero warning. The
   M17 closeout called the fix "pure chat UX on top of the same activity
   truth"; this is it.
2. **A PR under review is a container under review.** PR_OPEN is exempt from
   the idle TTL (correctly — GitHub owns that lifecycle), so a review that
   takes two weeks holds a container, its per-env network, and its preview
   routes for two weeks. The unit needs its GitHub token and its thread until
   merge/close; it has not needed its environment since the push (the PR was
   pushed from the HOST checkout, M3 Decision 1).

## Scope

In:

- **Idle warnings.** `DEVSPACE_IDLE_WARN_MS` opens a warning window before
  the idle TTL: a pre-PR unit idle past `idleTtlMs - idleWarnMs` gets one
  message in its thread ("idle, will be reclaimed in about X — send a message
  to keep it"), recorded in a new nullable `work_units.idle_warned_at`
  (additive migration 0005, optional `idleWarnedAt` contract field, written
  only by the new `WorkUnitRepo.markIdleWarned`). With the knob set, **no
  idle reap ever happens unwarned**: the reap fires only once a warning
  posted after the tenant's last sign of life has stood for the full window —
  a unit discovered already past the TTL (reaper just elected, TTL shortened)
  is warned first and reaped `idleWarnMs` later, never on the spot. Tenant
  activity after a warning invalidates it (the comparison is
  `idleWarnedAt > max(lastActivityAt, updatedAt)` — nothing clears the
  column; `touch` stays single-purpose).
- **PR_OPEN env release.** `DEVSPACE_PR_OPEN_ENV_TTL_MS` gives PR_OPEN units
  the partial-destroy path the M17 closeout priced: idle past the TTL, the
  sweep destroys the environment (container, per-env network, preview routes
  — `destroyEnvironment` already revokes them all), clears `envId` +
  `agentSessionId` via the new `WorkUnitRepo.releaseEnv`, audits
  `env.released`, and posts one notice. The unit stays PR_OPEN with its
  secrets: the reconciler still polls, the webhook still matches, merge/close
  still announces, and the terminal grace still collects — teardown's env
  destroy was always best-effort, so a released unit tears down cleanly.
- **The sweep grows phases, not siblings.** Both features run inside
  `reapExpired` under the same `lifecycle-reaper` lease, per-unit try/catch,
  same idle clock. The result gains `warned` and `released` counts.

Out (seeded to M19+, with rationale):

- **Re-provisioning a released env.** A released PR_OPEN unit answers
  `view-pr`, announces merge/close, and tells a tenant who asks for more
  that the environment is gone — the M6 guards already say this gracefully.
  Rebuilding an env to continue work on an open PR (fresh clone of the PR
  branch, new agent session) is a product feature — "resume", not
  reclamation — and it is exactly the session-resume line the gap analysis
  already tracks.
- **Warning escalation / repeat warnings.** One warning per idle period,
  by design (`idleWarnedAt` vs activity decides staleness). If one is not
  enough, the operator's dial is a longer window, not a louder reaper.
- **Warnings before PR_OPEN release.** The release is not the end of the
  session — the thread lives on to its merge/close, and the notice states
  an accomplished, recoverable fact. A pre-release warning would ask the
  tenant to "keep alive" an env they cannot use from chat in PR_OPEN
  (messages in that state already answer "start a new conversation").

## Decisions

1. **A warned tenant always gets the full window.** The naive scheme — warn
   at `ttl - warn`, reap at `ttl`, both measured from last activity — breaks
   exactly when it matters: a unit already past the TTL when the reaper
   first sees it (fresh election, knob just tightened, reaper just enabled
   on an old deployment) would be warned and killed in the same breath, or
   killed unwarned. So the reap condition with warnings enabled is not "idle
   past the TTL" but "idle past the TTL AND warned — after the tenant's last
   sign of life — at least `idleWarnMs` ago". In the steady state the two
   coincide (the warning posts within one sweep interval of `ttl - warn`);
   in the pathological cases the warning window is honored from the moment
   the warning actually posted. The TTL is the floor, never the ceiling.
2. **`idleWarnedAt` is a persisted column, compared — never cleared.** The
   warning must survive controller failover (an elected sibling must not
   re-warn, and must be allowed to reap on the strength of its predecessor's
   warning), so it lives on the row, M17-style. But no code path clears it:
   a warning is stale iff `idleWarnedAt <= max(lastActivityAt, updatedAt)` —
   the same clock that measures idleness decides whether the warning
   happened during THIS idle period. `touch` keeps its single M17 purpose,
   `markIdleWarned` is the only writer, and `updatedAt` stays owned by
   `transition`.
3. **Warn through the render path, no audit row.** The warning is chat UX —
   a message, not a privileged effect (nothing is destroyed, resolved, or
   revoked), so it posts via the same emit discipline as every other
   message and writes no audit row; the column is the operator's record.
   Post first, mark second: a failed post retries next sweep unmarked, a
   failed mark re-warns once — annoying beats unwarned.
4. **Release destroys strictly, tolerating only NOT_FOUND.** teardown's
   swallow-everything env destroy is right when the unit is dying — there
   is nothing left to retry from. A released unit lives on, and its `envId`
   is the ONLY pointer the control plane holds to that container: clearing
   it after a swallowed transient failure would leak the container with no
   record and no retry (nothing else reclaims an unmarked tenant env —
   M10/M14 sweeps touch pool-marked stock only). So the release clears
   `envId` only after `destroyEnvironment` succeeds or throws
   `SandboxError NOT_FOUND` (the fleet-wide "already gone", M8) — anything
   else counts as failed and the next sweep retries. The notice posts AFTER
   the release for the same reason: it states a fact, and a retried destroy
   must not re-announce.
5. **`releaseEnv` clears the agent session with the env.** The ACP session
   lived in the destroyed container; a stale `agentSessionId` would send
   `decidePermission` to a dead session if a leftover approval button were
   clicked in a PR_OPEN thread. Cleared together, the existing
   `if (!wu.agentSessionId) return` guard answers instead. One additive
   repo method (`releaseEnv(id)`: null both, touch nothing else — reusing
   `transition` is impossible anyway: its patch column mapping skips
   `undefined` and PR_OPEN must not transition), in-memory and Pg.
6. **PR_OPEN release keeps the M17 idle clock, unwarned.** Same
   `max(lastActivityAt, updatedAt)` measure — a tenant driving the thread
   (view-pr clicks are `action.invoked`, which touches) defers the release
   like it defers every other reclamation. No warning phase (see Scope);
   the notice tells the tenant what happened and that the PR flow is
   unaffected. `expose-port` after release answers "No running environment"
   — the M6 guard, unchanged.
7. **Knob discipline, extended not bent.** `DEVSPACE_IDLE_WARN_MS` without
   `DEVSPACE_IDLE_TTL_MS` is a dead knob and refuses at boot (there is no
   TTL to warn ahead of); `idleWarnMs >= idleTtlMs` refuses too (the unit
   would be "warned" the moment it went idle — a misconfiguration, not a
   policy). `DEVSPACE_PR_OPEN_ENV_TTL_MS` is a third independent enabler:
   any of the three TTLs brings the reaper up, and the
   interval-without-anything refusal now checks all three.

## Workstreams

### A. Idle warnings (contracts + db + reaper)

- contracts: `idleWarnedAt` (optional datetime) on `WorkUnitSchema`.
- db: `work_units.idle_warned_at` (nullable, additive migration 0005);
  `WorkUnitRepo.markIdleWarned(id)` — bumps only `idleWarnedAt`, missing id
  is a no-op — in-memory and Pg; row mapping.
- orchestrator: `idleWarnMs` on `ReapPolicy` + `DEVSPACE_IDLE_WARN_MS` in
  `reapPolicyFromEnv` (Decision 7); the warn phase and the warned-window
  reap condition in `reapExpired` (Decision 1); `warned` in the result;
  boot/svc log lines; `.env.example` + compose knobs.
- Tests: repo method (both repos + Pg itest, migration applies); warning
  posted once and only once per idle period; activity invalidates a
  warning; no unwarned reap when configured (late-discovery case included);
  steady-state reap unchanged at the TTL; parse refusals.

### B. PR_OPEN env release (db + reaper)

- db: `WorkUnitRepo.releaseEnv(id)` — nulls `envId` + `agentSessionId`,
  nothing else — in-memory and Pg (no migration: both columns exist).
- orchestrator: `prOpenEnvTtlMs` on `ReapPolicy` +
  `DEVSPACE_PR_OPEN_ENV_TTL_MS`; the release phase in `reapExpired`
  (Decisions 4–6): destroy (NOT_FOUND-tolerant) → `releaseEnv` → audit
  `env.released` → notice; `released` in the result; boot/svc log lines;
  `.env.example` + compose knobs.
- Tests: released unit stays PR_OPEN with secrets + prNumber (reconciler
  input intact) and cleared envId/agentSessionId; within TTL untouched;
  envId-less PR_OPEN skipped; NOT_FOUND destroy still releases; other
  destroy failures keep envId and count failed (retry next sweep, no
  duplicate notice); terminal grace still collects a released unit;
  activity defers release.

### C. Docs closeout

- roadmap: M18 landed; M19+ seeded (re-provision/resume, the rest carried).
- architecture.md: one paragraph (the warning window + the partial destroy).
- README status paragraph; gap analysis idle-reclamation row annotated.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** both repo implementations,
  the extended `reapExpired` over in-memory repos with the injected clock
  (the M17 harness grows cases, not shape), `reapPolicyFromEnv` refusals.
- **Pg itest:** `markIdleWarned` + `releaseEnv` round-trips in the existing
  suite; migration 0005 applies via the same `runMigrations` path.
- **Live-Docker itest:** untouched — release calls the same
  `destroyEnvironment` the live suite already proves.

## Risks / notes

- **A warning the tenant never saw.** The render path retries then drops by
  design (M6) — a dropped warning is indistinguishable from a posted one on
  the row. Accepted: the same is true of every message the system sends,
  the TTL floor still holds, and the alternative (acknowledged delivery)
  is a platform feature no adapter offers.
- **Sweep-cadence granularity.** Warnings post on the first sweep after
  `ttl - warn`, reaps on the first sweep after the window closes — both up
  to one interval late. The interval is already the reaper's documented
  resolution (M17); the warning window inherits it.
- **Released env vs. a review that reopens work.** A tenant who wants more
  changes on an open PR was ALREADY told "start a new conversation"
  (M4/M6 message guard in PR_OPEN) — the release changes what the guard
  costs, not what it says. Resume-on-PR is the M19+ seed.
- **Reaper vs. live handler races, again.** `releaseEnv` writes two
  columns on a unit in a state whose handlers never write them (`envId` /
  `agentSessionId` are set on the READY/WORKING path, rank-guarded behind
  `advance`), destroy is NOT_FOUND-tolerant on both ends, and the elected
  loop's advisory posture is unchanged — a double release is a no-op by
  the same argument as a double teardown.
