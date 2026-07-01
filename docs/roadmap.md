# Roadmap

Critical path to the end-to-end demo: **M0 → M1 → M2 → M3 → M4.**

## M0 — Scaffolding (this milestone)
Monorepo, 6 packages + 4 apps, zod contracts, Drizzle schema, compose, base +
agent-runtime image skeletons, stub services with `/health`, design docs. No real
logic. **Done when** `pnpm -r build`, `pnpm -r test`, and the 4 health checks pass.

## M1 — sandbox-core vertical
`devcontainers/cli` integration: provision from repoUrl, **bidi streaming exec
with real backpressure/flow-control**, fs ops, teardown, resource limits.
Out: ports proxy polish, gVisor.

## M2 — agent-runner + agent-in-container
Build the agent-runtime volume; mount it; launch codex-acp via exec; wrap stdio in
ACP `ndJsonStream`/`ClientSideConnection`; run one turn; normalize events.
Out: full guardrails, approvals.

## M3 — orchestrator + FSM + secrets
Work-unit FSM wired to Postgres; event bus (LISTEN/NOTIFY); per-user PAT/LLM-key
store + injection; deterministic git/PR wrapper. Out: webhooks (poll instead).

## M4 — chat-gateway (Discord) end-to-end
Discord adapter: create conversation, pick repo, live status message, message→turn,
stream output, create-PR/view-PR + approval buttons. **= the demo.**

## M5 — Hardening (release-blocking for real multi-tenant use)
gVisor/Kata, egress allowlist, output redaction, turn budgets, audit log, ports
preview proxy, GitHub webhooks.

## M6+ — Expansion
Slack + web-UI adapters; 2nd ACP agent backend; multi-host scheduling; NATS bus.

## Top risks (defaults)
1. exec-stream backpressure/framing deadlocks → gRPC bidi w/ flow control; stress test in M1.
2. container escape → gVisor from M5; never ship plain-Docker multi-tenant.
3. PAT leakage → short-lived OAuth; read-only in-container; push/PR via wrapper; redact output.
4. cold-start latency → prebuilt images + warm pool + cached agent-runtime volume (<15s warm).
5. runaway agent loops → per-turn budgets; auto-abort.
6. codex-acp version drift → pin in image; isolate behind AgentBackend.
7. FSM vs GitHub drift → webhooks as source of truth; gh poll reconciliation.
8. devcontainer build failures → fall back to known-good base + manual clone.
