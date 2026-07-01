# M3 — orchestrator + FSM + secrets (implementation plan)

Design of record for M3. Turns the M0 orchestrator skeleton into the real
control plane: the work-unit FSM persisted to Postgres, a LISTEN/NOTIFY event
bus, an envelope-encrypted per-user secret store, and a deterministic git/PR
wrapper. Chat wiring (Slack) is M4; this milestone makes the orchestrator drive
a work unit end to end behind a platform-agnostic `ChatEvent`/`RenderCommand`
surface.

> Prereqs already landed: contracts (FSM table, `WorkUnit`, `BusEvent`,
> `ChatEvent`/`RenderCommand`, `AgentEvent`, `SecretSpec`), the `Repositories`
> interfaces + in-memory impl, the Drizzle schema, and the M1/M2 `SandboxCore`
> and `AgentRunner` interfaces. M3 implements against these; it adds a **small,
> enumerated** set of interface extensions (see "Contract surface added").

> This revision incorporates a four-lens design review (security, architecture,
> testing/CI, scope). The findings it resolves are called out inline as
> **[review]**.

## Scope

In (per roadmap M3):

- Work-unit FSM wired to Postgres (the orchestrator is the only writer of state).
- Event bus: Postgres LISTEN/NOTIFY over the durable `events` table.
- Per-user secret store (GitHub token + LLM key): envelope encryption, injection.
- Deterministic git/PR wrapper.
- Real `Orchestrator.handleChatEvent` routing for all three `ChatEvent` types,
  as **platform-agnostic** logic over the already-landed `ChatEvent`/
  `RenderCommand` contracts.

