# ADR-0002: Run agents via ACP carried over the sandbox exec stream

- Status: accepted
- Date: 2026-06-30

## Context

We want sandbox-core to run ANY agent without knowing what an agent is, and we
want the agent to operate inside the isolated environment. ACP (Agent Client
Protocol) is JSON-RPC over stdio connecting a client to a coding agent; the TS SDK
`@agentclientprotocol/sdk` needs a readable+writable byte-stream pair.

## Decision

- `agent-runner` is the ACP **client**.
- The agent process (e.g. `codex-acp`) runs **inside** the sandbox, launched via
  sandbox-core's **full-duplex exec** primitive.
- agent-runner wraps the exec `{stdin, stdout}` channel in ACP's `ndJsonStream` and
  constructs a `ClientSideConnection`. stdout carries protocol; stderr is logs.

## Consequences

- sandbox-core only needs ONE non-trivial primitive — streaming exec — and stays
  fully agent-agnostic (it transports opaque bytes).
- The exec stream MUST be true full-duplex with real backpressure (gRPC bidi or WS
  with credits). A naive pipe will deadlock/OOM on large diffs or long turns. This
  is the top engineering risk and is designed in at M1.
- stdout and stderr must remain separate frames so logs don't corrupt the protocol.
