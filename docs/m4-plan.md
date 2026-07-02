# M4 — chat-gateway (Slack) end-to-end (implementation plan)

Design of record for M4. Turns the M0 Slack skeleton into the real chat
transport and wires it to the M3 orchestrator so a user drives a work unit end
to end from a Slack thread: pick a repo, send a message, watch the agent stream,
approve a tool call, open and track a PR. **This is the demo.**

> Prereqs already landed: the platform-agnostic `ChatEvent`/`RenderCommand`
> contracts, the `ChatAdapter`/`ChatRenderer` interfaces (`packages/chat-gateway`),
> the real `Orchestrator` (M3) with `handleChatEvent` routing + the pure
> `AgentEvent → RenderCommand[]` mapping (`render.ts`), the FSM/secret store/git
> wrapper, and the Postgres repos + event bus. M4 implements against these; it
> adds a **small, enumerated** read surface (see "Contract surface added") and
> **no new control-plane logic**.

## Scope

In (per roadmap M4):

- Real `SlackAdapter` over **Slack Bolt + Socket Mode**: slash command / new
  thread → `conversation.created`, thread message → `message.posted`, Block Kit
  button → `action.invoked`, `app_home_opened` → session-list view.
- Real Slack **renderer**: `post_message` → `chat.postMessage`, `update_status` →
  in-place `chat.update` of a per-conversation status message, `post_actions` →
  an interactive actions block, `stream_append` → rate-limit-coalesced
  `chat.update`.
- The **`conversationId ↔ Slack thread` binding** (Decision 1) — the one genuine
  design gap M4 closes.
- **In-process demo wiring** (Decision 2): a single service that constructs the
  `Orchestrator` and the `SlackAdapter` and connects `render`⇄`emit`, keeping the
  existing seam so a later two-service HTTP split is mechanical.

**M3/M4 boundary (honored).** M3 already delivered all control-plane logic and
the pure rendering map. M4 adds **only** the Slack transport that consumes
`RenderCommand`s and produces `ChatEvent`s, plus two read-only lookups needed to
bind a Slack thread to a conversation. No FSM transition, secret resolution, or
routing decision lands in M4.

Out (deferred):

- **In-chat secret entry.** LLM key + push/PR token are seeded out-of-band
  (env/admin) for the demo. Entering secrets from Slack safely (ephemeral modal,
  never a channel message) is a follow-up — it would add an orchestrator write
  path and is not transport work.
- **Modal repo picker.** The repo is chosen from slash-command text
  (`/devspace https://github.com/org/repo`); a `views.open` picker modal is polish.
- **Two-service HTTP split** (gateway ⇄ orchestrator over HTTP). The seam exists
  (the `render` dep and the `emit` callback); splitting is deferred to M6.
- **Discord.** The `DiscordAdapter` stays a skeleton; M4 is Slack only. The pure
  Block Kit builders are Slack-specific; the binding/coalescing helpers are
  platform-neutral and reused when Discord lands (M6).
- gVisor, egress allowlist, turn budgets, audit log, GitHub webhooks (M5).

## Decisions

1. **The gateway owns a bidirectional `ConversationBinding`, keyed by a reversible
   `externalChannelId`.** `RenderCommand`s carry only the internal
   `conversationId`; Slack needs `channel` + `thread_ts`. The join key is
   `externalChannelId = "<channelId>:<threadTs>"` — stable and unique per Slack
   thread (it already backs the `(platform, external_channel_id)` unique index).
   - **Outbound** (`conversationId → {channel, threadTs}`): served from an
     in-memory cache. Render always follows the inbound event that triggered it,
     and that inbound event populates the cache first, so the outbound lookup is
     always warm — no reverse DB read on the render path.
   - **Inbound** (`{channel, threadTs} → conversationId`): a new thread emits
     `conversation.created`, whose return value carries the freshly created
     `conversationId` (M4's single orchestrator surface change — a return value
     exposing already-created state, **not** new control logic). Subsequent
     messages hit the cache; after a restart a cold miss is resolved once via
     `resolveConversationId(platform, externalChannelId)` (a read backed by the
     existing unique index) and then cached.
