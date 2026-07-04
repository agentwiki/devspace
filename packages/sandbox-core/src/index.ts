/**
 * @devspace/sandbox-core
 *
 * Agent-agnostic environment engine. Wraps `devcontainers/cli` (`devcontainer
 * up`) for provisioning plus Docker for lifecycle, streaming exec, and fs. It
 * exposes ONLY generic primitives; it has no concept of "agents" or "chat".
 * Mounting an agent runtime is just another `mounts[]` entry to this layer.
 *
 * The load-bearing primitive is the full-duplex exec stream with real
 * backpressure in both directions (ADR-0002) — see `process-stream.ts`. Since
 * M8 the same stream travels between machines over the `devspace-exec` wire
 * (`remote-*.ts`), and `multihost.ts` places envs across a fleet of hosts.
 */
export * from './exec.js';
export * from './process-stream.js';
export * from './cli.js';
export * from './egress-proxy.js';
export * from './preview-proxy.js';
export * from './hardening.js';
export * from './runtime.js';
export * from './provision.js';
export * from './sandbox.js';
export * from './remote-protocol.js';
export * from './remote-server.js';
export * from './remote-client.js';
export * from './multihost.js';
export * from './warm-pool.js';
