# M19 — Expansion XIV: session resume (implementation plan)

Design of record for M19. M18 made a PR under review cheap — the environment
goes, the unit stays — but strictly one-way: nothing can rebuild what the
release destroyed, and a tenant asked by a reviewer for one more change is
told to start a new conversation, which would mint a NEW branch and a SECOND
PR. M19 pays the seed both m18-plan and the roadmap carried: an explicit
`resume-work` action takes a PR_OPEN unit back to WORKING — re-provisioning
the environment from the PR branch when it was released — and an idle resumed
unit is SUSPENDED back to PR_OPEN (env released, unit intact) instead of torn
down, so resuming never makes an open PR reapable. Zero new knobs, zero
migrations, zero gateway changes: two additive FSM events, one action id, and
new branches in the sweep the elected reaper already runs.

> Prereqs already landed: PR_OPEN env release + `releaseEnv` (M18), the
> elected reaper and its idle clock (M17/M18), secrets that survive PR_OPEN
> (teardown deletes them only at TORN_DOWN — M17 Decision 4 kept the token
> for the reconciler), idempotent create-pr that ADOPTS an existing open PR
> for the branch (M3 `pushAndOpenPr`), `SandboxError NOT_FOUND` as the
> fleet-wide "already gone" (M8), and generic action buttons both adapters
> render without allowlisting (M4/M6 — `resume-work` needs no gateway diff).

## What M19 fixes

1. **An open PR is a dead end for more work.** Review feedback lands, the
   tenant returns to the thread, and every message answers "start a new
   conversation" — losing the branch and the PR association. Continuing on
   the SAME PR (the entire point of review feedback) is impossible.
2. **M18's release is irreversible.** The env-release path made weeks-long
   reviews affordable, but a released unit can only ever answer `view-pr`
   and announce its merge — the container that could act on the review can
   never come back.

## Scope

In:

- **`resume` — PR_OPEN → WORKING, by explicit action.** A message posted in
  PR_OPEN now offers a `resume-work` button (instead of the bare dead-end
  text); clicking it re-provisions the environment when it is gone —
  cloning `repoUrl` at `ref = branch`, the PR branch, so the agent continues
  from exactly what the reviewer sees — and applies the new `resume`
  transition. The agent session is NOT created here: the next message
  creates it through the existing lazy path, exactly like a fresh READY
  unit (the LLM key check, audit, and error answers all reuse).
- **A `resume` self-loop on WORKING.** The lazy session path persisted
  `agentSessionId` via `advance(…, 'firstMessage', …)`, which no-ops (and
  silently DROPS the patch) when the unit is already WORKING — a resumed
  unit would have minted one orphan ACP session per message. The message
  handler now takes the `firstMessage` edge from READY and the `resume`
  self-loop from WORKING, so the session id always lands on the row.
- **`suspend` — WORKING/PRE_PR → PR_OPEN, in the idle sweep.** An idle unit
  carrying a `prNumber` (⇔ it has been through PR_OPEN and back — only
  resume does that) is suspended, never torn down: destroy the env
  tolerating only NOT_FOUND (M18 Decision 4 verbatim — the unit lives on),
  `releaseEnv`, apply `suspend`, audit `session.suspended`, and post one
  notice carrying the `resume-work` button. The M18 warning discipline
  covers suspension too (no idle reclamation unwarned), with text that says
  "paused", not "reclaimed". The PR_OPEN release notice also gains the
  button — the moment the env dies is the moment resume becomes relevant.
- **PR truth pauses while resumed; the poll catches it up.** Webhook match
  and reconciler enumerate PR_OPEN only, so a merge/close landing mid-resume
  is deferred, not lost: `handleBusEvent` DROPS `prMerged`/`prClosed` for a
  unit below PR_OPEN (pre-M19 it would throw IllegalTransition — and a
  throwing bus handler redelivers forever), and the poll re-detects the
  state once the unit is back in PR_OPEN (suspend, or the next create-pr).

Out (seeded to M20+, with rationale):

- **History restore.** A resumed agent session starts blind: its context is
  the branch state, not the prior conversation. Feeding transcript history
  into a fresh ACP session needs transcript persistence first — the
  contract-stage line the gap analysis tracks (`message`/AgentEvent tables
  per conversation) — and an agent-side injection story. Resume is useful
  without it (the code IS most of the context); the seed stays priced.
