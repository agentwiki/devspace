# Roadmap

Critical path to the end-to-end demo: **M0 → M1 → M2 → M3 → M4.**
Release-blocking hardening for real multi-tenant use: **M5.**
Expansion I (split, preview proxy, chat completion, 2nd agent): **M6.**
Expansion II (preview WS upgrade, Discord UI parity): **M7.**
Expansion III (exec over the wire, multi-host placement): **M8.**
Expansion IV (fleet capacity truth, warm pools): **M9.**
Expansion V (pool identity, claim-time refresh): **M10.**
Expansion VI (durable host env tables): **M11.**
Expansion VII (resource-aware placement): **M12.**
Expansion VIII (per-service identity on the internal API): **M13.**
Expansion IX (multi-controller coordination): **M14.**
Expansion X (singleton reconciler election): **M15.**
Expansion XI (live utilization truth + usage-aware ranking): **M16.**

## M0 — Scaffolding (done)

Monorepo, 6 packages + 4 apps, zod contracts, Drizzle schema, compose, base +
agent-runtime image skeletons, stub services with `/health`, design docs. No real
logic. **Done when** `pnpm -r build`, `pnpm -r test`, and the 4 health checks pass.

## M1 — sandbox-core vertical (done)

`devcontainers/cli` integration: provision from repoUrl, **bidi streaming exec
with real backpressure/flow-control**, fs ops, teardown, resource limits.
Out: ports proxy polish, gVisor.

Landed:

- **Full-duplex exec with real two-way backpressure** (`process-stream.ts`) — the
  risk-#1 primitive. stdout/stderr pause the child via watermarks (kernel pipe
  backpressure, no unbounded buffering); stdin honors `write()`/`drain()`. It is
  transport-agnostic, so it is unit-tested against live child processes — the
  backpressure test proves a paused consumer actually blocks a >2MB producer.
- **DockerRuntime** (exec/destroy/liveness) with pure, tested `docker` argv builders.
- **DevcontainerProvisioner**: shallow clone → synthesized `devcontainer.json`
  (repo config + override + resource `runArgs` + generic mounts) → `devcontainer up`
  → containerId. Config-merge/arg/parse logic is pure and unit-tested.
- **DevcontainerSandboxCore**: env registry + lifecycle, per-exec secret-env
  injection, file secrets written post-ready (never on the workspace disk), and
  fs read/write/list built on the exec primitive (binary-safe).
- **sandbox-core-svc**: JSON control surface (env lifecycle, fs, capture-exec).
- **Live-Docker integration tests** (`sandbox.itest.ts`): the real
  DevcontainerSandboxCore drives `devcontainer up` → exec → binary fs → fsList →
  secret injection → resource-limit inspection → teardown against a Docker daemon.
  They self-skip without docker/devcontainer and run in CI (a dedicated job with a
  live daemon; the MCR ubuntu base image is public and unauthenticated).

Deferred: disk-quota enforcement (`--storage-opt size=`) to M5 (driver-dependent);
gVisor/ports proxy per the milestone's out-of-scope list.

## M2 — agent-runner + agent-in-container (done)

Build the agent-runtime volume; mount it; launch codex-acp via exec; wrap stdio in
ACP `ndJsonStream`/`ClientSideConnection`; run one turn; normalize events.
Out: full guardrails, approvals.

Landed:

- **Full ACP client wiring** (`acp/connection.ts`) — the exec stream is adapted to
  ACP's byte-stream pair (`acp/stream-adapter.ts`, stdout→protocol, stderr→logs,
  backpressure preserved), wrapped in `ndJsonStream`, and driven through a real
  `ClientSideConnection`. `connectAgent` does the `initialize` + `newSession`
  handshake and returns a session whose `runTurn` streams events until `turn_end`.
- **ACP→AgentEvent normalization** (`acp/events.ts`) — pure, total mapping of
  `session/update` (message/thought chunks, tool calls, diffs, tool results) onto
  the normalized `AgentEvent` union; unknown updates map to null, never throw.
- **Approval gate** (`acp/client.ts`) — `requestPermission` surfaces a
  `permission_request` event and PARKS the agent's JSON-RPC call until a human
  `decide()` arrives, so nothing sensitive runs without an explicit allow.
- **DefaultAgentRunner** (`runner.ts`) — composes an `ExecProvider` (sandbox-core,
  exec only), a backend, and `connectAgent`; per-exec model + resolved LLM key
  injection via the backend's `launchCommand`; `agentRuntimeMount()` for the
  orchestrator to attach the runtime volume (ADR-0003).
- **End-to-end ACP round-trip test** (`acp/roundtrip.test.ts`) — a REAL SDK
  `AgentSideConnection` plays codex-acp over an in-memory loopback
  (`acp/loopback.ts`); the full handshake, a prompt turn, event normalization, and
  the permission gate run with no Docker and no child process.