2. **In-process wiring for the demo, seam preserved.** One service constructs both
   halves and connects them directly: `orchestrator.render = (cmd) =>
slackRenderer.render(cmd)` and `slackAdapter.start((event) =>
orchestrator.handleChatEvent(event))`. This is the DAG the architecture already
   describes (orchestrator holds the render fn; the gateway holds emit); the
   network split adds nothing to the demo and is deferred. The seam is exactly
   these two function boundaries, so the split stays mechanical.
3. **The Slack Web API + Socket-Mode event source are injected behind thin
   interfaces; inbound tests replay recorded payloads.** Every Block Kit payload
   is produced by a **pure** builder (`RenderCommand → Slack blocks`); the
   adapter/renderer are driven in tests by a fake `WebClient` and an injected
   Bolt receiver — no live Slack, mirroring the M2 ACP loopback and the M1
   self-skipping Docker itests. Inbound fixtures are **recorded real Slack
   payloads** (slash command, thread message, button click, `app_home_opened`
   JSON) checked in as golden files and pushed through the injected receiver —
   higher fidelity than hand-written synthetic events, still fully
   deterministic. This is forced by the environment, not just preferred: CI and
   the remote dev container have **no egress to slack.com** (the proxy denies
   CONNECT), so live Slack cannot run there even optionally.
4. **Status is edited in place, streams are coalesced.** Each conversation has one
   lazily-created "status" message; `update_status` `chat.update`s it rather than
   posting a new line per FSM milestone. `stream_append` buffers chunks and flushes
   on a short debounce (≤1 update/sec) to stay under Slack rate limits.

## Contract surface added

M4 adds exactly two **read-only** lookups (no writes, no new control logic):

- `ConversationRepo.getByExternalChannelId(platform, externalChannelId)` in
  `packages/db` (both the in-memory reference impl and the Pg impl) — a point read
  backed by the existing `conversations_platform_channel_uq` index.
- `Orchestrator.handleChatEvent` returns `{ conversationId } | void` — populated
  only for `conversation.created` (the id the handler already created). A thin
  `Orchestrator.resolveConversationId(platform, externalChannelId)` wraps the new
  repo read for post-restart cold-miss resolution.

Both are mirrored across the in-memory and Pg impls so unit tests and the live
path stay behaviorally identical (the M3 discipline).

## Workstreams

The dependency shape is a short diamond: A (binding) and B (Block Kit builders)
are landed-contract-only siblings (parallelizable); C (adapter/renderer) composes
{A, B}; D (orchestrator/db reads) is independent and small; E (wiring + demo)
depends on all.

### A. chat-gateway — `ConversationBinding` + status/stream state

- `packages/chat-gateway/src/binding.ts`:
  - `encodeRef({channel, threadTs}) → externalChannelId` and `decodeRef` — pure,
    total, round-trippable; `threadTs` may contain a `.` but never a `:`.
  - `ConversationBinding`: bidirectional in-memory cache with
    `bind(conversationId, ref)`, `refFor(conversationId)`,
    `conversationFor(ref)`, and a `resolveMiss` hook (Decision 1) invoked on an
    inbound cache miss, then memoized.
- `packages/chat-gateway/src/status.ts`: a per-conversation registry of the status
  message `ts` (for in-place `chat.update`) and a `StreamCoalescer` that buffers
  `stream_append` chunks and flushes on a debounce. Both are pure/injected-clock so
  they test deterministically (no real timers).
- Tests: encode/decode round-trip incl. dotted `threadTs`; bind/lookup both
  directions; cold-miss `resolveMiss` invoked once then cached; coalescer flushes
  the concatenation and respects the min interval (fake clock).

### B. chat-gateway — pure Block Kit builders

