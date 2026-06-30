# devspace

On-premises, self-hostable platform that spins up isolated, Codespaces-like dev
environments on demand and lets coding agents operate inside them from a chat
interface — a self-hostable "Claude Code on the web."

> **Status: M0 (scaffolding).** Design docs + a compiling monorepo skeleton.
> No real business logic yet. See [`docs/roadmap.md`](docs/roadmap.md).

## Architecture at a glance

Four services, one monorepo, dependency graph is a cycle-free DAG:

| Service | Package | Role |
| --- | --- | --- |
| **orchestrator** | `@devspace/orchestrator` | Control plane. Owns the work-unit FSM, routes events, the only writer of state. |
| **sandbox-core** | `@devspace/sandbox-core` | Agent-agnostic environment engine (devcontainers/cli). Generic primitives only. |
| **agent-runner** | `@devspace/agent-runner` | ACP client + harness + guardrails. Drives agents inside sandboxes. |
| **chat-gateway** | `@devspace/chat-gateway` | Chat adapters (Discord first). Emits events up, renders commands down. |

Shared: `@devspace/contracts` (zod schemas + types), `@devspace/db` (Prisma + repos).

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

### Prisma (schema validate / generate / migrate)

In restricted/proxied environments Prisma's built-in engine downloader can fail
with `ECONNRESET`. Pre-fetch the engines with curl (reliable over the proxy),
then use Prisma normally:

```bash
./scripts/fetch-prisma-engines.sh          # run once after pnpm install
pnpm --filter @devspace/db db:validate     # -> "The schema ... is valid 🚀"
# DATABASE_URL=... pnpm --filter @devspace/db db:migrate   # needs Postgres
```


## Key technologies

- [`devcontainers/cli`](https://github.com/devcontainers/cli) — sandbox engine.
- [ACP (Agent Client Protocol)](https://agentclientprotocol.com) via
  [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) —
  agent-runner is the ACP client.
- [`codex-acp`](https://github.com/agentclientprotocol/codex-acp) — first agent backend.
- [discord.js](https://discord.js.org) — first chat adapter.
