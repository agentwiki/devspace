/**
 * M5 hardening profile: the host-side isolation policy applied to every
 * provisioned container.
 *
 * Hardening is DEPLOYMENT policy, not caller choice (m5-plan Decision 1): the
 * profile lives on the provisioner, sourced from service config at boot, and
 * never appears on `CreateEnvironmentRequest` — a tenant request cannot weaken
 * its own sandbox. Everything here is a pure builder over that policy; the
 * only I/O (the `docker info` runtime probe) goes through the CommandRunner
 * seam like the rest of sandbox-core.
 *
 * Layers (see docs/security.md "Container isolation"):
 *  - runtime class:   `--runtime=runsc` (gVisor) / `kata-runtime` — the kernel
 *                     boundary; asserted available at BOOT, not per provision.
 *  - privileges:      `no-new-privileges`, cap-drop ALL + a minimal add-back.
 *  - network:         one `--internal` bridge network per env — no route out
 *                     (egress only via the allowlist proxy, egress-proxy.ts)
 *                     and no env↔env traffic.
 *  - disk quota:      opt-in `--storage-opt size=` (driver-gated: overlay2 on
 *                     xfs+pquota; errors out elsewhere — hence the M1 deferral
 *                     and the opt-in).
 */
import type { CommandRunner } from './cli.js';
import { runOrThrow } from './cli.js';

export interface SandboxHardening {
  /** Container runtime class, e.g. 'runsc' (gVisor) or 'kata-runtime'. */
  runtime?: string;
  /** Inject `--security-opt=no-new-privileges`. */
  noNewPrivileges?: boolean;
  /** Capabilities to drop (typically ['ALL']). */
  capDrop?: string[];
  /** Capabilities to add back after the drop (minimal dev-workload set). */
  capAdd?: string[];
  /**
   * Network attachment: 'per-env' creates an isolated `--internal` bridge
   * network per environment (created before `up`, removed on teardown); a
   * string attaches to that existing named network; undefined keeps the
   * Docker default (demo mode).
   */
  network?: 'per-env' | string;
  /** Opt-in `--storage-opt size=<diskMB>m` (driver-dependent). */
  enforceDiskQuota?: boolean;
  /**
   * Egress allowlist proxy URL (http://<bridge-gateway>:<port>). When set it
   * is injected as HTTP(S)_PROXY containerEnv so every in-env process
   * inherits it. Enforcement does NOT rely on processes honoring it — the
   * internal network has no other route.
   */
  egressProxyUrl?: string;
  /** Escape hatch for deployment-specific flags; appended last. */
  extraRunArgs?: string[];
}

/** Demo mode: plain Docker, default bridge — docs/security.md's "demo only". */
export const DEMO_HARDENING: SandboxHardening = {};

/**
 * The release-blocking profile from docs/security.md. `enforceDiskQuota` stays
 * opt-in even here (driver-gated); `egressProxyUrl` is deployment-specific.
 */
export const HARDENED_DEFAULTS: SandboxHardening = {
  runtime: 'runsc',
  noNewPrivileges: true,
  capDrop: ['ALL'],
  // The minimal set a dev workload needs: file ownership/permissions inside
  // its own workspace and signaling its own process tree.
  capAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'KILL'],
  network: 'per-env',
  enforceDiskQuota: false,
};

/**
 * Map a hardening profile to `docker run` flags (injected via devcontainer
 * `runArgs`, appended after the resource args — same never-clobber rule).
 * `networkName` is the RESOLVED name ('per-env' profiles resolve per envId
 * via `resolveNetworkName`).
 */
export function hardeningRunArgs(
  hardening: SandboxHardening,
  opts: { diskMB: number; networkName?: string },
): string[] {
  const args: string[] = [];
  if (hardening.runtime) args.push(`--runtime=${hardening.runtime}`);
  if (hardening.noNewPrivileges) args.push('--security-opt=no-new-privileges');
  for (const cap of hardening.capDrop ?? []) args.push(`--cap-drop=${cap}`);
  for (const cap of hardening.capAdd ?? []) args.push(`--cap-add=${cap}`);
  if (opts.networkName) args.push(`--network=${opts.networkName}`);
  if (hardening.enforceDiskQuota) args.push(`--storage-opt=size=${opts.diskMB}m`);
  args.push(...(hardening.extraRunArgs ?? []));
  return args;
}

/** Resolve the network a given env attaches to (undefined = docker default). */
export function resolveNetworkName(hardening: SandboxHardening, envId: string): string | undefined {
  if (!hardening.network) return undefined;
  if (hardening.network === 'per-env') return perEnvNetworkName(envId);
  return hardening.network;
}

/** True when this profile owns a network's lifecycle (create before `up`, rm on teardown). */
export function ownsNetworkLifecycle(hardening: SandboxHardening): boolean {
  return hardening.network === 'per-env';
}

export function perEnvNetworkName(envId: string): string {
  return `devspace-net-${envId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;
}

export function dockerNetworkCreateArgs(name: string, opts: { internal: boolean }): string[] {
  const args = ['network', 'create'];
  if (opts.internal) args.push('--internal');
  args.push(name);
  return args;
}

export const dockerNetworkRmArgs = (name: string): string[] => ['network', 'rm', name];

/** `HTTP(S)_PROXY` containerEnv for the egress proxy (both cases — tools disagree). */
export function proxyContainerEnv(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    // In-env loopback and container-local names never detour via the proxy.
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };
}

/** Parse `docker info --format '{{json .Runtimes}}'` into the runtime names. */
export function parseDockerRuntimes(stdout: string): string[] {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`could not parse docker runtimes from: ${trimmed.slice(0, 200)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('docker runtimes output is not an object');
  }
  return Object.keys(parsed);
}

export const dockerInfoRuntimesArgs = (): string[] => ['info', '--format', '{{json .Runtimes}}'];

/**
 * Fail fast at service boot when the configured runtime class is missing from
 * the daemon — a clear message instead of a cryptic `devcontainer up` failure
 * on the first provision (m5-plan Decision 2).
 */
export async function assertRuntimeAvailable(
  runner: CommandRunner,
  runtime: string,
  dockerPath = 'docker',
): Promise<void> {
  const result = await runOrThrow(runner, dockerPath, dockerInfoRuntimesArgs());
  const available = parseDockerRuntimes(result.stdout);
  if (!available.includes(runtime)) {
    throw new Error(
      `container runtime "${runtime}" is not available on this daemon ` +
        `(available: ${available.join(', ') || 'none'}); install it or unset the hardened runtime`,
    );
  }
}