- **agent-runtime volume publish** (`infra/images/agent-runtime/publish.sh`) —
  builds the image and copies `/opt/agent-runtime` into a named Docker volume.

Deferred: full guardrail enforcement on tool calls + auto-deny (M3, wired to the
FSM/secret store); the agent-runner-svc HTTP control surface (M3/M4).

## M3 — orchestrator + FSM + secrets (done)

Work-unit FSM wired to Postgres; event bus (LISTEN/NOTIFY); per-user PAT/LLM-key
store + injection; deterministic git/PR wrapper. Out: webhooks (poll instead).
See docs/m3-plan.md for the design of record and what landed.

## M4 — chat-gateway (Slack) end-to-end (done)

Slack adapter: create conversation, pick repo, live status message, message→turn,
stream output, create-PR/view-PR + approval buttons. **= the demo.**
Design of record: docs/m4-plan.md.

Landed:

- **conversationId ↔ Slack-thread binding** (`binding.ts`) — reversible
  `externalChannelId = "<channel>:<threadTs>"` + a bidirectional warm-on-inbound
  cache; the render path never does a reverse DB read, and DB-backed resolvers
  cover the post-restart cold miss in both directions.
- **Pure Block Kit builders** (`slack/blocks.ts`) — every `RenderCommand`
  variant, stable action_ids untouched, long text chunked at newline boundaries,
  App Home session-list view.
- **Real `SlackAdapter`** (Bolt + Socket Mode) — /devspace roots a session
  thread; mentions create/continue conversations (no double emit); thread
  replies → `message.posted`; buttons → raw action_ids; one status message
  edited in place; streams coalesced (≤1 chat.update/sec, full-text edits,
  drained on stop); the render path never throws. Tested by replaying recorded
  Slack payload fixtures through a REAL Bolt App (injected receiver + offline
  authorize) against a fake WebClient — no live Slack (CI egress blocks it).
- **The two read-only lookups** — `ConversationRepo.getByExternalChannelId` and
  `handleChatEvent` returning `{ conversationId }` (+ `resolveConversationId`);
  the only non-transport surface M4 added.
- **In-process demo wiring** — the M3 assembly extracted into
  `bootOrchestrator()` (one code path for orchestrator-svc and the demo);
  chat-gateway-svc connects render⇄emit at exactly the two seam functions a
  later HTTP split (M6) cuts. The wiring smoke drives the whole demo path
  (/devspace → READY → turn → approve → create-pr → merged) over in-memory
  repos + fakes — and caught a real M3 gap: the LLM key resolved by the agent
  runner bypassed the redaction registry; the handler now registers it every
  turn.
- **Local live setup**: paste `infra/slack/manifest.yaml` into a free
  workspace, set `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`, run chat-gateway-svc
  (Socket Mode — outbound WebSocket only, no public URL).

Deferred: in-chat secret entry (seeded out-of-band for the demo), modal repo
picker, App Home session-list data source (a conversations-by-user read), the
two-service HTTP split (M6).

## M5 — Hardening (release-blocking for real multi-tenant use) (done)

gVisor/Kata, egress allowlist, output redaction, turn budgets, audit log,
GitHub webhooks. Design of record: docs/m5-plan.md. Zero changes to
`@devspace/contracts` — everything is host policy, an agent-runner internal,
or a db repo.

Landed:

- **Hardened container profile** (`hardening.ts`) — host policy on the
  provisioner, never on `CreateEnvironmentRequest` (a tenant request cannot
  weaken its own sandbox): `--runtime=runsc`/Kata (asserted available at BOOT,
  fail-fast), `no-new-privileges`, cap-drop ALL + minimal add-back, per-env
  `--internal` network (created before `up`, removed on teardown; denies
  env↔env), and the M1-deferred opt-in disk quota (`--storage-opt`,
  driver-gated). Config via `SANDBOX_*` env through every boot path; plain-
  Docker demo mode stays the default. Live itest asserts the flags + network
  via `docker inspect`.
- **Egress allowlist proxy** (`egress-proxy.ts`) — deny-by-default: an
  `--internal` network has no route out; the only door is a ~150-line Node
  CONNECT/absolute-form proxy (zero deps) allowlisting exact hosts and
  `*.suffix`. Per-env networks reach the host only at their OWN bridge
  gateway, so the provisioner resolves the created network's gateway and
  injects `HTTP(S)_PROXY` containerEnv (policy merges OVER repo config).
  Tested over real loopback sockets in CI.
