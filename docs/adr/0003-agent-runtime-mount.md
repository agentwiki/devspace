# ADR-0003: Deliver the agent runtime via a mounted volume

- Status: accepted
- Date: 2026-06-30

## Context

`codex-acp` needs Node + the Codex binary + an LLM key, and must run inside an
agent-agnostic sandbox. How do we get it there without sandbox-core knowing about
agents?

## Options

- A. Bake the agent into the base image — couples the core/base image to agent
  versions. Rejected.
- B. Copy the binary in per session via exec/fs — slow cold install, fragile across
  base distros. Kept only as a degraded fallback.
- C. **Mount a prebuilt `agent-runtime` volume** (pinned self-contained Node +
  codex-acp) at a fixed path `/opt/agent-runtime`. Accepted.
- D. Nested container / DinD — heavy, breaks the in-env isolation model. Rejected.

## Decision

Option C. The orchestrator provisions the env with a generic
`mounts:[{source: agent-runtime, target: /opt/agent-runtime, ro: true}]` and the
LLM key via `secrets[]`. To sandbox-core this is indistinguishable from mounting a
cache. agent-runner owns the `agent-runtime` image and the launch path
(`/opt/agent-runtime/bin/node /opt/agent-runtime/codex-acp`).

## Consequences

- The base image needs no Node and no agent knowledge; agent-agnosticism holds.
- The agent runtime is versioned independently and pinned (mitigates codex-acp drift).
- The sandbox must allow egress to the LLM endpoint (via the egress filter proxy).
