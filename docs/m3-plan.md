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
> and `AgentRunner` interfaces. M3 implements against these, adding almost no new
> contract surface.

## Scope

In (per roadmap M3):

- Work-unit FSM wired to Postgres (the orchestrator is the only writer of state).
- Event bus: Postgres LISTEN/NOTIFY over the durable `events` table.
- Per-user secret store (GitHub token + LLM key): envelope encryption, injection.
- Deterministic git/PR wrapper.
- Real `Orchestrator.handleChatEvent` routing for all three `ChatEvent` types.

Out (deferred):

- GitHub webhooks — **poll** PR state instead (roadmap M3 "Out"; webhooks are M5).
- Full guardrail enforcement / auto-deny on tool calls (M3 tail → wired to secret
  store; the approval *gate* itself already exists from M2).
- Slack adapter end-to-end and the agent-runner-svc HTTP surface (M4).
- gVisor/Kata, egress allowlist, output redaction beyond `redactSecrets()`,
  turn budgets, audit log (M5).

## Decisions

1. **PR creation is host-side REST.** The container does `git push` only (token
   injected just-in-time as a per-exec env var, never persisted or logged); the
   orchestrator opens the PR by calling the GitHub REST API from the host with
   the same user token. This matches `docs/security.md` ("push/PR-create is
   proxied through the orchestrator wrapper") and minimizes token exposure inside
   the sandbox.
2. **Shipped as stacked, reviewable PRs**, one per workstream, in dependency
   order **A → B → C → D → E** (like the M1/M2 vertical slices), not one big PR.
3. No webhooks in M3 — a poll-based reconciler maps observed PR state
   (open/merged/closed) onto FSM events.

## Workstreams

### A. db — Postgres repositories + event bus

Implement the existing `Repositories` interface with Drizzle-over-`pg`; add the
event bus. (`pg`, `drizzle-orm`, `drizzle-kit` are already declared deps.)

- `packages/db/src/pg.ts` — `createPostgresRepositories(pool): Repositories`.
  - `workUnits.transition(id, event, patch)` MUST be an **atomic conditional
    update** to avoid a TOCTOU race between two writers computing `nextWorkState`
    off a stale read: `UPDATE work_units SET state=$next, ...patch, updated_at=now()
    WHERE id=$id AND state=$expected`. Compute `$next` from the read-back current
    state inside the same transaction (`SELECT ... FOR UPDATE`), or loop-guard on
    `rowCount === 0` → `IllegalTransitionError`. Illegal transition and
    lost-update both surface as the same typed error.
  - Other methods map 1:1 to the in-memory reference semantics.
- `EventBus` interface (new, in `db`): `publish(evt: Omit<BusEvent,'id'|'emittedAt'>)`
  and `subscribe(handler): () => void`. Two implementations:
  - `InMemoryEventBus` — synchronous fan-out for unit tests / local boot.
  - `PgEventBus` — `publish` inserts into `events` + `pg_notify(channel, id)`; a
    dedicated `pg` client runs `LISTEN`, loads the row on notify, invokes the
    handler, then stamps `consumed_at`. At-least-once; handlers must be idempotent.
- `packages/db/drizzle/` — commit the `drizzle-kit generate` migration for the
  current schema (offline generation, no DB needed; ADR-0004).
- Tests:
  - `pg.itest.ts` — **self-skips when `DATABASE_URL` is unset/unreachable**,
    mirroring `sandbox.itest.ts`. Covers repo round-trips, transition atomicity
    (concurrent conflicting transitions → exactly one wins), and a LISTEN/NOTIFY
    publish→receive round-trip.
  - Pure unit tests for any argv/SQL-fragment builders kept side-effect-free.

### B. orchestrator — secret store (envelope encryption)

- `packages/orchestrator/src/secrets.ts` — `SecretStore`:
  - `put(userId, conversationId, name, plaintext)` → AES-256-GCM encrypt with a
    key derived from `SECRET_ENVELOPE_KEY` (host key, kept OUT of the DB), store
    `{ciphertext, keyId}` via `SecretRepo`. `keyId` tags the envelope-key version
    for rotation.
  - `resolveRef(ref)` → decrypt to plaintext. `ref` is the opaque
    `secret record id` handed around as `llmKeyRef` — the runner never sees a key
    store, only this resolver (wires to `agent-runner`'s `SecretResolver`).
  - Plaintext is never logged; GCM auth-tag failure (tampering / wrong key) throws.
- `redactSecrets(text, values)` — strips known secret values from any output
  streamed back to chat (security.md requirement).
- Tests: encrypt→decrypt round-trip, tamper/rotated-keyId rejection, redaction.

### C. orchestrator — deterministic git/PR wrapper

- `packages/orchestrator/src/git.ts` — `GitWrapper`:
  - Composes `sandbox-core` `exec` calls for the in-container half:
    `git add -A` → `git commit` → `git push` to the work unit's branch, with
    `GITHUB_TOKEN` supplied as a **per-exec env var** (just-in-time; never written
    to disk, never persisted, never logged).
  - `createPullRequest(...)` — host-side GitHub REST call
    (`POST /repos/{owner}/{repo}/pulls`) using the resolved user token; returns
    `{prNumber, prUrl}` persisted onto the work unit.
  - `pollPrState(...)` — host-side REST read → `'open' | 'merged' | 'closed'`,
    mapped to `prMerged` / `prClosed` FSM events (webhook stand-in).
  - Pure argv builders (`git …`) and repo-URL/`owner/repo` parsing are
    side-effect-free and unit-tested; the exec/REST edges are injected for tests.
- Tests: argv/URL builders, event mapping from polled state, wrapper against a
  fake exec + fake REST client.

### D. orchestrator — real handlers + event routing

Replace the three `handleChatEvent` stubs with real logic; long-running steps
(provisioning, turns) are driven asynchronously via the event bus.

- `conversation.created` → create `conversation` + `work_unit`; if `repoChoice`
  present: `repoChoice`→`PROVISIONING`, `sandbox.createEnvironment` with
  `agentRuntimeMount()` (ADR-0003) + resolved secrets, then `envReady`→`READY`
  and render a status update. Failure → `error`→`FAILED`.
- `message.posted` → ensure an agent session
  (`agents.createSession`, `llmKeyRef` = secret ref); on the first message
  `firstMessage`→`WORKING`; `agents.runTurn(...)` and map the streamed
  `AgentEvent`s to `RenderCommand`s (see `render.ts`).
- `action.invoked` → `classifyAction`:
  - `approval` → `agents.decidePermission(...)`.
  - agent `create-pr` → agent finalizes commits, then the **deterministic**
    `GitWrapper` pushes and opens the PR: `committedAndPushed`→`PRE_PR` then
    `prCreated`→`PR_OPEN`. (Coding/commit is the agent's; the mechanical
    push+PR-open is the wrapper's — reconciles `classifyAction`'s "agent" tag with
    security.md's "proxied wrapper".)
  - deterministic `view-pr` → render the stored `prUrl`.
- `packages/orchestrator/src/render.ts` — **pure** `AgentEvent → RenderCommand[]`:
  `message`/`thought` → `post_message`/`stream_append`; `tool_call`/`tool_result`
  → status; `permission_request` → `post_actions` with `approve:<id>`/`deny:<id>`
  buttons; `turn_end` → status. No I/O, fully unit-tested.
- Tests: full routing scenarios against in-memory repos + fake `SandboxCore` /
  `AgentRunner` (no Docker, no network) — the M2 loopback pattern.

### E. apps/orchestrator-svc — real wiring

- Assemble Pg `Repositories` + `PgEventBus` + `SecretStore` + real `Orchestrator`.
- Apply migrations on boot; keep `/health`.
- A `ChatEvent` ingest endpoint (parsed with the zod schema) + a bus-subscriber
  loop that advances work units. (The chat-gateway that *calls* this is M4; here
  it is exercised by tests / curl.)
- **CI**: add an orchestrator/db job with a `postgres:17` service so `pg.itest.ts`
  actually runs (today CI has no Postgres). Unit + lint + format stay no-Docker.

## FSM reference (already in contracts)

```
CREATED --repoChoice--> PROVISIONING --envReady--> READY --firstMessage--> WORKING
WORKING --committedAndPushed--> PRE_PR --prCreated--> PR_OPEN
PR_OPEN --prMerged--> PR_MERGED   PR_OPEN --prClosed--> PR_CLOSED
(any) --error--> FAILED           (any) --end--> TORN_DOWN
```

The orchestrator is the sole writer; `WorkUnitMachine.apply` → `repo.transition`
is the only path that mutates `state`.

## Testing strategy

- **Unit (no Docker/DB, runs in `pnpm -r test` + CI):** secret crypto, redaction,
  git argv/URL builders, PR-state→event mapping, `render.ts` mapping, and the full
  `handleChatEvent` routing over in-memory repos + fakes.
- **Postgres integration (`pg.itest.ts`):** self-skips without `DATABASE_URL`; run
  in a new CI job with a `postgres:17` service. Covers repos, transition atomicity,
  and LISTEN/NOTIFY.
- No live GitHub calls in CI — the REST client is injected and faked.

## Risks / notes

- **Transition atomicity** is the correctness lynchpin (top-risk #7, FSM vs
  GitHub drift): conditional-update + FOR-UPDATE, tested with concurrent writers.
- **Token exposure** (top-risk #3): token only as a per-exec env var for `push`;
  PR-open is host-side; never logged; `redactSecrets` on outbound chat.
- **At-least-once bus:** handlers idempotent; `consumed_at` marks processed rows;
  a redelivered event must be a no-op against the FSM.
- **Auto-abort caveat** (roadmap): killing a runaway turn must not rely on
  `ExecStream.kill()` alone (docker-exec doesn't propagate the signal into the
  container). Real termination = in-container `kill` or `destroy()`. Turn budgets
  are M5, but any M3 abort path must respect this.
