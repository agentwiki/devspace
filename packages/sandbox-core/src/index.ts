/**
 * @devspace/sandbox-core
 *
 * Agent-agnostic environment engine. Wraps `devcontainers/cli` (`devcontainer
 * up`) for provisioning plus Docker for lifecycle, streaming exec, and fs. It
 * exposes ONLY generic primitives; it has no concept of "agents" or "chat".
 * Mounting an agent runtime is just another `mounts[]` entry to this layer.
 *
 * The load-bearing primitive is the full-duplex exec stream with real
 * backpressure in both directions (ADR-0002) — see `process-stream.ts`.
 */
export * from './exec.js';
export * from './process-stream.js';
export * from './cli.js';
export * from './hardening.js';
export * from './runtime.js';
export * from './provision.js';
export * from './sandbox.js';