- **Turn budgets + real auto-abort** (`budget.ts`) — `guardTurn` wraps every
  `runTurn`: tool-call count + wall clock (fake-clock checks per event AND a
  real timer race, so a silent hung agent still aborts). Breach ⇒ cancel
  parked permissions + ACP `session/cancel` + **in-container `pkill`** via the
  backend's `killCommand()` over the ordinary exec provider (the caveat below,
  honored and itested), then a clean `turn_end { aborted }` tail.
- **Guardrail auto-deny at the permission gate** — `checkCommand`/
  `checkFileWrite` consulted BEFORE parking; policy-denied ops are rejected
  immediately with an explanatory message and never render approval buttons.
- **Append-only audit log** — `audit_log` table + `AuditRepo` (in-memory ↔ Pg,
  itested); the orchestrator audits every privileged effect (secret.resolved
  with name+purpose only, approval.decided, pr.pushed/pr.opened,
  token.revoked/teardown, turn.aborted, webhook.received/rejected). A
  regression test proves no audit detail ever contains secret plaintext.
- **GitHub webhooks as PR source of truth** — signature-verified
  (`X-Hub-Signature-256`, constant-time over the raw body) `pull_request`
  ingress mapped onto the SAME idempotent bus topics as the reconciler, so
  webhook↔poll double-delivery no-ops by construction; the poll survives as
  the drift backstop on a long interval (top-risk #7).
- **Pattern-based redaction** — well-known token shapes (`ghp_…`,
  `github_pat_…`, `gh[ousr]_…`, `sk-…`, `xox…`) scrubbed from 100% of outbound
  text even when never registered; registered values still redact first (and
  whole).

Deferred: **ports preview proxy → M6.** It is a product feature (authenticated
preview URLs), not release-blocking hardening — and under the M5 egress
posture ingress must route through the control plane, which is exactly the M6
HTTP-split work. Also out, as documented in docs/m5-plan.md: custom
seccomp/AppArmor profiles (gVisor is the boundary; Docker defaults stay on)
and rootless dockerd/userns-remap (daemon-level deployment concerns).

> Auto-abort caveat (honored by M5-C): turn-budget/runaway kill must NOT rely
> on `ExecStream.kill()` alone. Over the docker-exec transport that signals
> only the local `docker exec` client; Docker does not propagate it into the
> container, so the agent's in-container process tree survives. Hard-stopping
> an agent needs in-container termination (`docker exec <ctr> kill`) or
> `destroy()` (`docker rm --force`).

## M6 — Expansion I (done)

The two-service HTTP split, the ports preview proxy it unlocks, the real
Discord adapter, the M4 chat-surface deferrals, and the second ACP agent
backend. Design of record: docs/m6-plan.md.

Landed:

- **Two-service HTTP split** (`internal-http.ts`) — the cut at exactly the
  seams M4 predicted: gateway → orchestrator authed synchronous
  `POST /chat-events` (same `ChatEventResult` as the in-process seam),
  orchestrator → gateway `POST /render` (retry then log-and-drop — the
  "render path never throws" discipline moves up one level), plus the
  binding cold-miss reads and `GET /sessions`. One shared bearer token
  (`DEVSPACE_INTERNAL_TOKEN`), timing-safe, both directions; split mode is a
  config flip (`ORCHESTRATOR_URL` / `GATEWAY_RENDER_URL`) and the M4
  in-process demo stays the zero-config default. The M3 fire-and-forget
  `POST /events` ingest was replaced by `/chat-events` (no known consumer).
  The whole split is tested over real loopback HTTP servers driven by the
  real clients.
- **Ports preview proxy** (M1→M5→M6 deferral lands) — `forwardPort` works:
  a host-side reverse proxy routes `/t/<token>/…` to the container's
  per-env-network IP (the only address the M5 egress posture leaves
  reachable), 32-byte capability tokens shown only in the owner's thread,
  routes revoked with their env, 404-before-upstream-dial on unknown tokens,
  dumb-boundary discipline throughout. `expose-port:<n>` action, `!port <n>`
  chat ergonomics in both adapters, audited `port.exposed`. Live itest
  serves a real in-container HTTP server through the proxy. (WebSocket
  upgrade deferred → M7.)
- **Discord adapter, real** — mirrors the Slack model (session = thread,
  same stable action ids, status edit-in-place, coalesced stream edits with
  a 2000-char tail window) behind a ~5-method `DiscordTransport` seam; all
  adapter logic tested over a fake, discord.js glue is the thin
  documented-untested boundary (the Bolt-internals line, redrawn).
  chat-gateway-svc runs one platform per process (`CHAT_PLATFORM`).
- **Chat-surface completion (M4 deferrals)** — `secret.submitted` ChatEvent
  (contract-enforced name whitelist): values go straight to the envelope
  store, are registered for redaction BEFORE storage (an echoed secret is
  redacted from turn one — regression-tested), audited by name only. Slack:
  `set-secrets` modal (pure platform UI; thread ref rides private_metadata),
  bare-`/devspace` repo-picker modal (dismissal creates nothing), App Home
  backed by the real `listSessions` read (`ConversationRepo.listByUser`).
  Discord modal parity deferred (chat-platform-ui-parity.md).
- **Second ACP agent backend** — `claude-code-acp` as `AgentKind 'claude'`:
  launch/kill argv + `ANTHROPIC_*` env is the ENTIRE diff (top-risk #6 held:
  the runner, handshake, event mapping, and permission gate are untouched;
  proven by running the claude kind over the same loopback ACP agent). The
  agent-runtime volume ships both adapters.

## M7 — Expansion II (done)

The two M6 deferrals that were ready to land: the preview-proxy WebSocket
upgrade and Discord UI parity. Design of record: docs/m7-plan.md — including
why the rest of the old M7+ list (multi-host, NATS, mTLS) moved to M8+, per
this roadmap's own caveats.

Landed:

- **Preview-proxy WebSocket upgrade** (M6 deferral) — `Upgrade:` requests
  through `/t/<token>/…` replay the handshake against the container and
  splice the sockets byte-for-byte on the upstream's 101 (no frame parsing,
  no subprotocol negotiation — the proxy stays the dumb boundary it was;
  live dev servers with HMR now work through preview URLs). Unknown tokens
  still 404 before any upstream dial; rejected handshakes are forwarded
  verbatim. Upgraded sockets are tracked per env: `revokeEnv` severs LIVE
  connections too — a preview URL cannot outlive its env even mid-session.
  Loopback suite (real upstream, raw-socket client) covers round trip,
  rejection, revoke-severs-live-socket, and plain-HTTP-unchanged.