- **Auto-resume on message.** A stray "thanks!" in a PR thread must not
  boot a container. The explicit button is the cost gate, exactly like
  `create-pr` (m4-plan) and `set-secrets` (m6-plan) before it.
- **Resuming merged/closed/torn-down units.** Terminal states genuinely
  need a new conversation: the branch's PR is settled, secrets may already
  be deleted, and "resume" would mean re-running repo choice — which is
  what a new conversation is.

## Decisions

1. **Resume is an action, not a message side effect.** Chat surfaces stay
   append-only ergonomic: a message in PR_OPEN answers with the offer
   (`post_actions`, stable id `resume-work`), and only the click pays for a
   container. Both adapters already render arbitrary action buttons and
   defer non-modal ids by exclusion — the gateway ships zero changes.
2. **Resume re-provisions from the PR branch and trusts the host, not the
   row.** `ref = wu.branch` — the commits under review. A unit that still
   carries an `envId` probes `getEnvironment` first (M11's "trust the
   daemon" discipline, one hop up): NOT_FOUND means the host lost it (or a
   sibling reaped it) and the resume re-provisions; any other probe failure
   fails the resume message-only. A live env resumes in place — with its
   still-live agent session, since env and session die together
   (`releaseEnv` nulls both, M18 Decision 5).
