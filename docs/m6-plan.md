# M6 — Expansion I: HTTP split, preview proxy, chat-surface completion (implementation plan)

Design of record for M6. Cuts the in-process demo wiring into the real
two-service deployment (gateway ⇄ orchestrator over an authenticated internal
HTTP API — exactly the two seams M4 predicted), lands the ports preview proxy
that M5 deferred onto that split (authenticated ingress through the control
plane), makes the Discord adapter real, closes the M4 chat-surface deferrals
(in-chat secret entry, modal repo picker, App Home session-list data source),
and adds the second ACP agent backend (claude-code-acp) behind the existing
`AgentBackend` seam.

> Prereqs already landed: the M4 seam functions (`render` down,
> `handleChatEvent` up — m4-plan: "exactly where a later HTTP split cuts"),
> the M5 egress posture (per-env `--internal` networks reach the host only at
> their own bridge gateway — which is what makes host-side preview ingress the
> only viable door), the M2 `AgentBackend` interface ("a second agent is a new
> backend, not a rewrite of the runner"), and the M4 Slack adapter's
> injected-transport test discipline.

## Scope

In (per roadmap M6+ and the M4/M5 deferral lists):

- **Two-service HTTP split**: chat-gateway-svc and orchestrator-svc as
  genuinely separate processes; gateway → orchestrator `POST /chat-events`
  (+ the two cold-miss resolver reads and the session-list read), orchestrator
  → gateway `POST /render`; shared-token auth on every internal call. The
  in-process demo wiring stays the zero-config default.
- **Ports preview proxy** (deferred M1 → M5 → here): `forwardPort` finally
  lands. A host-side authenticated reverse proxy routes
  `/t/<token>/…` → the env container's per-env-network IP; `expose-port:<n>`
  action surfaces it in chat.
- **Discord adapter**: real discord.js implementation of the M0 skeleton —
  thread-rooted sessions, message/button ingress, status edit-in-place,
  coalesced streams — behind an injected transport seam (no live Discord in
  tests, same rationale as M4's recorded-Slack-payload approach).
- **Chat-surface completion (M4 deferrals, Slack-primary)**: in-chat secret
  entry via modal (values go straight to the envelope store, never echoed),
  modal repo picker on bare `/devspace`, and the App Home session list backed
  by a real conversations-by-user read.
- **Second ACP agent backend**: `claude-code-acp` as `AgentKind 'claude'` —
  launch/kill commands + backend registry; proves the M2 seam holds
  (top-risk #6: "isolate behind AgentBackend").

Out (deferred to M7, with rationale):

- **Multi-host scheduling.** Single-host is fine for the current shape;
  scheduling is meaningless before there is more than one sandbox host, and
  it drags in placement, capacity and drain concerns that deserve their own
  milestone.
- **NATS bus.** The Pg LISTEN/NOTIFY bus is correct and durable for a
  single-Postgres deployment; NATS only pays for itself alongside multi-host.
  The `EventBus` interface is already the seam a NATS impl would fill.
- **WebSocket upgrade through the preview proxy.** Plain HTTP request/response
  streaming only in M6; WS/SSE upgrade handling is documented as a limitation
  on the proxy.
- **Discord modals / App Home parity.** Secret entry + repo picker are
  Slack-first (the primary surface); Discord gets the core session loop.
  Parity tracked in docs/analysis/chat-platform-ui-parity.md.

## Decisions

1. **The split changes transport, not semantics.** `POST /chat-events` is
   synchronous: it runs `handleChatEvent` to completion and returns the same
   `{ conversationId? }` the in-process seam returns. The M4 in-process demo
   already blocks the emit for the full handler (including provisioning); a
   fire-and-forget wire would silently change ordering and lose the
   created-id return that thread binding depends on. The HTTP client sets no
   request timeout for this call. The old M3 fire-and-forget `POST /events`
   ingest is replaced by `/chat-events` (it had no consumer other than
   curl-by-hand).
2. **Render crosses the wire per command, in order, and still never throws.**
   The orchestrator's `render` dep becomes an HTTP client POSTing each
   `RenderCommand` to the gateway's `POST /render`. Commands were already
   awaited sequentially, so ordering is preserved by construction. The client
   retries transient failures with backoff and then logs-and-drops — the M4
   "render path never throws" discipline moves up one level; a dead gateway
   must not fail a turn.
3. **One shared bearer token guards every internal call, both directions.**
   `DEVSPACE_INTERNAL_TOKEN`, compared timing-safely on both servers. This is
   an _internal_ API between two trusted services on one deployment — mTLS,
   per-service identity and rotation are deployment concerns layered on top
   (documented), not M6 code. Endpoints 401 without it; both svcs refuse to
   boot in split mode without it (an unauthenticated control plane is worse
   than no split).
4. **Split mode is a config flip; the demo stays zero-config.**
   chat-gateway-svc with `ORCHESTRATOR_URL` set runs gateway-only: no
   DATABASE_URL, no in-process orchestrator; binding cold-miss resolvers and
   the App Home list ride the resolver/read endpoints. Unset, the M4
   in-process wiring is unchanged (one code path — the HTTP mode wraps the
   same seam functions the demo wires directly).
5. **Preview ingress terminates at the host, never inside the env.** The M5
   egress posture makes the env unreachable except from its own bridge — so
   the preview proxy is a host process (like the egress proxy) that resolves
   the container's per-env-network IP at `forwardPort` time and reverse-
   proxies `/t/<token>/…` to `<containerIp>:<port>`. Capability-URL auth: a
   32-byte random token per exposed port, high-entropy map lookup, no
   cookies/sessions. The token is shown only in the owner's session thread.
   The proxy stays dumb (M5 discipline): route, stream, no rewriting beyond
   the path prefix strip; anything unroutable → 404 before any upstream
   connection.
6. **`expose-port` is an action, parsed platform-side.** The orchestrator
   handles `action.invoked` with `actionId = "expose-port:<n>"` (state-gated
   READY…PR_OPEN, audited `port.exposed`, renders the URL). Adapters own the
   ergonomics: Slack/Discord map a `!port <n>` thread message to that action —
   the same normalization job they already do for slash commands, and it
   keeps agent prompts (plain messages) unambiguous.
7. **The Discord adapter codes against a thin transport seam.** discord.js
   objects are deep class instances that can't be replayed offline the way
   Bolt payload fixtures can. All adapter logic — thread binding, repo-choice
   parsing, action routing, status registry, stream coalescing (shared with
   Slack via `status.ts`) — codes against a ~10-method `DiscordTransport`
   interface and is fully tested over a fake; the discord.js glue
   (`discordJsTransport`) is a thin, documented-untested mapping layer, the
   same trust boundary M4 drew around Bolt's own WebSocket internals.
8. **Secret entry is a first-class ChatEvent, not a side channel.**
   `secret.submitted { conversationId, userId, name, value }` flows the same
   authed path as every other event (in split mode: once over the internal
   authed HTTP, then envelope-encrypted at rest — the same trust boundary the
   Slack→gateway hop already crosses). The orchestrator stores it, registers
   the plaintext in the conversation's redaction registry _immediately_
   (an echoed secret is redacted from turn one), audits `secret.stored` with
   the name only, and confirms in-thread without the value. Slack renders the
   entry point as a `set-secrets` button (posted with the conversation's
   first status) that opens a modal; the modal's private_metadata carries the
   thread ref so submission needs no channel context.
9. **Bare `/devspace` opens the repo picker modal.** Previously it created an
   empty conversation; now the command's trigger_id opens a modal (repo URL +
   ref), and submission roots the thread + emits `conversation.created` with
   the parsed choice. Dismissal creates nothing (no orphan conversations).
10. **The App Home list is one new read.** `ConversationRepo.listByUser
(platform, userId)` (in-memory + Pg) + an orchestrator `listSessions`
    join against each conversation's work unit → `SessionSummary[]`; exposed
    in split mode as `GET /sessions`. The M4 `listSessions` adapter option is
    finally wired to real data.
11. **The second backend is registry selection, nothing else.**
    `AgentKind` gains `'claude'`; `DefaultAgentRunner` picks from a
    `Record<AgentKind, AgentBackend>` (deps-overridable). `claudeBackend`
    mirrors codex: launch via the runtime volume's node, `ANTHROPIC_API_KEY`
    injected per-exec, model via `ANTHROPIC_MODEL`, `killCommand` uses the
    same pgrep-self-exclusion pkill pattern. The runtime image gains the
    `claude-code-acp` package alongside codex-acp.

## Contract surface added

- `@devspace/contracts`:
  - `ChatEventSchema` += `secret.submitted` variant (Decision 8).
  - `AgentKindSchema` += `'claude'` (Decision 11).
  - `SessionSummarySchema` (+ `ChatEventResultSchema` formalizing the
    existing seam return) — the internal-API wire shapes (Decisions 1, 10).
- `packages/db`: `ConversationRepo.listByUser(platform, userId)` (in-memory +
  Pg; no schema change — it's a filtered read on existing columns).
- `packages/sandbox-core`: `PreviewProxy` (start/stop/register/revoke) +
  `ContainerRuntime.containerIp()`; `DevcontainerSandboxCore.forwardPort`
  goes from rejecting to working when a proxy is configured.
- `packages/orchestrator`: `listSessions(platform, userId)`;
  `expose-port` action handling; `internal-http.ts` (bearer verify, JSON
  body/client helpers shared by both svcs).
- `packages/chat-gateway`: real `DiscordAdapter` + `DiscordTransport` seam;
  Slack modals (secret entry, repo picker) + `set-secrets` action + `!port`
  mapping; `HomeSession` wiring unchanged in shape.

## Workstreams

Shape: A is the spine (B's chat surface and D's reads ride it); B, C, D, E
are independent siblings once A's endpoints exist (B and E don't touch A at
all); F closes docs. Lettered commits, one per workstream, like M4/M5.

### A. The HTTP split

- `packages/orchestrator/src/internal-http.ts`: `verifyBearer(header, token)`
  (timing-safe, length-safe), `readJsonBody(req, limit)`, and
  `postJsonWithRetry(url, token, body, opts)` — pure-ish, tested over
  loopback; shared by both svc entrypoints.
- orchestrator-svc: `POST /chat-events` (authed, zod-parsed, synchronous,
  returns `{ conversationId? }`; replaces `/events`), `GET
/conversations/resolve?platform&externalChannelId`, `GET /conversations/:id`
  (→ `{ externalChannelId }`), `GET /sessions?platform&userId` (D's read).
  Render transport: when `GATEWAY_RENDER_URL` is set, render POSTs each
  command there (Decision 2); logs otherwise (unchanged default).
- chat-gateway-svc: split mode when `ORCHESTRATOR_URL` is set — no Pool, no
  bootOrchestrator; `emit` = POST /chat-events client; binding resolvers +
  listSessions = the GET endpoints; its HTTP server gains authed
  `POST /render` → `adapter.render`. Demo mode byte-for-byte unchanged.
- Tests: bearer verify table; a real loopback split — orchestrator-svc's
  handler stack (with in-memory-ish fakes via `start()` against a test
  double? no: handlers extracted so they're constructible with a fake
  orchestrator) and gateway render endpoint driven by real `http` requests;
  retry/backoff behavior of the render client (fail, fail, succeed; and
  gives-up-logs-drops); 401 paths both directions.

### B. Ports preview proxy

- `packages/sandbox-core/src/preview-proxy.ts`: `PreviewProxy` — Node http
  server; `register(envId, target: {host, port}) → { token, path }`,
  `revokeEnv(envId)`; request path `/t/<token>/<rest>` → strip prefix, proxy
  method/headers/body to target, stream response back; unknown token → 404
  (no upstream dial); `publicBaseUrl` composes the returned `proxyUrl`.
- `DockerRuntime.containerIp(containerId, networkName?)`: `docker inspect`
  format parse (pure parser, injected runner) — the per-env network's IP when
  hardening uses one, else the default bridge IP.
- `DevcontainerSandboxCore.forwardPort`: requireReady → containerIp →
  `preview.register` → append `PortMapping` to `env.ports` → return
  `{ proxyUrl, token }`; `destroyEnvironment` revokes the env's routes.
  Without a configured proxy it keeps rejecting, now with "preview proxy not
  configured".
- Orchestrator `expose-port:<n>` (classifyAction gains it): state-gated
  (READY ≤ state ≤ PR_OPEN), `sandbox.forwardPort(wu.envId, n)`, audit
  `port.exposed { port }`, message with the URL. Slack + Discord map
  `!port <n>` thread messages to the action (Decision 6).
- sandbox-core-svc: starts the proxy when `PREVIEW_PROXY_PORT` is set
  (`PREVIEW_BASE_URL` for the public URL), wires it into the core.
- Tests: loopback round-trip (register → GET through the proxy to a local
  upstream, body + status + path-strip asserted); 404 on bad/revoked token
  (upstream never dialed — fake target asserts); inspect-IP parser table;
  forwardPort happy/no-proxy/not-ready paths (fake runtime); expose-port
  handler (fake sandbox) incl. state gates + audit row; live itest: exec a
  tiny in-container HTTP server, forwardPort, real GET through the proxy.

### C. Discord adapter

- `DiscordTransport` seam: `start(handlers)`, `stop()`, `postMessage(channelId,
body)`, `createThread(channelId, messageId, name)`, `postInThread(threadId,
body)`, `editMessage(channelId, messageId, body)` — handlers for
  slash-command, thread message, button press, mention.
- `DiscordAdapter` (mirrors SlackAdapter): `/devspace repo [ref]` → root
  message + thread + `conversation.created` (externalChannelId =
  `<channelId>:<threadId>` via the shared binding codec); thread messages →
  `message.posted` (`!port` → action per Decision 6); buttons (customId =
  actionId, same stable ids) → `action.invoked`; renders: post_message,
  update_status (edit-in-place via StatusRegistry), post_actions (button
  rows), stream_append (StreamCoalescer, Discord edit budget ~1/sec, 2000-char
  chunking at newline boundaries like blocks.ts does for Slack).
- `discordJsTransport(config)`: the thin discord.js glue (Client + gateway
  intents + interaction/message listeners + REST slash-command registration),
  documented as the untested boundary (Decision 7).
- Tests: full fake-transport suite — session create (slash + mention), no
  double-emit, message routing only in bound threads, button → action, status
  edit-in-place, stream coalescing with fake clock, render-never-throws,
  `!port` mapping.

### D. Chat-surface completion

- contracts: `secret.submitted` ChatEvent; `SessionSummarySchema`.
- db: `ConversationRepo.listByUser` (in-memory + Pg + pg.itest extension).
- orchestrator: `onSecretSubmitted` — ownership assert, allowed-name check
  (LLM_KEY | GITHUB_TOKEN | GITHUB_CLONE_TOKEN), `secrets.store`, register
  plaintext in the conversation registry, audit `secret.stored { name }`,
  confirm in-thread (never the value; a "no plaintext in render/audit" test
  extends M5's discipline). `listSessions(platform, userId)` join read.
  `statusCommand` flow on conversation creation now posts the `set-secrets`
  actions row.
- chat-gateway (Slack): `set-secrets` button → `views.open` modal (three
  optional inputs; private_metadata = encoded thread ref); `view_submission`
  → one `secret.submitted` per filled field + ephemeral-style confirmation;
  bare `/devspace` → repo-picker modal (Decision 9), submission roots the
  thread exactly like the arg path; App Home wired to `listSessions`.
- Tests: orchestrator secret flow (stored, registered → an agent echoing the
  value renders redacted, audit has name only), listSessions shape; Slack
  fixture replays for both modals (open + submit), bare-command-opens-picker,
  home view uses the injected source.

### E. Second ACP agent backend

- `claudeBackend` (`backends/claude.ts`): launch
  `<runtime>/bin/node <runtime>/claude-code-acp` with `ANTHROPIC_API_KEY` /
  `ANTHROPIC_MODEL`; `killCommand` with the `[/]` pgrep-self-exclusion
  pattern; `mapEvent` → shared `mapSessionUpdate` (standard ACP).
- contracts: `AgentKindSchema` += `'claude'`.
- runner: `BACKENDS: Record<AgentKind, AgentBackend>`; `createSession`
  selects by `req.agentKind` (deps override still wins — tests + future
  agents).
- infra: agent-runtime image installs `@zed-industries/claude-code-acp`;
  publish.sh unchanged (volume copy already ships whatever the image has).
- Tests: launch/kill argv + env purity (incl. no-model, no-key cases); runner
  selects the right backend per kind (fake exec asserts argv); the loopback
  roundtrip already proves the runner is backend-agnostic — add a
  claude-kind session over the same loopback agent.

### F. Docs closeout

- roadmap: M6 section landed (this list), M7 seeded (multi-host scheduling,
  NATS bus, preview-proxy WS upgrade, Discord UI parity).
- README status paragraph; architecture.md split-mode diagram note;
  `.env.example`: `DEVSPACE_INTERNAL_TOKEN`, `ORCHESTRATOR_URL`,
  `GATEWAY_RENDER_URL`, `PREVIEW_PROXY_PORT`, `PREVIEW_BASE_URL`,
  `ANTHROPIC_API_KEY` note under the LLM section; compose.yaml gains the
  split-mode env plumbing (token + URLs) so `docker compose up` runs the
  real two-service shape.
- chat-platform-ui-parity.md: Discord column updated (core loop ✓, modals ✗).

## Testing strategy

- **Unit (no Docker/DB/network, `pnpm -r test` + CI):** bearer verify,
  inspect-IP parse, action classification, modal builders, Discord adapter
  over the fake transport, backend argv/env, runner registry, orchestrator
  secret/expose-port/listSessions handlers over in-memory repos + fakes.
- **Loopback integration (in `test`, CI-safe):** the split itself — real
  `http` servers for /chat-events, /render, resolver reads, auth failures,
  render-client retry; the preview proxy round-trip against a local upstream.
  Same pattern the M5 egress proxy proved out.
- **Live-Docker itest:** preview proxy against a real container (in-container
  HTTP server → forwardPort → GET through the proxy).
- **Postgres itest:** `listByUser` round-trip; unchanged must-not-skip
  discipline.
- **Not tested live:** discord.js against Discord (CI egress; the transport
  seam is the boundary — Decision 7), claude-code-acp the binary (same
  status as codex-acp: pinned in the image, driven over loopback ACP).

## Risks / notes

- **Long-lived /chat-events requests** (provisioning can take minutes): the
  client sets no timeout and the server does no async ack (Decision 1). If a
  gateway restarts mid-provision the orchestrator still completes and renders
  through the resolver-backed binding — same recovery M4 built for the
  in-process window.
- **The internal token is deliberately simple.** One shared secret, both
  directions, boot-refused when absent in split mode. Rotation = deploy-time
  restart with the new value; mTLS/service identity is a deployment layer,
  not app code.
- **Preview URLs are capability URLs.** Anyone with the token reaches the
  port. That is the documented model (shown only in the owner's thread);
  revocation = env teardown (`revokeEnv`) and no route survives the env.
  The proxy never follows redirects or rewrites bodies — dumb-boundary
  discipline from M5.
- **Discord rate limits** are coarser than Slack's; the coalescer interval is
  per-adapter config (default 1s, same as Slack) and the transport surfaces
  429s to the warn path — render never throws.
- **claude-code-acp version drift** is the same top-risk #6 as codex-acp:
  pinned in the runtime image, isolated behind the backend seam.
- **`/events` removal** is an internal break with no known consumer; noted in
  the roadmap entry rather than kept as a deprecated alias.
