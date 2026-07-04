# Architecture

## Goal

An on-prem platform that (a) instantly creates isolated, Codespaces-like dev
environments and (b) lets coding agents operate inside them, driven from chat.
Self-hostable "Claude Code on the web."

## Components & dependency DAG

```
               [Slack / Discord]
                     |  (platform events)
                     v
   orchestrator  <----  chat-gateway     (emits events UP, never calls agent/sandbox)
       |  \  \
       |   \   ----> chat-gateway        (render commands DOWN: messages/status/buttons)
       |    -------> agent-runner         (run agent turn)
       --------------> sandbox-core       (provision / exec / fs / lifecycle)
                          ^
                          |  (exec stream only — to launch the agent in the container)
                       agent-runner

  State of record: Postgres (orchestrator is the ONLY writer of workflow state)
  Event bus: Postgres LISTEN/NOTIFY + durable `events` table (MVP) -> NATS later
```

Since M6 the gateway⇄orchestrator edge has a real transport: an internal HTTP
API (`POST /chat-events` up, `POST /render` down, shared-bearer-token auth)
cut at exactly those two seam functions — the in-process demo wiring and the
two-service split are the same graph, differing only in transport
(docs/m6-plan.md, workstream A).

Since M8 the orchestrator→sandbox-core edge has one too: the sandbox tier is
1..N hosts, each a sandbox-core-svc over its own Docker daemon. The JSON
control surface rides the same bearer regime, and the full-duplex exec stream
crosses machines as ndjson `ExecFrame`s over a `devspace-exec` HTTP Upgrade
with backpressure preserved end to end (TCP's window is the kernel-enforced
middle; the M1 watermark channel sits at both rims). `MultiHostSandboxCore`
places envs (least-loaded, capacity-capped, drain-aware) and routes stickily
behind the unchanged `SandboxCore` interface — fleet mode is a config flip
(`SANDBOX_HOSTS`), and unset, everything stays in-process as in M4
(docs/m8-plan.md).

Since M9 that capacity is true rather than assumed: each host enforces its
own live-env cap (`SANDBOX_MAX_ENVS`), and a boot-time census
(`adoptFleet()` over the new `listEnvironments()` read) re-learns live envs
before the first placement. On top of the same seam, `WarmPoolSandboxCore`
pre-provisions configured pools (`SANDBOX_WARM_POOLS`) and serves an
exactly-matching create by claiming a warm env and late-binding the
tenant's secrets (`applySecrets` — token-gated on the wire like exec), so
the demo-critical cold-start path collapses from minutes to milliseconds
(docs/m9-plan.md).

Since M10 the warm stock survives its control plane: every fill is stamped
with its pool's canonical key (`poolKey`, on the host's env table), so a
restarted orchestrator's `fill()` re-adopts what its predecessor warmed
instead of leaking it, and a claim is one host-side operation
(`claimEnvironment`) that freshens the workspace clone and clears the mark
before hand-out — the mark is the capability, so a tenant env can never be
claimed or hard-reset (docs/m10-plan.md).

Since M11 the host's own table is durable: `SANDBOX_STATE_DIR` persists one
atomic JSON state file per env (metadata only — secret values and preview
tokens never touch host disk), and boot-time `recover()` re-adopts only
records the Docker daemon still confirms, completing crashed transitions
instead of re-homing them. Because the M9 census and M10 orphan sweep read
`listEnvironments()`, they now survive a sandbox HOST restart too — recovered
warm stock is re-adopted, and a recovered env gets its secrets re-attached
through `applySecrets` (docs/m11-plan.md).

Since M12 placement is resource-aware: every env echoes the `ResourceLimits`
its host granted at provisioning (persisted with the M11 table, so a
recovered env keeps its true weight), and a host can declare cpu/memory
budgets on its `SANDBOX_HOSTS` entry. Admission fit-checks the request's
grant against every declared budget (the env-count capacity stays the
backstop), ranking is least max-fractional utilization, and in-flight
reservations carry their footprint so bursts cannot oversubscribe — the
scheduler weighs what it promised, deliberately, not what containers happen
to use (docs/m12-plan.md).

Since M13 every internal hop can authenticate by service identity instead of
the shared bearer: with the `DEVSPACE_TLS_*` identity configured (never
alongside the token — one auth regime per deployment), the split API, the
sandbox surface, and the exec upgrade move to per-service mTLS listeners
(`DEVSPACE_TLS_PORT`). Certificates carry the service name as their subject
CN, issued by a private internal CA that is the sole trust root; servers
allowlist the peer's name per surface and clients verify the server's
service — not its hostname — so a compromised gateway certificate can no
longer be replayed against a sandbox host. `/health` probes and the
HMAC-verified GitHub webhooks stay on the plain port (docs/m13-plan.md).

