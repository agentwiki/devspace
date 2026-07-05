# M21 — Expansion XVI: transcript replay + retention policy (implementation plan)

Design of record for M21. M20 made the conversation durable and deliberately
readable — "rows survive teardown like audit rows, readable
(`listByConversation`) for the product surfaces the M21+ seeds carry." M21
cashes the two seeds that are ready today: the first **transcript product
surface** (an in-chat `!history` replay of the durable transcript, chat-only
per the parity analysis) and the **retention policy** the M20 closeout priced
("both are append-only, text-only, per-conversation — the same growth class;
a retention knob is an operator policy for the milestone that needs one").
Zero contract changes, zero migrations: one stable action id + a thread
convention, two additive repo methods, two knobs, and a prune phase in the
sweep the elected reaper already runs.

> Prereqs already landed: the redacted-at-rest `transcripts` table +
> `TranscriptRepo` with tail/full reads (M20), the elected `lifecycle-reaper`
> running `reapExpired` on every enabler knob (M17/M18), the `!port` thread
> convention → stable-action-id normalization shape shared by both adapters
> (M6/M7), and the chunked `post_message` render path on both platforms
> (Slack newline-boundary chunks, Discord 2000-char bodies).

## What M21 fixes

1. **The durable transcript has no reader a tenant can reach.** M20's table
   feeds exactly one consumer — the resume preamble. A tenant returning to a
   suspended session (or auditing what an agent said before its env was
   released) has only the platform thread, which scrolls, truncates streams
   (Discord shows tails), and knows nothing of what the control plane
   actually recorded. The record exists; nothing surfaces it.
2. **Two append-only tables grow forever.** `transcripts` and `audit_log`
   have no deletion path at all — not a bug at demo scale, but real
   multi-tenant deployments need an operator-set horizon, and the reaper
   that should own it already ticks on an elected lease.

## Scope

In:

- **In-chat transcript replay.** `!history` in a session thread (both
  adapters, the `!port` normalization shape) becomes `action.invoked` with
  the stable id `view-history`; the orchestrator answers with a bounded,
  role-labelled replay of the transcript tail as one ordinary redacted
  `post_message`. Works in every state — the rows survive suspension, env
  release, and teardown, so the replay does too.
- **Retention as a reaper phase.** `TranscriptRepo.deleteBefore(cutoff)` and
  `AuditRepo.deleteBefore(cutoff)` (additive, both implementations, counts
  returned); `DEVSPACE_TRANSCRIPT_RETENTION_MS` / `DEVSPACE_AUDIT_RETENTION_MS`
  knobs on `ReapPolicy`; a prune phase in `reapExpired` that deletes rows
  older than each configured horizon and reports what it dropped. Off by
  default, independently; either knob alone brings the reaper up.

Out (seeded to M22+, with rationale):

- **Native session import** — still blocked on ACP growing a session-load
  surface; the prompt preamble remains the injection story (top-risk #6
  posture, unchanged from the M20 closeout).
- **Web/CLI transcript handoff and richer detail views** — UI stays
  chat-only (chat-platform-ui-parity.md). `/sessions` keeps its one-line
  summaries; the replay is per-thread where the conversation lives. A
  Discord Forum dashboard stays a presentation upgrade, seeded.
- **Per-conversation / per-state retention.** One uniform age horizon per
  table. State-aware policy (e.g. "keep PR_OPEN transcripts longer") buys
  little: pruning a live conversation's oldest rows costs restore/replay
  QUALITY, never correctness — and the uniform horizon is what an operator
  can actually reason about.
- **Transcript export/archival before deletion.** Retention deletes; an
  export pipeline is a different feature with different consumers. An
  operator who needs archives sets a long horizon and dumps the table.

## Decisions

1. **The replay reads the durable transcript, not the platform thread.**
   Same rows the resume preamble reads: exactly what the control plane
   recorded (tenant prompts + coalesced agent replies), redacted at rest,
   surviving teardown. This is the point of the surface — the platform
   thread is the pretty view, the table is the record.
2. **`view-history` is an action id + `!history` ergonomics — no contract
   change.** The M6 expose-port shape verbatim: adapters normalize the
   thread convention onto one stable action id (`parseHistoryCommand`
   beside `parsePortCommand`); `classifyAction` gains a `history` kind.
   `actionId` is already a free string in the contract; buttons/notices are
   untouched.
3. **Bounded, newest-kept, explicitly marked.** `REPLAY_MAX_ENTRIES` (20) /
   `REPLAY_MAX_CHARS` (3 000) — constants like the M20 preamble bounds, not
   knobs. The read probes one entry past the cap, so an "[… earlier history
   omitted …]" marker appears iff something actually exists above the
   window (never a false marker, never silent truncation — the M7
   session-list discipline). Both platforms chunk a 3 000-char message fine.
