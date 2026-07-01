# Roadmap

Critical path to the end-to-end demo: **M0 → M1 → M2 → M3 → M4.**

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

## M2 — agent-runner + agent-in-container (in progress)

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

## M3 — orchestrator + FSM + secrets

Work-unit FSM wired to Postgres; event bus (LISTEN/NOTIFY); per-user PAT/LLM-key
store + injection; deterministic git/PR wrapper. Out: webhooks (poll instead).

## M4 — chat-gateway (Slack) end-to-end

Slack adapter: create conversation, pick repo, live status message, message→turn,
stream output, create-PR/view-PR + approval buttons. **= the demo.**

## M5 — Hardening (release-blocking for real multi-tenant use)

gVisor/Kata, egress allowlist, output redaction, turn budgets, audit log, ports
preview proxy, GitHub webhooks.

> Auto-abort caveat: turn-budget/runaway kill must NOT rely on `ExecStream.kill()`
> alone. Over the docker-exec transport that signals only the local `docker exec`
> client; Docker does not propagate it into the container, so the agent's
> in-container process tree survives. Hard-stopping an agent needs in-container
> termination (`docker exec <ctr> kill`) or `destroy()` (`docker rm --force`).

## M6+ — Expansion

Additional chat adapters (Slack, Discord); 2nd ACP agent backend; multi-host
scheduling; NATS bus. UI surface is chat only — no self-hosted web UI (see
docs/analysis/chat-platform-ui-parity.md).

## Top risks (defaults)

1. exec-stream backpressure/framing deadlocks → gRPC bidi w/ flow control; stress test in M1.
2. container escape → gVisor from M5; never ship plain-Docker multi-tenant.
3. PAT leakage → short-lived OAuth; read-only in-container; push/PR via wrapper; redact output.
4. cold-start latency → prebuilt images + warm pool + cached agent-runtime volume (<15s warm).
5. runaway agent loops → per-turn budgets; auto-abort.
6. codex-acp version drift → pin in image; isolate behind AgentBackend.
7. FSM vs GitHub drift → webhooks as source of truth; gh poll reconciliation.
8. devcontainer build failures → fall back to known-good base + manual clone.