Since M14 the control plane itself scales out: N orchestrators over one
Postgres and one sandbox fleet is a supported shape. Bus rows are
claim-leased (`claimed_by`/`claimed_at` + a TTL, arbitrated by one atomic
UPDATE), so every instance hears every NOTIFY but exactly one runs the
handlers — delivery stays at-least-once and handlers stay idempotent. Warm
pools treat the host's env table as the only ledger: a lost claim race
drops instead of destroys, a local miss adopts sibling-filled stock, and
top-up gates on the global marked count. The M12 grant budgets gain their
host-side backstop (`SANDBOX_CPU_BUDGET`/`SANDBOX_MEM_BUDGET`, the
`SANDBOX_MAX_ENVS` counterpart) — enforced where the truth lives, whatever
any controller believes (docs/m14-plan.md).

Since M15 the multi-controller shape is also frugal: named advisory leases
(a `leases` table; one atomic upsert grants a role iff it is free, expired,
or already ours) elect a single PR poll reconciler — every controller
ticks, only the `pr-reconciler` lease holder polls GitHub, a crashed
holder is replaced within 2× the poll interval, and a clean shutdown
releases the role immediately. The election is advisory: the publishes
were always idempotent, so losing the dedup costs a redundant poll, never
a wrong transition. Rolling deploys keep the fleet's warm stock:
`SANDBOX_WARM_KEEP_ON_STOP=1` leaves still-unclaimed warm envs pool-marked
on their hosts for siblings (or the next boot) to adopt instead of
destroying them one controller at a time (docs/m15-plan.md).

### Dependency rules (keep it a DAG)

1. `orchestrator` is the only component that knows all others; owns workflow + FSM.
2. `chat-gateway` and `sandbox-core` depend on nobody; they emit events up.
3. `agent-runner -> sandbox-core` (exec) is the only allowed cross-edge, downward —
   needed because the agent runs inside the sandbox.
4. "Agent drives chat" is **not** a call into `chat-gateway`. The agent emits
   normalized events; the orchestrator routes them to `chat-gateway`. Chat
   capabilities reach the agent as orchestrator-mediated tools, not imports.

This is the cycle-breaking core: the original 3-module model (chat→agent AND
agent→chat) is a cycle; extracting coordination into the orchestrator makes it acyclic.

## Sandbox agent-agnosticism

`sandbox-core` exposes only generic primitives — lifecycle, **full-duplex
streaming exec**, fs, ports, and generic `mounts[]`/`secrets[]`. It never learns
what an agent is. The agent runtime (Node + codex-acp) is delivered by mounting a
prebuilt `agent-runtime` volume at `/opt/agent-runtime`, indistinguishable to the
core from mounting a cache. See [ADR-0003](adr/0003-agent-runtime-mount.md).

## ACP over exec

`agent-runner` is the ACP client. It launches the agent inside the env via the
exec stream, wraps the `{stdin, stdout}` byte channel in ACP's `ndJsonStream`, and
builds a `ClientSideConnection`. stdout carries protocol; stderr is logs. The core
transports opaque bytes. See [ADR-0002](adr/0002-acp-over-exec.md).

## Work-status state machine

Owned by the orchestrator, persisted in Postgres, defined declaratively in
`@devspace/contracts` (`WORK_TRANSITIONS`, `nextWorkState`):

```
CREATED --repoChoice--> PROVISIONING --envReady--> READY
READY --firstMessage--> WORKING --committedAndPushed--> PRE_PR --prCreated--> PR_OPEN
PR_OPEN --prMerged|prClosed--> PR_MERGED | PR_CLOSED
any --error--> FAILED ;  any --end--> TORN_DOWN
```

- `create-pr` = **hybrid**: agent writes the title/body, the orchestrator's
  deterministic git/PR wrapper runs `gh pr create` with the user's PAT under policy.
- `view-pr` = **fully deterministic**: read `prUrl` and render. No agent.

## Guardrails (layered)

- Infra (sandbox-core): cgroups, seccomp/AppArmor, no docker socket, egress allowlist.
- Driver-level (agent-runner): command allow/deny, workspace-confined writes,
  protected paths, secret redaction. See `packages/agent-runner/src/guardrails.ts`.
- Turn-level (agent-runner): wall-clock / tool-call / token budgets.
- Approval gates (orchestrator + chat-gateway): push/PR/destructive ops need human OK.