**M3/M4 boundary (drawn in ink).** M3 delivers the platform-agnostic routing and
the pure `AgentEvent → RenderCommand[]` mapping only. M4 adds _only_ the Slack
transport + Block Kit rendering that consumes `RenderCommand`s and produces
`ChatEvent`s — **no orchestrator logic lands in M4**. If that invariant cannot be
held, the `message.posted` turn-streaming + `render.ts` move to M4 and M3's
`handleChatEvent` is limited to the FSM-driving events. **[review: scope #1]**

Out (deferred):

- GitHub webhooks — **poll** PR state instead (roadmap M3 "Out"; webhooks are M5).
- Full guardrail enforcement / auto-deny on tool calls (M5). The approval _gate_
  already exists (M2). **No abort path ships in M3** — the auto-abort caveat below
  is context for M5, not M3 work. **[review: scope #6, testing #6]**
- Slack adapter end-to-end and the agent-runner-svc HTTP surface (M4).
- gVisor/Kata, egress allowlist, turn budgets, audit log (M5). Output redaction
  ships in M3 as defense-in-depth (see B), not as the security boundary.

**Not deferred — tenant authZ.** The `(userId ↔ conversationId)` ownership check
is a **precondition of the secret store**, not an M5 guardrail, and ships in M3
(workstream D). **[review: security #6]**

## Decisions

1. **Push and PR-create are both host-side; no writable token enters the
   container. [review: security #1]** The original plan injected the GitHub
   token into the container for `git push`, but `sandbox-core.exec()` merges
   secret env into _every_ exec and child processes (credential helpers, repo
   `pre-push` hooks) inherit it — re-introducing the exact exposure the wrapper
   exists to avoid. Instead the orchestrator performs `git push` from the host
   (HTTPS remote with a host-controlled, single-invocation credential; repo hooks
   disabled) and opens the PR via the GitHub REST API. The container never holds a
   push/PR-capable token. A read-only clone token (if needed) is the only
   in-container credential, matching `docs/security.md`.
2. **Shipped as reviewable PRs in dependency order.** The dependency shape is a
   **diamond, not a line**: A, B, C depend only on landed contracts and are
   siblings (parallelizable); D depends on {A, B, C}; E depends on all.
   **[review: scope #2]**
3. No webhooks in M3 — a **scheduled** poll reconciler (owned by E) maps observed
   PR state (open/merged/closed) onto FSM events. **[review: scope #5]**

## Contract surface added

The "almost no new surface" is now explicit. M3 adds exactly:

- `EventRepo`: `consumedAt?: string` on `EventRecord`, plus `markConsumed(id)`.
  Single owner of the `events` table (see A). **[review: architecture #2]**
- `SecretRepo`: `get(id)` (resolve a secret by record id, since `llmKeyRef` is a
  record id). **[review: architecture #6]**

Both land in `packages/db` and are mirrored in the in-memory reference impl so
unit tests and the Pg impl stay behaviorally identical.

## Workstreams

### A. db — Postgres repositories + event bus

Implement the existing `Repositories` interface with Drizzle-over-`pg`; add the
event bus. (`pg`, `drizzle-orm`, `drizzle-kit` are already declared deps.)
**Split to lead with the correctness lynchpin [review: scope #4]:**

**A1 (first, small, high-signal):** the CI Postgres harness + migrations +
`workUnits.transition` atomicity + its concurrent-writer integration test.
**A2:** the remaining repo methods + both `EventBus` implementations.

- `packages/db/src/pg.ts` — `createPostgresRepositories(pool): Repositories`.
  - `workUnits.transition(id, event, patch)` uses **`SELECT … FOR UPDATE` then
    recompute** as the single design (not the blind conditional-UPDATE variant).
    Inside one transaction: lock+read the current state, `nextWorkState(current,
event)`; if `null` → `IllegalTransitionError` (a _genuine_ illegal transition
    against the true current state), else `UPDATE`. Because the row is locked, a
    lost-update race cannot be misreported as an illegal transition — the loser
    re-reads the committed state and recomputes. **[review: architecture #4,
    testing #3]**
  - Other methods map 1:1 to the in-memory reference semantics; add
    `SecretRepo.get(id)`, `EventRepo.markConsumed(id)`.
- `EventBus` interface (new, in `db`): `publish(evt: Omit<BusEvent,'id'|'emittedAt'>)`
  and `subscribe(handler): () => void`. The `events` table has a **single writer**:
  `EventRepo.append` is the only insert path; `PgEventBus.publish` calls
  `EventRepo.append` then `pg_notify(channel, id)`. `BusEvent` maps to
  `EventRecord` field-for-field. **[review: architecture #2]** Two impls:
  - `InMemoryEventBus` — synchronous fan-out for unit tests / local boot.
  - `PgEventBus` — a dedicated `pg` client runs `LISTEN`; on notify it loads the
    row, invokes the handler, then `markConsumed`. **Recovery:** on startup and
    periodically it also scans for rows with `consumed_at IS NULL` (a dropped
    NOTIFY — fire-and-forget, not buffered — is still processed). At-least-once;
    handlers must be idempotent (see D). **[review: testing #4]**
- `packages/db/drizzle/` — the `drizzle-kit generate` migration is committed
  (`0000_grey_invaders.sql` exists); regenerate for the `consumedAt` change.
- **itest plumbing (must be spelled out, not "mirror sandbox-core"):**
  add `packages/db/vitest.integration.config.ts` (`include: ['src/**/*.itest.ts']`),
  a `db` `test:integration` script, and tsconfig excludes for the itest files,
  support files, and both vitest configs (else `pnpm -r build` compiles the itest
  and breaks). Broaden the root `test:integration` (or invoke the db suite
  directly in CI). **[review: testing #1]**
- Tests:
  - `pg.itest.ts` — self-skips when `DATABASE_URL` is unset/unreachable, with a
    **"must-not-skip" assertion in CI** so a misconfigured URL can't masquerade as
    a pass. **[review: testing #2]** Covers repo round-trips; **deterministic**
    transition atomicity (two real connections: A holds `FOR UPDATE`, assert B
    blocks via `pg_locks`, commit A, assert B recomputes/handles correctly — not a
    bare `Promise.all` race); LISTEN/NOTIFY via an **event-driven await with
    timeout** (LISTEN confirmed before publish) plus the durable-path assertion
    (row inserted → eventually `consumed_at` stamped); and the **missed-notify
    recovery** scan. **[review: testing #3, #4]**

### B. orchestrator — secret store (envelope encryption)

- `packages/orchestrator/src/secrets.ts` — `SecretStore`:
  - Backed by a **keyring** (`keyId → key`), not a single env var, so rotation is
    real. `put(userId, conversationId, name, plaintext)` → AES-256-GCM encrypt
    with the _current_ key, GCM **AAD bound to `(userId, conversationId, name)`**
    (a ciphertext cannot be replayed under a different owner), store
    `{ciphertext, keyId}`. `resolveRef(ref)` → look up by record id
    (`SecretRepo.get(id)`), decrypt with the envelope's `keyId`. `rotate()` batch:
    read-decrypt-old → write-encrypt-current. Keys are supplied to the host via
    `SECRET_ENVELOPE_KEY` (current) + optional retired keys; document the
    keyId→key source. **[review: security #5, #6-AAD]**
  - Plaintext is never logged; GCM auth-tag / AAD failure throws.
- **Live secret registry + redaction.** A per-conversation registry collects
  _every_ resolved plaintext (LLM key, clone token, and the host-side push/PR
  token for its lifetime). `redactSecrets(text, registry)` runs on **100% of
  outbound `RenderCommand` text** in `render.ts`. Documented as **defense-in-depth**
  (a transformed/split secret survives redaction; egress filtering in M5 is the
  real control). **[review: security #3]**
- Tests: encrypt→decrypt round-trip; **multi-keyId decrypt across two active
  versions** (the real rotation path, not just rejection); tamper / wrong-AAD /
  rotated-keyId rejection; redaction of a registered value in each RenderCommand
  variant. **[review: security #5, testing #6]**

### C. orchestrator — deterministic git/PR wrapper (host-side)

- `packages/orchestrator/src/git.ts` — `GitWrapper`, running **entirely on the
  host** (Decision 1): `git push` to the work unit's branch over an HTTPS remote
  with a single-invocation host credential (repo hooks disabled), then
  `createPullRequest(...)` via `POST /repos/{owner}/{repo}/pulls`. The container
  never receives a writable token. Returns `{prNumber, prUrl}` persisted onto the
  work unit. **[review: security #1]**
  - `pollPrState(...)` — host-side REST read → `'open' | 'merged' | 'closed'`,
    mapped to `prMerged` / `prClosed` FSM events (webhook stand-in). Scheduling is
    E's job, not C's.
  - Pure argv/URL/`owner-repo` parsing is side-effect-free; the exec/REST edges
    are injected for tests.
  - **PR-create is idempotent by branch:** before `POST /pulls`, check (via the
    poll read) whether an open PR for the branch already exists; if so, adopt it.
    **[review: security #4, architecture #3]**
- Tests: argv/URL builders; polled-state→event mapping; wrapper against a fake
  REST client; **idempotent create** (second create finds the existing PR).
  The host-side push means the "token never enters the container" claim is
  structurally true; if a residual in-container git step ever returns, it needs a
  live-Docker itest asserting the token is absent from logs + fs. **[review:
  testing #5]**

### D. orchestrator — real handlers + event routing

Replace the three `handleChatEvent` stubs with real logic. **Provisioning is
synchronous within the handler** — the orchestrator `await`s
`sandbox.createEnvironment` and _itself_ applies `envReady`/`error`. The event
bus is reserved for genuinely out-of-process producers (the PR poll reconciler).
This closes the "who emits `envReady`?" gap — `SandboxCore` emits no events.
**[review: architecture #1]**

- **Every handler first asserts tenant ownership:** the event's `userId` owns the
  target `conversationId` / work unit, else `FORBIDDEN` — before resolving any
  secret or touching a work unit. **[review: security #6]**
- **Every handler is idempotent against redelivery:** before applying a
  transition, if the unit is already in or past the target state, **no-op**
  (do not call `transition`, which would throw `IllegalTransitionError`). Handler
  idempotency is distinct from the transition primitive's atomicity.
  **[review: architecture #3, testing #6]**
- External side effects are made idempotent by a stable key (PR-create by branch,
  C); `consumed_at` is stamped in the **same transaction** as the effect's state
  advance where possible, so a crash-then-replay is a no-op. **[review: security #4]**
- `conversation.created` → create `conversation` + `work_unit`; if `repoChoice`
  present: `repoChoice`→`PROVISIONING`, `await sandbox.createEnvironment` with
  `agentRuntimeMount()` (ADR-0003) + resolved secrets, then apply `envReady`→
  `READY` and render status. Failure → `error`→`FAILED`.
- `message.posted` → ensure an agent session (`agents.createSession`, `llmKeyRef`
  = secret record id); on the first message `firstMessage`→`WORKING`;
  `agents.runTurn(...)` and map streamed `AgentEvent`s to `RenderCommand`s.
- `action.invoked` → `classifyAction`:
  - `approval` → `agents.decidePermission(...)`.
  - `create-pr` → **guarded on state** (only from `WORKING`/`PRE_PR`; otherwise
    render an explanatory message — clicking it from `READY` is not an illegal
    crash). Agent finalizes commits, then the **deterministic** host-side
    `GitWrapper` pushes + opens the PR: `committedAndPushed`→`PRE_PR` then
    `prCreated`→`PR_OPEN`. Rename the `ActionClass` variant `agent` →
    **`hybrid`** so the tag stops implying a pure `AgentRunner` dispatch.
    **[review: architecture #5]**
  - `view-pr` → render the stored `prUrl`.
- `packages/orchestrator/src/render.ts` — **pure** `AgentEvent → RenderCommand[]`;
  all output routed through `redactSecrets` (B). `permission_request` →
  `post_actions` with `approve:<id>`/`deny:<id>`; `turn_end` → status. No I/O.
- **Teardown** (`end`→`TORN_DOWN`) — idempotent: delete the secret records (and
  any tmpfs material), and for revocable OAuth/App tokens call the provider revoke
  endpoint. A replayed `end` is a safe no-op. **[review: security #2]**
- Tests: full routing scenarios against in-memory repos + fake `SandboxCore` /
  `AgentRunner` (no Docker/network); **tenant-mismatch → FORBIDDEN**;
  **duplicate-event → no-op** against the FSM; `create-pr` from an illegal state →
  explanatory render, not throw; teardown revokes + is replay-safe.

### E. apps/orchestrator-svc — real wiring

- Assemble Pg `Repositories` + `PgEventBus` + `SecretStore` + real `Orchestrator`.
- **Apply migrations on boot** (`drizzle-kit migrate` / equivalent) before serving;
  keep `/health`. Covered by a boot-migrate smoke in the Postgres CI job.
  **[review: testing #6]**
- A `ChatEvent` **ingest endpoint** (zod-parsed; malformed → `BAD_REQUEST`) + a
  bus-subscriber loop.
- **Owns the poll reconciler schedule** — a periodic (interval) driver that calls
  `GitWrapper.pollPrState` for `PR_OPEN` units and emits idempotent
  `prMerged`/`prClosed` events. This is the concrete webhook replacement; without
  it `PR_OPEN` never advances autonomously. **[review: scope #5]**
- **CI**: a new orchestrator/db job with a `postgres:17` service (health-checked),
  `DATABASE_URL` exported, an explicit `db:migrate` step **before** the integration
  step, and the must-not-skip assertion. Unit + lint + format stay no-Docker.
  **[review: testing #1, #2]**
- Tests: ingest zod-reject + happy-path subscriber advance; boot-migrate smoke.

## FSM reference (already in contracts)

```
CREATED --repoChoice--> PROVISIONING --envReady--> READY --firstMessage--> WORKING
WORKING --committedAndPushed--> PRE_PR --prCreated--> PR_OPEN
PR_OPEN --prMerged--> PR_MERGED   PR_OPEN --prClosed--> PR_CLOSED
(any) --error--> FAILED           (any) --end--> TORN_DOWN
```

The orchestrator is the sole writer; `WorkUnitMachine.apply` → `repo.transition`
is the only path that mutates `state`. Redelivery is handled _above_ this by
handler-level idempotency (D), never by making `transition` swallow illegal
transitions.

## Testing strategy

- **Unit (no Docker/DB, runs in `pnpm -r test` + CI):** secret crypto +
  multi-keyId rotation, redaction across every RenderCommand variant, git
  argv/URL builders, PR-state→event mapping, `render.ts` mapping, and full
  `handleChatEvent` routing over in-memory repos + fakes — including
  tenant-mismatch, duplicate-event no-op, illegal-state `create-pr`, and teardown
  revoke.
- **Postgres integration (`pg.itest.ts`):** self-skips without `DATABASE_URL`
  locally; **must-not-skip in CI**. Runs in the new Postgres job with migrations
  applied first. Covers repos, **deterministic** transition atomicity (explicit
  lock, not a bare race), LISTEN/NOTIFY (event-driven await + durable path), and
  missed-notify recovery.
- No live GitHub in CI — the REST client is injected and faked. The host-side
  push (Decision 1) keeps that claim structurally intact.

## Risks / notes

- **Handler idempotency is as load-bearing as transition atomicity** — at-least-
  once redelivery is normal, and a redelivered transition event must no-op, not
  throw. Tested explicitly. **[review: architecture #3, testing #6]**
- **Transition atomicity** (top-risk #7, FSM vs GitHub drift): `SELECT … FOR
UPDATE` + recompute, tested with an explicit lock so lost-update ≠ illegal
  transition.
- **Token exposure** (top-risk #3): no writable token in the container at all
  (Decision 1); tenant authZ gates every secret resolution; `redactSecrets` on
  100% of outbound chat as defense-in-depth.
- **Auto-abort caveat** (roadmap, context only — no M3 abort path): killing a
  runaway turn must not rely on `ExecStream.kill()` alone (docker-exec doesn't
  propagate the signal into the container). Real termination = in-container `kill`
  or `destroy()`. Turn budgets + abort are M5.