- **Discord modal parity** (the M4→M6 deferral closes) — `set-secrets` opens
  a real Discord modal (same three optional fields; one `secret.submitted`
  per filled field; contract whitelist and register-before-store redaction
  shared, so semantics are byte-for-byte Slack's) and bare `/devspace` opens
  the repo-picker modal (dismissal creates nothing). Discord has no
  trigger_id/private_metadata: events carry an opaque `interactionId`, the
  transport gains `openModal`, and the modal `custom_id` carries the thread
  ref (100-char bound asserted in the builder). The glue acks by exclusion
  (`MODAL_BUTTON_IDS` stay un-acked for `showModal`; everything else defers
  first, as in M6). Pure builders/parsers + fake-transport flows tested.
- **Discord session list** — `/sessions` answers with one ephemeral message
  built from the SAME `listSessions` read that feeds Slack's App Home (no
  Home tab on Discord; on-demand ephemeral is the platform-native
  equivalent). 2000-char cap enforced with an explicit "…and N more"
  remainder — never silent truncation. Gateway UI only: no new contract.

## M8 — Expansion III: multi-host foundations (done)

The milestone the roadmap reserved for top-risk #1: the in-process exec
stream goes over the network, and multi-host placement/capacity/drain lands
on top — all behind the existing `SandboxCore`/`ExecProvider` seams, so the
orchestrator FSM, agent-runner, and both chat adapters are untouched.
Design of record: docs/m8-plan.md.

Landed:

- **The exec wire** — a `devspace-exec` HTTP Upgrade on sandbox-core-svc
  carries the full-duplex stream as ndjson `ExecFrame`s (base64-armored for
  exactly this since M0) over a raw upgraded TCP socket: zero new deps, no
  WebSocket/gRPC ceremony. **Backpressure survives end to end** — the server
  honors `socket.write()`'s verdict, the client's `FrameChannel` (the M1
  watermark channel, now exported) pauses the socket, and TCP's window
  replaces the OS pipe as the kernel-enforced middle. Proven over loopback:
  a parked consumer halts the remote producer, measured at the source.
- **Remote sandbox surface, authed** — the svc's routing moved into the
  package (`remote-server.ts`, loopback-tested); with
  `DEVSPACE_INTERNAL_TOKEN` set everything but `/health` requires the
  bearer; tokenless keeps the JSON surface as the local ops tool it always
  was but the exec stream refuses to serve, ever (secrets ride it). All
  pre-flight checks (401/404/409) answer BEFORE the 101; the `ExecRequest`
  is the first post-upgrade line, never a header (it can carry the LLM key).
- **`RemoteSandboxCore`** — the complete `SandboxCore` interface against a
  remote host (lifecycle/fs/ports over JSON, exec over the upgrade, error
  envelopes mapped back onto `SandboxError`); a lost connection synthesizes
  `stderr` + `exit -1`, the M1 spawn-error convention, so consumers never
  hang. `kill()` crosses the wire (the docker-exec caveat applies remotely,
  unchanged — aborts still use `killCommand()`).
