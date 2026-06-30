# ADR-0001: Introduce a dedicated control-plane orchestrator

- Status: accepted
- Date: 2026-06-30

## Context

The initial concept had three modules: sandbox-core, chat-gateway (chat), and
agent-runner (agent). The chat module would invoke the agent, and the agent would
drive the chat module (post status, ask questions) and the sandbox. That makes
chat ↔ agent a **dependency cycle**, which rots the codebase over time.

## Decision

Extract coordination into a fourth component, the **orchestrator** (control plane).
It is the only component that knows all others and the only writer of workflow
state. Providers (chat-gateway, sandbox-core) emit events UP to the orchestrator;
the orchestrator calls DOWN to providers. The single allowed cross-edge between
providers is `agent-runner → sandbox-core` (exec), because the agent runs inside
the sandbox.

"Agent drives chat" becomes "agent emits a normalized event; orchestrator routes
it to chat-gateway." Chat capabilities reach the agent as orchestrator-mediated
tools, not as an import of chat-gateway.

## Consequences

- The dependency graph is a cycle-free DAG.
- One extra deployable service (acceptable; the cycle-breaking is worth it).
- The orchestrator concentrates workflow logic and is the obvious place for the FSM,
  event routing, secret resolution, and the git/PR wrapper.
