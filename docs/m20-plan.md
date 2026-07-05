# M20 — Expansion XV: history restore on resume (implementation plan)

Design of record for M20. M19 made an open PR resumable — but blind: a fresh
ACP session's only context is the branch state, and m19-plan priced exactly
what closing that costs. "Feeding transcript history into a fresh ACP session
needs transcript persistence first — the contract-stage line the gap analysis
tracks — and an agent-side injection story." M20 pays both halves: every
conversation-visible turn lands in a durable per-conversation transcript
(redacted at write time), and the first turn of a fresh session on a RESUMED
unit carries a bounded digest of that transcript, so the agent picks the
review conversation back up instead of rediscovering it from the diff. Zero
contract changes, zero knobs, zero gateway changes: one additive table + repo,
one pure preamble builder, and new lines in the message path the orchestrator
already owns.

> Prereqs already landed: resume/suspend and the lazy-session `resume`
> self-loop (M19 — the exact seam that knows "this is a fresh session on a
> resumed unit"), the per-conversation redaction registry re-armed with the
> LLM key EVERY turn (M4 — so redact-at-write is safe even after a controller
> restart), the `Repositories` seam with behaviourally-identical in-memory and
> Pg implementations (M3), and additive-migration discipline (M17/M18).

## What M20 fixes

1. **A resumed agent starts blind.** Review feedback lands, the tenant clicks
   resume, and the agent knows the branch — but not what was asked, tried,
   decided, or promised in the conversation that produced it. The tenant
   re-explains; on a weeks-long review, badly.
2. **Nothing conversation-shaped is durable.** The platform's only transcript
   is the chat platform's own thread — invisible to the control plane. The
   gap analysis has carried "대화 트랜스크립트 영속/복원 ❌" since M1; every
   later product surface (session summaries, web/CLI handoff) needs the same
   table.

## Scope

In:

- **`transcripts` — the durable per-conversation transcript.** Additive
  migration 0006; `TranscriptRepo` (`append`, `listTail`, and a
  `listByConversation` read) on `Repositories`, in-memory and Pg. Rows carry
  `(conversationId, workUnitId, role: user|agent, text, seq, createdAt)`.
- **Writes at the two conversation-visible points.** The message handler
  persists the tenant prompt of every turn it actually RUNS, and one agent
  row per turn — the coalesced `message`-chunk text, flushed when the turn
  ends. Both pass the conversation's redaction registry before storage.
  Best-effort: transcript bookkeeping never fails the turn it rode in on
  (the M17 `touch` discipline).
- **History restore on the M19 resume self-loop.** When the lazy session
  path mints a fresh session on a resumed unit (state WORKING, no
  `agentSessionId` — the self-loop edge), the transcript tail is rendered
  into a bounded preamble and prefixed onto that first prompt. A failed
  read degrades to the M19 blind resume — never a failed turn.

Out (seeded to M21+, with rationale):

- **Native session import.** ACP has no session-load surface; a prompt
  preamble is the injection story that works for EVERY backend today and
  needs no backend diff (the top-risk-#6 posture). If/when the protocol
  grows one, the transcript table is already the source.
- **Persisting thoughts, tool calls, and diffs.** The resumed env re-clones
  the PR branch — the code is the durable record of what happened to the
  tree. What the branch cannot restore is the conversation; that is what
  the table holds. (Also keeps the restore prompt conversation-shaped and
  the table small.)
- **Transcript product surfaces** (chat backfill, `/sessions` detail, web
  handoff). The table is deliberately readable (`listByConversation`), but
  UI stays chat-only per the parity analysis.
- **Retention/deletion policy.** Rows are redacted at rest and survive
  teardown like audit rows; a retention knob is an operator policy for the
  milestone that needs one.

## Decisions

1. **Persist exactly what the tenant saw.** User prompts that reach
   `runTurn` and agent `message` text — the `post_message`-grade content.
   `thought` is internal, tool calls/results/diffs are branch-reconstructible
   noise, and messages that never ran a turn (provisioning guards, the
   PR_OPEN resume offer) are platform chrome, not conversation.
2. **One agent row per turn.** `message` events are stream CHUNKS
   (`agent_message_chunk`); the handler coalesces them and flushes a single
   row when the turn ends — the transcript replays turns, not chunks,
   mirroring the adapters' coalesced stream edits. Flushed in a `finally`,
   so a turn that dies mid-stream still records what it said.
3. **Redact before storing.** The transcript is an outbound surface that
   happens to be a table: text passes the conversation registry (plus the
   M5 token-shape pass) BEFORE it lands, so secret plaintext never reaches
   the row — the audit-hygiene invariant, extended. The registry is warm on
   every turn (M4 re-registers the LLM key each time), so a controller
   restart cannot reopen the hole.
4. **Best-effort writes, degrade-to-blind reads.** An append failure must
   not fail the turn; a restore-read failure must not fail the resume — the
   M19 posture (blind resume) is the fallback, not an error. Both swallowed
   at the call site, both regression-tested.
5. **Injection is a preamble on the FIRST turn of a fresh session on a
   resumed unit, and is never persisted.** Gate = the M19 `resume`
   self-loop edge — the only path that mints a fresh session past READY.
   Only the tenant's own message lands in the transcript, so repeated
   suspend/resume cycles never compound preambles into the table.
6. **Bounded, oldest-dropped.** `listTail` reads the last N entries; the
   pure builder drops oldest whole entries to fit a char budget and marks
   the cut ("earlier history omitted"). Bounds are exported constants
   (120 entries / 6 000 chars), deps-overridable for tests — not knobs: a
   wrong bound costs prompt quality, never correctness.
7. **`seq` owns ordering.** `createdAt` collides inside a burst; a
   bigserial assigns the total order at insert (in-memory: array order),
   and `listTail` is `ORDER BY seq DESC LIMIT n`, reversed. The column is
   repo-internal — the record interface exposes only what consumers order
   by receipt.

## Workstreams

### A. Transcript persistence (db + orchestrator writes)

- db: `transcripts` table (migration 0006: id, conversation_id,
  work_unit_id, role, text, seq bigserial, created_at; index on
  (conversation_id, seq)); `TranscriptRecord`/`TranscriptRepo`;
  `Repositories.transcripts` in both implementations.
- orchestrator: private `appendTranscript` (redact → append, swallow) wired
  at the two write points in `onMessagePosted` (Decisions 1–4).
- Tests: repo round-trip + tail semantics + cross-conversation isolation
  (in-memory unit + Pg itest); handler persists user + coalesced agent rows
  redacted (an echoed LLM key lands as `«redacted»`); guard-path messages
  and non-message events don't persist; a throwing repo never fails the
  turn; a mid-stream death still flushes the partial agent row.

### B. History restore (orchestrator)

- `transcript.ts`: `buildHistoryPreamble(entries, opts?)` — pure; empty
  input → empty string; role-labelled lines; oldest-dropped truncation with
  the marker; a single oversized entry hard-truncated head-first.
- message path: on the `resume` self-loop edge, `listTail` → preamble →
  prefix the prompt (Decision 5); read failure degrades silently
  (Decision 4).
- Tests: builder alone (shape, order, truncation, emptiness); resumed
  unit's first prompt carries prior history and the current message; the
  second message doesn't re-inject; a fresh READY unit never injects; a
  throwing `listTail` still runs the turn blind; a second suspend/resume
  cycle injects history exactly once (nothing compounded); the preamble
  never lands in the transcript.

### C. Docs closeout

- roadmap: M20 landed; M21+ seeded (native session import when ACP grows
  one; transcript product surfaces; retention policy; the rest carried).
- architecture.md: the transcript table + restore path paragraph.
- README status paragraph; gap analysis: 트랜스크립트 row ✅, resume note
  updated.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** the M4/M17/M19 handler
  harness grows cases, not shape; the preamble builder is pure and tested
  alone; in-memory repo semantics in db's unit suite.
- **Pg itest:** the new table round-trips (append → tail order → isolation;
  seq-ordering under same-timestamp inserts).
- **Live-Docker itest:** untouched — nothing below the `SandboxCore` seam
  changes.

## Risks / notes

- **Prompt injection shape.** The preamble replays tenant+agent text into a
  prompt — the same strings the agent already received/produced once, in
  the same trust domain; no new boundary is crossed. The preamble is
  delimited and explicitly framed as history.
- **Token cost.** ≤ ~6 000 chars, once, on the first resumed turn — bounded
  by construction and far cheaper than the tenant re-explaining.
- **Fidelity.** Thought/tool context is deliberately absent (Decision 1);
  a resumed agent may re-derive a rejected approach the transcript's
  message text never mentioned. Accepted: the branch + conversation is
  the contract, full replay is the M21+ seed.
- **Table growth.** Append-only, text-only, per-conversation — the same
  growth class as `audit_log`, and the retention seed covers both.
