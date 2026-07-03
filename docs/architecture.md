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
