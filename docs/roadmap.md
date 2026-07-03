# Roadmap

Critical path to the end-to-end demo: **M0 → M1 → M2 → M3 → M4.**
Release-blocking hardening for real multi-tenant use: **M5.**

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

## M6+ — Expansion

Additional chat adapters (Slack, Discord); 2nd ACP agent backend; multi-host
scheduling; NATS bus; the two-service HTTP split (gateway ⇄ orchestrator);
**ports preview proxy** (deferred from M5 — needs authenticated ingress
through the control plane, which the HTTP split provides). UI surface is chat
only — no self-hosted web UI (see docs/analysis/chat-platform-ui-parity.md).

## Top risks (defaults)

1. exec-stream backpressure/framing deadlocks → gRPC bidi w/ flow control; stress test in M1.
2. container escape → gVisor from M5; never ship plain-Docker multi-tenant.
3. PAT leakage → short-lived OAuth; read-only in-container; push/PR via wrapper; redact output.
4. cold-start latency → prebuilt images + warm pool + cached agent-runtime volume (<15s warm).
5. runaway agent loops → per-turn budgets; auto-abort.
6. codex-acp version drift → pin in image; isolate behind AgentBackend.
7. FSM vs GitHub drift → webhooks as source of truth; gh poll reconciliation.
8. devcontainer build failures → fall back to known-good base + manual clone.
