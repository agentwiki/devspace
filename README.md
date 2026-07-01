# devspace

On-premises, self-hostable platform that spins up isolated, Codespaces-like dev
environments on demand and lets coding agents operate inside them from a chat
interface — a self-hostable "Claude Code on the web."

> **Status: M2 (agent-runner vertical).** On top of the M1 sandbox-core engine
> (real full-duplex exec with two-way backpressure, docker/devcontainer lifecycle,
> fs ops — unit- and live-Docker integration-tested in CI), `@devspace/agent-runner`
> now speaks ACP end to end: it launches codex-acp via exec, wraps the exec stream
> in `ndJsonStream`/`ClientSideConnection`, runs a prompt turn, normalizes
> `session/update`s into the `AgentEvent` stream, and gates sensitive tool calls
> behind a human approval. The whole vertical — handshake, turn, event mapping,
> permission gate — is exercised against a REAL SDK agent over an in-memory loopback
> (no Docker). The orchestrator and chat-gateway are still M0 stubs. See
> [`docs/roadmap.md`](docs/roadmap.md).

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
- [`codex-acp`](https://github.com/agentclientprotocol/codex-acp) — first agent backend.
- [Slack Bolt](https://tools.slack.dev/bolt-js/) + Block Kit — first chat adapter
  (App Home for the session list); [discord.js](https://discord.js.org) as an additional adapter.