- **Multi-host placement** — `MultiHostSandboxCore`: capacity-bounded
  least-loaded placement (ties in config order; draining/full hosts skipped
  with distinct fail-fast messages), sticky env→host routing with cold-miss
  rediscovery (an orchestrator restart re-learns its fleet by probing
  `GET /environments/:id` — never orphans live envs), runtime
  `setDraining`. Fleet mode is a config flip:
  `SANDBOX_HOSTS=name=url[|capacity][|drain],…` + the token switches
  `bootOrchestrator` to remote clients and leaves hardening/egress/preview
  where the daemons live; unset, the zero-config in-process boot is
  byte-for-byte unchanged.

## M9 — Expansion IV: fleet capacity truth + warm pools (done)

The two M8+ seeds that were ready once placement existed to hang them on:
the capacity gaps m8-plan documented as risks, and warm pools (top-risk #4).
Everything hides behind the `SandboxCore` seam — the orchestrator FSM,
agent-runner, and both chat adapters are untouched. Design of record:
docs/m9-plan.md.

Landed:

- **Capacity truth** — the env table becomes readable
  (`SandboxCore.listEnvironments()`, `GET /environments`);
  `SANDBOX_MAX_ENVS` gives each sandbox host a live-env cap of its own (the
  backstop the M8 client-side count explicitly lacked); and
  `MultiHostSandboxCore.adoptFleet()` runs a boot-time census — an
  orchestrator restart re-learns live envs BEFORE the first placement
  instead of zeroing counted load until lazy re-adoption (the m8-plan risk,
  closed at both ends). A down host warns and is covered by cold-miss
  rediscovery; it never blocks boot.
- **Late-bound secrets** — `applySecrets(envId, secrets)` attaches a
  tenant's secrets to a LIVE env, preserving the M1 discipline (env-target
  values merge into per-exec injection, file-target land 0600, paths
  validated before anything applies). Contract shape
  (`ApplySecretsRequest`); the remote route is token-gated like exec —
  secret plaintext never rides the open tokenless surface.
- **Warm pools** — `WarmPoolSandboxCore` wraps ANY inner core (local,
  remote, or fleet — composition, not a mode). Pools pre-provision in the
  background (single-flight per pool, failures log and retry on the next
  claim); a `createEnvironment` that exactly matches a pool template
  (canonical key, secrets stripped) claims a warm env: verify →
  applySecrets → hand out, anything less destroys rather than handing out
  (or re-pooling) a half-secreted env. Misses always fall through cold, so
  template drift can only ever mean a cold create — never a wrong-shaped
  env. `SANDBOX_WARM_POOLS=repoUrl[#ref]=size,…`; `close()` destroys
  still-unclaimed warm envs.

## M10 — Expansion V: pool identity + claim-time refresh (done)

The two m9-plan seeds that compose at exactly one point — the claim. A warm
env is now marked pool-owned where it lives, and the clone a tenant receives
is freshened at hand-out. Everything stays behind the `SandboxCore` seam;
one contract field (`poolKey`) and one interface method (`claimEnvironment`)
are the entire surface change. Design of record: docs/m10-plan.md.

Landed:

- **Pool identity** — every warm fill is stamped with its pool's canonical
  template key: `poolKey` rides `CreateEnvironmentRequest` onto the HOST's
  env table and is echoed on `Environment`, so the host — not orchestrator
  memory — records what is unclaimed warm stock. The mark is bookkeeping,
  not shape: `canonicalRequestKey` strips it alongside secrets, and a
  template arriving pre-marked is refused at construction.
- **Claim as a host operation** — `SandboxCore.claimEnvironment(envId)`
  (new `POST /environments/:id/claim`; open surface — no secret plaintext
  crosses) hands a marked env to a tenant in one atomic step: freshen the
  workspace clone (`git fetch --depth 1 origin <ref|HEAD>` + hard reset,
  the same host-side git and credentials the fill-time clone used), then
  clear the mark. The mark is the capability — an unmarked env refuses
  with CONFLICT, so a buggy pool can never hard-reset a tenant workspace;
  a refresh failure leaves the env intact and the claimer destroys it and
  falls through cold (latency, never staleness).
- **Orphan re-adoption** — `fill()` sweeps `listEnvironments()` before
  topping up: ready envs carrying one of OUR pool keys are re-adopted FIFO
  up to size (a crashed control plane's warm stock is reclaimed — the
  m9-plan leak, closed), excess beyond a shrunk size is destroyed, and
  foreign marks / unmarked tenant envs are never touched. Tolerant like
  the census: a listing failure logs and the top-up still runs.

## M11 — Expansion VI: durable host env tables (done)

