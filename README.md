# devspace

On-premises, self-hostable platform that spins up isolated, Codespaces-like dev
environments on demand and lets coding agents operate inside them from a chat
interface — a self-hostable "Claude Code on the web."

> **Status: M13 (expansion VIII).** The full vertical is live end to end — sandbox
> engine (M1), ACP agent runner + approval gate (M2), orchestrator FSM +
> secrets + host-side git/PR (M3), Slack surface (M4), multi-tenant hardening
> (gVisor profile, egress allowlist, budgets/auto-abort, audit log, webhooks —
> M5), the real two-service deployment, ports preview proxy, Discord adapter
> and second agent backend (M6), preview WebSocket upgrades and Discord UI
> parity (M7), multi-host foundations — the exec stream between machines with
> backpressure preserved, fleet placement (M8) — capacity truth + warm pools
> (`SANDBOX_MAX_ENVS`, a boot-time census, `SANDBOX_WARM_POOLS=` pools a
> matching session claims in milliseconds — M9), warm stock that survives an
> orchestrator crash and claims that hand out a clone refreshed at claim time
> (M10), a durable host env table — with `SANDBOX_STATE_DIR` set, a sandbox
> host's table survives a restart and is recovered against what the Docker
> daemon still confirms (M11) — placement that is resource-aware: envs
> echo their granted cpu/memory, and `SANDBOX_HOSTS` budgets
> (`cpu=<cores>`/`mem=<MB>`) turn fleet placement into fit-checked,
> fractional least-loaded scheduling over what was promised (M12) — and M13
> puts per-service identity on the internal API: with the `DEVSPACE_TLS_*`
> identity configured (replacing the shared token, never alongside it),
> every internal hop — split API, sandbox surface, exec upgrade — runs over
> mutual TLS on its own listener, certificates name their service, and each
> surface allowlists exactly the peer it serves. M14 lets the control plane
> itself scale out: bus rows are claim-leased so N orchestrators over one
> database each consume every event exactly once in steady state, warm
> pools share the fleet's stock through the host's own ledger (a lost claim
> race drops, never destroys), and `SANDBOX_CPU_BUDGET`/`SANDBOX_MEM_BUDGET`
> give the M12 grant budgets a host-side backstop.
> See [`docs/roadmap.md`](docs/roadmap.md).

## Testing

```bash
pnpm -r test           # unit tests — fast, no Docker
pnpm test:integration  # live-Docker integration (needs docker + devcontainer CLI;
                       # self-skips when unavailable). @devcontainers/cli is a devDep.
```

Both run in CI (`.github/workflows/ci.yml`): unit + lint + format on every push/PR,
and the integration suite in a job with a live Docker daemon.

## Architecture at a glance

Four services, one monorepo, dependency graph is a cycle-free DAG:

| Service          | Package                  | Role                                                                            |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------- |
| **orchestrator** | `@devspace/orchestrator` | Control plane. Owns the work-unit FSM, routes events, the only writer of state. |
| **sandbox-core** | `@devspace/sandbox-core` | Agent-agnostic environment engine (devcontainers/cli). Generic primitives only. |
| **agent-runner** | `@devspace/agent-runner` | ACP client + harness + guardrails. Drives agents inside sandboxes.              |
| **chat-gateway** | `@devspace/chat-gateway` | Chat adapters (Slack first). Emits events up, renders commands down.            |

Shared: `@devspace/contracts` (zod schemas + types), `@devspace/db` (Drizzle + repos).

```
        orchestrator
        /     |      \
  chat-gateway agent-runner sandbox-core
                    \________/
              agent-runner -> sandbox-core (exec only)
  chat-gateway & sandbox-core depend on nobody; events flow UP to orchestrator
```

Full design: [`docs/architecture.md`](docs/architecture.md) ·
[`docs/contracts.md`](docs/contracts.md) · [`docs/security.md`](docs/security.md) ·
ADRs in [`docs/adr/`](docs/adr/).

## Repo layout

```
packages/  contracts  db  sandbox-core  chat-gateway  agent-runner  orchestrator
apps/      orchestrator-svc  sandbox-core-svc  chat-gateway-svc  agent-runner-svc
infra/     Dockerfile  compose.yaml  images/base  images/agent-runtime
docs/      architecture.md  contracts.md  security.md  roadmap.md  adr/
```

## Quickstart

Requires Node 22+, pnpm 10+, Docker.

```bash
pnpm install
pnpm -r build        # topological: contracts -> db -> domain pkgs -> apps
pnpm -r test         # contract + FSM + guardrail unit tests

# Run the stack (Postgres + 4 services):
docker compose -f infra/compose.yaml up --build

# Health checks:
curl localhost:4000/health   # orchestrator
curl localhost:4001/health   # sandbox-core
curl localhost:4002/health   # chat-gateway
curl localhost:4003/health   # agent-runner
```

### Database (Drizzle — no native engine, offline/air-gap friendly)

Schema lives in `packages/db/src/schema.ts`. `drizzle-kit generate` emits SQL
migrations locally — no database connection and no binary download (this is why
we use Drizzle over Prisma for an on-prem product; see
[ADR-0004](docs/adr/0004-drizzle-over-prisma.md)).

```bash
pnpm --filter @devspace/db db:generate     # schema -> drizzle/*.sql (offline)
# DATABASE_URL=... pnpm --filter @devspace/db db:migrate   # apply (needs Postgres)
```

## Key technologies

- [`devcontainers/cli`](https://github.com/devcontainers/cli) — sandbox engine.
- [ACP (Agent Client Protocol)](https://agentclientprotocol.com) via
  [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) —
  agent-runner is the ACP client.
- [`codex-acp`](https://github.com/agentclientprotocol/codex-acp) — first agent backend;
  `claude-code-acp` is the second (M6), both behind the `AgentBackend` seam.
- [Slack Bolt](https://tools.slack.dev/bolt-js/) + Block Kit — first chat adapter
  (App Home for the session list); [discord.js](https://discord.js.org) as an additional adapter.
