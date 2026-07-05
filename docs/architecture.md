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

Since M16 the fleet can see actual load, not just promises: every sandbox
host reports a live utilization sample (`GET /stats` — `docker stats` behind
the runtime seam, per-env usage in grant units plus the host's physical
capacity), and with `SANDBOX_STATS_INTERVAL_MS` set the orchestrator's fleet
layer samples in the background and lets placement RANKING take
`max(grant fractions, fresh live fractions)` — a measurably hot host is
demoted, a stale or missing sample degrades to the pure M12 grant score, and
admission never consults the live signal, so budgets still bound the worst
case and no eviction story is needed (docs/m16-plan.md).

Since M17 sessions have an end the platform enforces: work units carry
`lastActivityAt` (written only by the tenant-driven chat events — FSM
transitions keep owning `updatedAt`), and an elected reaper — the second
`startElectedTask` role, under the `lifecycle-reaper` lease — gives the
long-uncalled `teardown()` its production caller: pre-PR units idle past
`DEVSPACE_IDLE_TTL_MS` are torn down with a notice in their thread, terminal
units unchanged past `DEVSPACE_TERMINAL_GRACE_MS` are collected silently,
and PR_OPEN is exempt (GitHub owns that lifecycle; the webhook/poll advances
it to a terminal state the grace then collects). The audit `teardown` row
carries the reason (`requested|idle|expired`); conversation, work-unit, and
audit rows survive reclamation. Both knobs unset = no reaper
(docs/m17-plan.md).

Since M18 reclamation has manners and the PR_OPEN exemption has a price
tag: `DEVSPACE_IDLE_WARN_MS` makes the reaper warn a full window before an
idle reap — `idle_warned_at` is written once per idle period (never
cleared; staleness is a comparison against the idle clock) and no idle
reap ever happens unwarned, even for a unit discovered already past the
TTL. `DEVSPACE_PR_OPEN_ENV_TTL_MS` releases the ENVIRONMENT of a PR_OPEN
unit idle in review — destroy tolerating only NOT_FOUND (any other failure
keeps `envId` and retries), then `releaseEnv` nulls `envId` +
`agentSessionId`, audited as `env.released` and announced after the fact —
while the unit, its secrets, and the merge/close flow survive intact
(docs/m18-plan.md).

Since M19 a PR under review is not a dead end: a message in PR_OPEN offers
`resume-work` (the M18 release notice carries it too), which probes the
row's env against the host and — when it is gone — re-provisions from the
PR BRANCH before applying `resume` (PR_OPEN → WORKING); the next message
lazily creates the fresh agent session, persisted through a WORKING
self-loop. An idle resumed unit (a pre-PR state carrying a `prNumber`) is
SUSPENDED back to PR_OPEN by the same idle TTL — env destroyed
(NOT_FOUND-tolerant), `releaseEnv`, `suspend`, audited — never torn down;
merge/close events landing mid-resume are dropped and re-detected by the
poll once the unit returns to PR_OPEN (docs/m19-plan.md).

Since M20 a resumed session is not blind: every turn the orchestrator
actually runs lands in the durable `transcripts` table — the tenant prompt
and ONE coalesced agent reply per turn, both passed through the
conversation's redaction registry BEFORE storage, appended best-effort so
bookkeeping never fails a turn. When the M19 self-loop mints a fresh agent
session on a resumed unit, the transcript tail is rendered into a bounded
preamble (oldest entries dropped past the char budget, the cut marked) and
prefixed onto that first prompt only; the preamble is never persisted, so
suspend/resume cycles cannot compound it, and a failed read degrades to the
M19 blind resume (docs/m20-plan.md).

Since M21 the transcript has a tenant-reachable reader and both append-only
tables have an operator horizon: `!history` in a session thread (both
adapters normalize it onto the `view-history` action id, the `!port` shape)
replays a bounded, role-labelled tail of the durable transcript as one
ordinary redacted message — state-blind, because the rows survive
suspension, env release, and teardown; the omitted marker appears iff
history actually exists above the window. `DEVSPACE_TRANSCRIPT_RETENTION_MS`
/ `DEVSPACE_AUDIT_RETENTION_MS` (deliberately separate knobs — the audit log
is the compliance record) add a prune phase to the elected reaper's sweep:
rows strictly older than each horizon are deleted and the counts reported,
never silently (docs/m21-plan.md).

Since M22 egress policy is per-environment: a `CreateEnvironmentRequest` can
carry `networkAccess: 'none' | 'custom'` (+ `allowedHosts`), which only ever
NARROWS the operator's allowlist — 'custom' entries must be covered by it,
and there is no widening level. Enforcement lives at the M5 egress proxy as
a per-network scope keyed on the local address a connection arrived on (an
`--internal` network reaches the host only at its own bridge gateway —
nothing the workload can forge); the scope is registered before `up`,
cleared with the network at destroy, persisted as birth policy in the M11
table, and re-registered at recovery — or the env is discarded when the
host can no longer enforce it. Tenants choose with
`/devspace <repo> [ref] [net=none|net=host1,host2]` on both adapters; the
work unit remembers the choice so the M19 resume re-provisions with the
same narrowing, and hosts that cannot enforce a scope (demo mode, shared
networks, static proxy URL) refuse the request rather than honor it loosely
(docs/m22-plan.md).

Since M23 a request can also WIDEN — under an operator ceiling:
`SANDBOX_TENANT_HOSTS` names the hosts a tenant may add beyond the
allowlist, carried on the scope registrar as validation input only (never
added to the proxy default — a ceiling host is reachable only inside an
env whose resolved scope names it). `networkAccess: 'extend'` resolves to
the operator allowlist ∪ the requested extras at provisioning (birth
policy, deduped); one admissibility rule covers `custom` and `extend`
(entry covered by allowlist OR ceiling), and inadmissible entries refuse
naming both. Tenants ask with `net=+extra1,+extra2` (all entries marked or
none — a mixed list empties the choice) or the new optional Network field
on both repo-picker modals, which rides the composed picker text as a
`net=` token so `parseRepoChoice` stays the single interpreter
(docs/m23-plan.md).

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
PR_OPEN --resume--> WORKING ;  WORKING|PRE_PR --suspend--> PR_OPEN   (M19)
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