The host-persistence seed every milestone since M8 pointed at: a sandbox
host's env table — pool marks included — survives a sandbox-core-svc
restart. Zero contract changes; everything is a sandbox-core internal plus
boot wiring. Design of record: docs/m11-plan.md.

Landed:

- **The durable table** — `SANDBOX_STATE_DIR` opts a host into one atomic
  JSON state file per env, metadata only: the M1/M5 line holds — secret
  values and preview capability tokens never land on host disk (recovered
  envs come back with an empty per-exec secret map; `applySecrets` is the
  re-attach seam). Written at provisioning/ready/claim-unmark, removed at
  destroy; a claim persists its unmark BEFORE applying it, so a forgotten
  unmark can never resurrect a pool mark over a tenant workspace (the M10
  Decision-3 hazard, closed at the persistence layer too). Unset, the
  documented in-memory posture is byte-for-byte unchanged. Docker labels
  were rejected as the store: immutable after create, and the mark must
  clear at claim.
- **Recovery trusts the daemon** — boot-time `recover()` re-adopts only
  `ready` records whose container the daemon still confirms; anything else
  is a crashed transition and is COMPLETED (container + per-env network
  destroyed, file dropped) rather than re-homed — the mid-provision leak
  closes. Corrupt state files log and skip; torn `.tmp` writes are swept;
  neither ever fails boot.
- **The restart story composes for free** — recovery runs before the
  listener at both boots (sandbox-core-svc, in-process orchestrator), and
  the M9 fleet census and M10 orphan sweep only ever read
  `listEnvironments()`, so they now survive a HOST restart, not just an
  orchestrator restart: recovered warm stock is re-adopted by `fill()`
  instead of re-provisioned, containers that died with the host are
  discarded and replaced, and unmarked tenant envs are never touched.

## M12 — Expansion VII: resource-aware placement (done)

The placement seed carried since M8 lands: hosts get resource accounting,
and fleet placement weighs it. Everything stays behind the `SandboxCore`
seam; one optional contract field and two host-config knobs are the entire
surface change. Design of record: docs/m12-plan.md.

Landed:

- **Resource truth** — every `Environment` echoes the `ResourceLimits` its
  host applied at provisioning (the request's grant, schema defaults
  included — exactly what `--cpus`/`--memory` enforce). The echo is
  additive on the contract (answers from pre-M12 hosts still parse; an
  echo-less env weighs the contract defaults, which is what its
  provisioner actually applied), survives claim, and joins the M11
  persisted slice so a recovered env keeps its true weight.