3. **A failed resume leaves the unit PR_OPEN.** Never `error → FAILED`: the
   unit's lifecycle belongs to GitHub while its PR is open (the M17
   exemption argument) — a provisioning hiccup must not skip the unit past
   its own merge. The failure is answered in-thread and the button retries.
   An env provisioned in the failing attempt is destroyed best-effort
   before answering: its id was never persisted, so leaving it would leak a
   container with no pointer (the M18 Decision-4 hazard, one call wide
   here — accepted where the reaper's persistent-pointer version was not).
4. **envId lands in the same transition that makes the unit WORKING.**
   Provision first, then one `machine.apply('resume', { envId })` — there
   is no window where the row owns a container it doesn't know about. The
   backward move goes through `machine.apply` directly: `advance` keeps its
   forward-only idempotency semantics untouched.
5. **Suspension, not teardown, for any idle unit with a prNumber.** The
   idle TTL's job is reclaiming the expensive part; for a resumed unit
   that is the environment, and the unit itself is load-bearing (it holds
   the PR fields and the token the reconciler needs — the exact M17
   Decision-4 argument). Order: destroy (NOT_FOUND-tolerant, strict
   otherwise — envId is the only pointer) → `releaseEnv` → `suspend` →
   audit → notice-with-button. Each step is retryable by the next sweep:
   a crash after `releaseEnv` leaves a WORKING unit with no env, which the
   suspend path handles by skipping the destroy. The warning phase treats
   resumed units identically (the M18 invariant extends: no idle
   reclamation unwarned) with "paused" wording.
6. **Merge-during-resume defers to the poll backstop.** While resumed, the
   unit is invisible to webhook matching and the reconciler (both list
   PR_OPEN) — deliberately: `prMerged` is illegal from WORKING, and racing
   the tenant's live work to announce a merge helps nobody. `handleBusEvent`
   drops (never throws on) a PR event for a unit below PR_OPEN; on suspend
   the reconciler's next poll re-publishes and the announcement lands. A
   tenant who instead finishes with create-pr re-pushes the branch:
   `pushAndOpenPr` adopts the still-open PR, or opens a fresh one when the
   old PR settled mid-resume — the unit's prNumber/prUrl update with it
   (the old PR's announcement is superseded, not owed).
7. **Two events, no knobs, no migrations.** `resume` (PR_OPEN → WORKING +
   the WORKING self-loop) and `suspend` (WORKING/PRE_PR → PR_OPEN) are the
   entire contract diff; both columns suspension writes exist since M18.
   Suspension rides `DEVSPACE_IDLE_TTL_MS` — a resumed unit is a working
   unit, and after suspension it is a PR_OPEN unit where
   `DEVSPACE_PR_OPEN_ENV_TTL_MS` finds nothing left to release. Resume
   itself costs nothing until clicked, so it has no enable switch.

## Workstreams

### A. Resume (contracts + orchestrator handlers)

- contracts: `resume`/`suspend` in `WorkEventSchema`; transitions
  `PR_OPEN.resume → WORKING`, `WORKING.resume → WORKING`,
  `WORKING.suspend → PR_OPEN`, `PRE_PR.suspend → PR_OPEN`.
- orchestrator: `resume-work` in `classifyAction`; `onResumeWork`
  (Decisions 1–4): guards (active → "already active", terminal →
  "finished", no repo/branch), env probe, re-provision at `ref = branch`
  with the clone token (audited `secret.resolved` purpose `env.resume`),
  `resume` transition, audit `session.resumed { envId, reprovisioned }`,
  status message; the PR_OPEN message guard becomes the resume offer;
  the lazy session path persists via `firstMessage`-from-READY /
  `resume`-self-loop-from-WORKING; `handleBusEvent` drops PR events below
  PR_OPEN (Decision 6).
- Tests: contracts legality; classifyAction; released unit resumes with a
  fresh env cloned at the PR branch; live-env resume reuses env + session;
  stale-envId resume re-provisions; the next message creates ONE session
  and persists it (the advance-drop regression); provisioning failure
  stays PR_OPEN and retries; transition race destroys the fresh env;
  resume offers on message; merged unit refuses; create-pr after resume
  returns to PR_OPEN; bus event for a resumed unit is dropped.

### B. Suspension (reaper)

- orchestrator: the idle phase branches on `prNumber` — suspend
  (Decision 5) instead of teardown; `suspended` in the sweep result; the
  warn text says "paused" for resumed units; the M18 release notice
  becomes a `post_actions` carrying `resume-work`; boot log line grows
  the count.
- `.env.example`: the idle-TTL comment notes resumed units are paused,
  not torn down.
- Tests: idle resumed unit suspends (env destroyed, both ids cleared,
  state PR_OPEN, prNumber + secrets intact, audit, one notice with the
  button); within TTL untouched; non-NOT_FOUND destroy failure keeps
  envId and retries with one notice total; NOT_FOUND still suspends;
  envless resumed unit still suspends (crash-retry path); warning
  precedes suspension with the paused wording; existing counters gain
  `suspended: 0`.

### C. Docs closeout

- roadmap: M19 landed; M20+ seeded (history restore over transcript
  persistence; the rest carried).
- architecture.md: FSM diagram gains the resume/suspend edges + one
  paragraph.
- README status paragraph; gap analysis: reclamation row gains M19,
  transcript row notes resume ships history-less.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** contracts transition table;
  the resume flow and bus-event guard over in-memory repos (the M4/M17
  handler harness grows cases, not shape); the suspension sweep with the
  injected clock (the M17/M18 reaper harness likewise).
- **Pg itest:** untouched — no migrations; `transition` is generic over the
  table the contracts own, and `releaseEnv` round-trips since M18.
- **Live-Docker itest:** untouched — resume calls the same
  `createEnvironment`/`getEnvironment`/`destroyEnvironment` the live suite
  already proves.

## Risks / notes

- **A resumed unit hides its PR from the reconciler.** Deliberate
  (Decision 6) and bounded: the idle TTL guarantees an abandoned resumed
  unit returns to PR_OPEN, where the poll re-detects within one interval.
  Deployments without the idle TTL knob simply keep the unit as long as
  the tenant left it — the pre-M17 posture, unchanged in kind.
- **Force-push semantics on re-push.** create-pr after resume runs the same
  `--force-with-lease` push as ever — against the branch the resumed env
  just re-cloned at its tip, so the lease holds unless someone else pushed
  mid-session; then the push fails loudly and the tenant decides. Unchanged
  from M3, restated because resume makes the second push common.
- **The one-call-wide leak window (Decision 3).** A destroy that fails
  right after a provision that succeeded leaks one container with no
  pointer. Accepted: the window is a single failing call on a boundary
  that just proved healthy, unlike the reaper's standing-pointer variant
  the M18 Decision-4 discipline exists for.
- **Registry warmth after resume.** The redaction registry is in-memory
  per conversation and survives PR_OPEN untouched; a controller restart
  mid-review cold-starts it — and the message path re-registers the LLM
  key every turn (M4), so the invariant holds on the first resumed turn.