- `packages/chat-gateway/src/slack/blocks.ts`: pure `RenderCommand → SlackMessage`
  (blocks + text fallback) for every variant — `post_message` (section),
  `update_status` (a compact context/section status line), `post_actions` (a
  section + an `actions` block whose `action_id`s are the stable ids
  `approve:<reqId>` / `deny:<reqId>` / `create-pr` / `view-pr`, `style` mapped from
  `ActionButton.style`), and the App Home session-list view (`views.publish`
  payload). No I/O.
- Tests: every RenderCommand variant → expected block structure and text
  fallback; button `action_id`/`style` fidelity; long text is chunked to Slack's
  block/text limits.

### C. chat-gateway — real `SlackAdapter` (Bolt + Socket Mode)

- `SlackAdapter.start(emit)` constructs `new App({ token: botToken, appToken,
socketMode: true })` (client + receiver injected in tests) and wires:
  - slash command `/devspace [repoUrl]` **or** a new thread rooted at an app
    mention → `conversation.created` (`externalChannelId = channel:thread_ts`,
    `repoChoice` parsed from the command text; empty text → `{ empty: true }`).
  - `app.message` in a bound thread → `message.posted` (resolve `conversationId`
    via the binding; ignore messages in unbound threads and the bot's own).
  - `app.action(/^(approve|deny):|^(create-pr|view-pr)$/)` → `action.invoked`
    with the raw `action_id` as `actionId` (orchestrator's `classifyAction` owns
    the meaning).
  - `app.event('app_home_opened')` → `views.publish` the session list.
  - The `conversation.created` emit path binds the returned `conversationId` to the
    thread ref (Decision 1).
- `SlackAdapter.render(command)`:
  - `post_message` → `chat.postMessage({ channel, thread_ts, ...blocks })`.
  - `update_status` → lazily create then `chat.update` the status message `ts`.
  - `post_actions` → `chat.postMessage` with the actions block; the `ts` is
    retained so a decided approval can be `chat.update`d to a resolved state.
  - `stream_append` → `StreamCoalescer` → debounced `chat.update`.
  - Unknown/unbound `conversationId` → resolve via the binding's `resolveMiss`,
    else drop with a logged warning (never throw on the render path).
- `openStream(conversationId)` returns a `StreamHandle` backed by the coalescer.
- `stop()` → `app.stop()` and flush pending coalesced updates.
- Tests: recorded Slack payload fixtures (`packages/chat-gateway/fixtures/`)
  replayed through the injected receiver → the expected `ChatEvent` (incl. repo
  parse + empty choice); a `RenderCommand` sequence → the expected fake-client
  calls (status created once then updated; actions posted; stream coalesced);
  unbound-thread and self-message events are ignored.

### D. orchestrator + db — the two read-only additions

- `packages/db`: implement `ConversationRepo.getByExternalChannelId` in the
  in-memory and Pg impls (point read on the unique index). Extend the db unit
  tests and `pg.itest.ts` round-trip.
- `packages/orchestrator`: `handleChatEvent` returns `{ conversationId }` for
  `conversation.created` (thread the created id out of `onConversationCreated`);
  add `resolveConversationId(platform, externalChannelId)` wrapping the repo read.
  No transition/secret/routing change. Update the existing handler tests to assert
  the returned id and the resolver.

### E. apps — in-process demo wiring

- `apps/chat-gateway-svc` (or a thin `apps/demo`) constructs the real
  `Orchestrator` (reusing the M3 `orchestrator-svc` assembly: Pg repos, event bus,
  secret store, git wrapper, reconciler) **and** the `SlackAdapter`, then connects
  render⇄emit in-process (Decision 2). Slack tokens from `SLACK_BOT_TOKEN` /
  `SLACK_APP_TOKEN` (`.env.example`); existing orchestrator env unchanged.
  `/health` retained; migrations still applied on boot before Socket Mode
  connects.
- **Local live setup is one paste:** `infra/slack/manifest.yaml` is a committed
  Slack **app manifest** (scopes, `/devspace` slash command, Socket Mode,
  interactivity, App Home, event subscriptions) with the token-generation steps
  inline. Create-from-manifest in a free workspace → two tokens → run the demo
  service. Socket Mode means an outbound WebSocket only — no public URL/ngrok,
  which is exactly the on-prem constraint.
- Decision needed at implementation time — **reuse vs extract** the
  `orchestrator-svc` boot: prefer extracting the M3 assembly into an exported
  `bootOrchestrator()` so both the standalone orchestrator-svc and the demo wiring
  share one code path (no copy-paste of the Pg/bus/secret wiring).
- Tests: a wiring smoke that feeds a synthetic Slack event through the real
  adapter into an `Orchestrator` backed by in-memory repos + fake
  `SandboxCore`/`AgentRunner` and asserts the round trip produces the expected
  fake-Slack calls — the M4 analogue of the M2 ACP loopback test. Live Slack
  self-skips without `SLACK_*` (like the Docker itests).

## End-to-end demo path (the acceptance walk-through)

```
/devspace https://github.com/org/repo   → conversation.created → PROVISIONING → READY (status edits in place)
"add a healthcheck endpoint"             → message.posted → WORKING → agent stream (messages, tool status, edits)
[Approve] on a tool call                 → action.invoked approve:<id> → agent proceeds
[Create PR]                              → action.invoked create-pr → PRE_PR → PR_OPEN ("Opened PR: …")
(poll reconciler)                        → PR_MERGED → "PR merged. 🎉"
```

Every status line is one edited message; every secret-bearing string is already
redacted by the M3 `render.ts` before it reaches the transport.

## Testing strategy

- **Unit (no Slack/Docker/DB, runs in `pnpm -r test` + CI):** binding codec +
  cache + cold-miss resolution; stream coalescer with a fake clock; every Block
  Kit builder variant; adapter event-in → `ChatEvent` and `RenderCommand` →
  fake-client-call mappings; the orchestrator return-id + resolver additions.
- **Wiring smoke (no network):** synthetic Slack event → real adapter → real
  `Orchestrator` (in-memory repos + fakes) → asserted fake-Slack calls.
- **Postgres integration (`pg.itest.ts`):** extend for
  `getByExternalChannelId`; self-skips without `DATABASE_URL`, must-not-skip in
  CI (M3 discipline).
- **Live Slack (optional itest, local-only):** self-skips without
  `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`; drives a real workspace (created from
  `infra/slack/manifest.yaml`) when configured. **Cannot run in CI or the remote
  dev container** — their egress proxy denies slack.com — so unlike the Docker
  itests there is no must-not-skip CI assertion for this suite; the recorded
  fixtures are the CI-grade coverage.

## Risks / notes

- **Binding correctness is load-bearing** (Decision 1). The reversible
  `externalChannelId` + warm-on-inbound cache means the render path never needs a
  reverse DB read; the only DB read is the post-restart inbound cold miss. Tested
  explicitly, both directions and the cold miss.
- **Slack rate limits.** `chat.update` is ~1/sec/message; the coalescer batches
  `stream_append` and status churn to stay under it. Bursty turns degrade to
  fewer, larger edits — never dropped content.
- **Redaction stays upstream.** M4 adds no new outbound text path — every string
  is produced by M3's `render.ts` (100% redacted) before the transport sees it.
  The Block Kit builders are pure formatters and must not re-introduce raw text
  from any other source.
- **Egress is a deployment prerequisite, not a code concern.** Verified: the
  remote dev container's proxy rejects CONNECT to slack.com (403), so live Slack
  is structurally impossible in CI/remote — hence recorded fixtures as the
  CI-grade inbound coverage. Deploying the gateway inside a restricted network
  requires the M5 egress allowlist to include `slack.com` and
  `wss-primary.slack.com` (Socket Mode's outbound WebSocket); note this in the
  M5 allowlist work.
- **No abort path** (unchanged from M3): a `stop`/cancel button is not M4. Turn
  budgets + in-container termination are M5 (the `ExecStream.kill()` caveat in the
  roadmap still applies).
- **Single orchestrator touch.** The only non-transport change is exposing the
  created `conversationId` and a read-only resolver — enumerated above and covered
  by tests, so the "no control logic in M4" invariant holds.