- **Weighted placement** — `SANDBOX_HOSTS` entries take optional
  `cpu=<cores>` / `mem=<MB>` budgets. Admission fit-checks each dimension
  (an env-count slot — the M8/M9 backstop, unchanged — plus room for the
  request's grant in every declared budget); ranking is least
  max-fractional utilization over declared dimensions, ties in config
  order; the refusals distinguish full / unfit / draining. Scheduling is
  on GRANTS, deliberately: stable, known at placement time, and the budget
  itself is the oversubscription dial.
- **Reservations weigh their footprint** — the M8 in-flight pending count
  carries {count, cpu, memMB}, so a concurrent burst can no more
  oversubscribe a budget than overshoot a capacity; the route table owns
  each env's weight, so census/probe adoption counts it and destroy/evict
  free it exactly when they free the slot.

## M13 — Expansion VIII: per-service identity on the internal API (done)

The deployment-identity seed carried since M8 lands: mutual TLS replaces the
shared `DEVSPACE_INTERNAL_TOKEN` on every internal hop — one secret proving
"I am inside the deployment" becomes a per-service certificate proving WHO is
calling. Zero new dependencies, zero contract changes. Design of record:
docs/m13-plan.md.

Landed:

- **The internal TLS identity** — `DEVSPACE_TLS_CERT`/`KEY`/`CA` (PEM paths,
  all-or-nothing) give a service its identity: subject CN = service name
  (`orchestrator`, `chat-gateway`, `sandbox-core`), issued by a private
  internal CA that is the sole trust root in both directions (system roots
  never consulted). One auth regime per deployment: configuring the token
  and the identity together is refused loudly at every boot.
- **Both sides verify, per service** — every internal listener requires a
  CA-signed client certificate at the handshake and allowlists the peer's
  service name per surface (sandbox hosts serve the orchestrator; the split
  API serves the gateway; /render serves the orchestrator — a compromised
  gateway cert can no longer claim an env, the replay the token permitted).
  Clients present their identity and verify the SERVER's service name in
  place of hostname checks — addresses are deployment detail inside a
  single-purpose CA. The exec upgrade refuses before the 101, unchanged;
  the M8 frame pumps ride the TLSSocket with backpressure intact.
- **The two-listener shape** — with TLS configured the internal surface
  moves to `DEVSPACE_TLS_PORT` (default plain port + 1) and the plain port
  keeps only what cannot present a client certificate: `/health` probes,
  and on the orchestrator the GitHub webhook ingress (HMAC-verified since
  M5). The exec/secrets token gates accept transport auth; the open
  tokenless JSON ops surface does not exist on a TLS-mode host.
- **Minted test PKI** — TLS suites run over real loopback handshakes with a
  throwaway CA + certs minted per run by shelling to openssl (self-skip
  without it); no private key is checked in, and the recipe doubles as the
  minimum-viable-PKI documentation for operators.

## M14 — Expansion IX: multi-controller coordination (done)

The control-plane half of the seed M13 deliberately split: N orchestrators
over one Postgres and one sandbox fleet becomes a supported shape. Zero
contract changes; one additive `events` migration, two host knobs, and
warm-pool semantics that treat the host as the ledger it already was.
Design of record: docs/m14-plan.md.

Landed:

- **Singleton event consumption** — bus rows are claim-leased: every
  instance still hears every NOTIFY, but one atomic UPDATE
  (`claimed_by`/`claimed_at`, `consumed_at IS NULL`, prior lease older
  than the TTL) decides which controller runs the handlers. Losers skip
  silently; a claimer that crashes mid-handler is covered by the lease
  TTL — the existing recovery sweep re-claims and re-runs, so delivery
  stays at-least-once and handlers stay idempotent, while the steady
  state is exactly one controller per event. `DEVSPACE_INSTANCE_ID`
  names instances in claim diagnostics; nothing authorizes by it.
- **Sibling-safe warm pools** — the host's env table is the ONLY pool
  ledger and the wrapper's lists are hints: a lost claim race
  (CONFLICT/NOT_FOUND — a sibling got there first) drops the env and
  moves on, never destroys (pre-M14 that path could destroy the winner's
  live TENANT workspace — the one genuine safety bug); a local miss
  re-sweeps the host once per request, so a controller that never filled
  claims sibling stock warm; top-up gates on the GLOBAL marked count, so
  N controllers converge on `size`, not N×size. Listing failures degrade
  to single-controller behavior — an unreachable fleet never blocks fills.
- **Host-side resource budgets** — `SANDBOX_CPU_BUDGET` /
  `SANDBOX_MEM_BUDGET` refuse admission when the summed live grants (M12
  resource truth, durable across restarts since M11) plus the request's
  grant overflow either declared dimension: the `SANDBOX_MAX_ENVS`
  counterpart for the M12 budgets, enforced where the truth lives — no
  number of mis-counting controllers can jointly oversubscribe a host.
- **What needed no work, documented**: chat events land on ONE controller
  (the operator's load balancer picks), FSM transitions have been
  multi-writer-safe (`SELECT … FOR UPDATE`) since M3, and webhook/poll
  publishes ride idempotent topics into the now-singleton consumer. The
  reconciler still polls on every controller — duplicate GitHub reads,
  accepted at N≤handful.

## M15 — Expansion X: singleton reconciler election (done)

The two pieces of multi-controller friction the M14 closeout left standing:
N reconcilers polling GitHub, and rolling deploys destroying the fleet's
shared warm stock one controller at a time. Zero contract changes; one
additive `leases` migration, one repo interface, one sandbox-core knob.
Design of record: docs/m15-plan.md.

Landed:

- **Advisory leases** — a `leases` table (name → holder, acquired_at,
  renewed_at) and `LeaseRepo.acquire(name, owner, ttlMs)`: one atomic
  INSERT … ON CONFLICT grants the named role iff it is free, expired, or
  already ours (re-acquire = renew, tenure preserved), arbitrated entirely
  in database time like the M14 event claim. `release` is holder-guarded;
  nothing ever authorizes by the holder name — the lease deduplicates work
  that was already safe to duplicate, and the system stays correct (merely
  less efficient) if two processes ever both believe they hold a role.
- **The elected reconciler** — `startElectedTask` ticks on every
  controller, but only the `pr-reconciler` lease holder polls: the holder
  renews each tick, a crashed holder's lease expires after the TTL (2× the
  poll interval — no second knob to mis-tune) and any sibling's next tick
  takes over, and a clean stop releases the role so rolling deploys fail
  over immediately. One instance id (`DEVSPACE_INSTANCE_ID`, else per-boot
  random) now names the controller in bus-claim diagnostics AND the lease.
  The M14 "N duplicate pollers" waste is closed; the publishes stay
  idempotent, so a paused holder resuming past its TTL costs one redundant
  poll, never a wrong transition.
- **Warm-stock handover on clean shutdown** — `SANDBOX_WARM_KEEP_ON_STOP=1`
  makes `stop()` leave still-unclaimed warm envs alive: they stay
  pool-marked on their hosts, so siblings adopt them on their next sweep
  (M14) and a restarting single controller re-adopts them at the next
  boot's `fill()` (M10). Default unchanged (destroy) — the wrapper cannot
  sense whether this shutdown is a rolling restart or a teardown, and
  "leak N containers on Ctrl-C" is the wrong zero-config failure mode. The
  stop-races-provision path honors the same choice.

## M16 — Expansion XI: live utilization truth + usage-aware ranking (done)

The ready half of the "live-utilization scheduling" seed lands: hosts
report what their envs actually consume, and fleet placement RANKING weighs
that live signal — admission stays entirely on grants, so the eviction
story the seed's caveat warned about is deliberately not needed. One
additive contract type, one optional runtime method, one host route, one
orchestrator knob. Design of record: docs/m16-plan.md.

Landed:

- **Host utilization truth** — `docker stats --no-stream` behind the same
  pure-argv/pure-parse discipline as every docker call since M1
  (`ContainerRuntime.stats()`, optional on the seam), surfaced as
  `getHostStats()`: per-env usage attributed by container-id prefix to OUR
  live envs, in GRANT UNITS (cpu cores, MB — the units of
  `ResourceLimits`, host budgets, and the `cpu=`/`mem=` flags), plus the
  host's physical capacity and a sample timestamp. `GET /stats` serves it
  with the census read's auth posture (no secret material); a core that
  cannot report answers 404 and the fleet treats that as "no sample".
- **Usage-aware ranking** — `SANDBOX_STATS_INTERVAL_MS` starts a tolerant
  background sampler in the fleet layer (per-host failures log on
  transitions and keep the old sample; placement never dials a host).
  Ranking becomes `max(grant fractions, live fractions)` for hosts with a
  FRESH sample (3× the interval): measured heat can only DEMOTE a
  candidate, never admit or veto one, so a wrong/stale sample costs at
  most one placement M12 would have made anyway. Live fractions weigh
  usage against the declared budget when one exists, else against the
  host's reported physical capacity. Unset/0 = byte-for-byte M12 ranking.
- **Admission untouched, documented** — fit-checks (count slot, M12
  budgets, the M14 host-side backstop) still evaluate grants only:
  admitting on an instantaneous low reading invites oversubscription the
  moment idle envs wake, and then something must be evicted — the half of
  the seed that stays unpaid (M17+).

## M17+ — Expansion XII

NATS bus (still unnecessary: LISTEN/NOTIFY + the M14 claim survives N
orchestrators by construction; `EventBus` remains the seam if volume ever
demands it); turn-level failover (a controller that dies mid-turn loses
that turn; the conversation resumes on whichever instance gets the next
message — checkpointing is a product decision); usage-based ADMISSION and
eviction (the unpaid half of M16: scheduling on measured usage needs an
eviction story — ranking got the win without the cost) and disk-weighted
placement (host disk budgets interact with image/layer sharing in ways
neither grants nor `docker stats` — which reports no disk at all — model);
certificate rotation/revocation tooling (at three certs per deployment,
re-minting IS the revocation story — until it isn't); Discord
Forum-channel session dashboard (presentation upgrade over `/sessions`);
generalizing the M15 election to other roles when a genuinely singleton
periodic task appears (nothing else wants it today: warm-pool top-up
converges on the global ledger, the bus sweep is arbitrated per row by the
claim — and the M16 sampler deliberately runs on EVERY controller: each
one's ranking needs the cache, and N cheap reads beat electing a
publisher). UI surface remains chat only — no self-hosted web UI (see
docs/analysis/chat-platform-ui-parity.md).

## Top risks (defaults)

1. exec-stream backpressure/framing deadlocks → stress test in M1; answered in M8
   (ndjson frames over an upgraded TCP socket, watermark channels at both rims —
   loopback-proven; gRPC turned out unnecessary).
2. container escape → gVisor from M5; never ship plain-Docker multi-tenant.
3. PAT leakage → short-lived OAuth; read-only in-container; push/PR via wrapper; redact output.
4. cold-start latency → prebuilt images + warm pool + cached agent-runtime volume (<15s warm);
   answered in M9 (claim-from-pool provisioning behind the SandboxCore seam — a matching
   session claims a pre-provisioned env in milliseconds), hardened in M10 (warm stock
   survives an orchestrator crash via host-side pool marks; claims hand out a clone
   freshened at claim time, not fill time), and again in M11 (the host's own table is
   durable — warm stock now survives a sandbox-host restart too).
5. runaway agent loops → per-turn budgets; auto-abort.
6. codex-acp version drift → pin in image; isolate behind AgentBackend.
7. FSM vs GitHub drift → webhooks as source of truth; gh poll reconciliation.
8. devcontainer build failures → fall back to known-good base + manual clone.