4. **Replay re-redacts through the live registry.** Rows are redacted at
   rest (M20 Decision 3), but the replay still flows through
   `messageCommand`'s redaction like every other outbound string — the
   100%-of-outbound invariant stays structural rather than resting on the
   at-rest guarantee. A failed tail read answers "couldn't read history",
   message-only — a read surface never throws into the action path.
5. **Retention is an operator horizon on the elected reaper.** A prune
   phase in `reapExpired` computes `cutoff = now − retentionMs` per
   configured table and calls `deleteBefore`. Age-uniform, state-blind
   (Decision rationale in Scope); deletion by age is idempotent, so an
   elected sibling double-running past its lease TTL double-deletes
   nothing. Prune failures count in `failed` and never stop the sweep.
6. **Audit retention is its own deliberate knob.** The audit log is the
   compliance record — it must never ride along on the transcript knob.
   Deleting it is an explicit, separately-configured operator choice
   (`DEVSPACE_AUDIT_RETENTION_MS`), documented as such.
7. **Counts come back.** `deleteBefore` returns the deleted-row count and
   the sweep result grows `prunedTranscripts` / `prunedAudit`, logged like
   every other reap counter — bulk deletion must never be silent (the
   no-silent-caps discipline).
8. **Retention interacts with restore/replay as quality, not correctness.**
   A horizon shorter than a review cycle thins the resume preamble and the
   replay window; both already degrade gracefully (blind resume / "no
   history recorded"). Documented in the ops notes, enforced by nothing.

## Workstreams

### A. Transcript replay (chat-gateway + orchestrator)

- chat-gateway: `parseHistoryCommand(text)` (`!history`, trimmed, bare);
  both adapters map a matching thread reply to `action.invoked` /
  `view-history` before the message.posted fallthrough (the `!port` slot).
- orchestrator: `classifyAction('view-history')` → `{ kind: 'history' }`;
  pure `buildHistoryReplay(entries, opts?)` in transcript.ts (role-labelled
  lines, newest-kept char budget shared with the preamble builder, omitted
  marker driven by the caller's probe); `onViewHistory` — `listTail(…,
REPLAY_MAX_ENTRIES + 1)` → replay → `messageCommand`; empty → "No
  conversation history recorded yet."
- Tests: parser table; adapter fixture tests (both platforms — `!history`
  becomes the action, never an agent prompt); builder shape/order/budget/
  marker/empty; handler answers in WORKING and PR_OPEN and after teardown;
  a throwing `listTail` answers message-only; replay output passes the
  registry (a registered value in a stored row renders redacted).

### B. Retention (db + reaper)

- db: `deleteBefore(cutoffIso)` on `TranscriptRepo` (by `createdAt`) and
  `AuditRepo` (by `at`), returning counts; in-memory + Pg (one `DELETE …
WHERE < cutoff` each); Pg itest rounds a prune trip.
- reaper.ts: `ReapPolicy.transcriptRetentionMs` / `auditRetentionMs`;
  `reapPolicyFromEnv` reads both knobs, either enables the reaper, and the
  interval-without-anything refusal now spans all five enablers.
- index.ts: the prune phase in `reapExpired` (after the state sweeps);
  result grows `prunedTranscripts` / `prunedAudit`; boot.ts log line
  reports them.
- Tests: env parsing (values, garbage, interval-alone refusal update);
  sweep prunes strictly-older rows only and counts them; per-table
  independence (one knob prunes one table); a throwing `deleteBefore`
  counts as `failed` and the rest of the sweep still runs; repo semantics
  in db unit + Pg itest.

### C. Docs closeout

- roadmap: M21 landed; M22+ seeded (carried seeds + export/archival note).
- architecture.md: replay surface + retention paragraph.
- README status; gap analysis: 세션 아카이브/삭제 항목에 보존 정책 각주.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** adapter fixture replays and
  the parser in chat-gateway; builder + handler + sweep cases on the M17-M20
  harness in orchestrator; in-memory repo semantics in db.
- **Pg itest:** `deleteBefore` on both tables (prune old, keep new, counts).
- **Live-Docker itest:** untouched — nothing below the `SandboxCore` seam
  changes.

## Risks / notes

- **A replay is outbound text built from stored strings.** Both defenses
  hold by construction: redact-at-write (M20) AND redact-at-render
  (Decision 4). No new trust boundary — the tenant reads their own
  conversation back.
- **Retention under multi-controller.** Only the lease holder sweeps; a
  double-run double-deletes nothing (age predicate). N controllers with
  DIFFERENT knob values converge on the longest-retention holder winning
  nothing — each sweep enforces its own horizon; operators should configure
  controllers identically (already true of every reap knob, noted in ops).
- **`!history` counts as tenant activity.** It rides `action.invoked`,
  which touches the idle clock like every action — reading your history
  keeps the session alive. Consistent and arguably correct; noted.
- **Replay window vs. platform limits.** 3 000 chars → 2 Discord bodies /
  chunked Slack blocks — well inside both adapters' existing paths; the
  bound is a constant, and a wrong bound costs readability, never
  correctness.
