/**
 * Support for the live-Docker integration tests (`*.itest.ts`). Detects whether
 * a Docker daemon and the `devcontainer` CLI are actually usable, and resolves
 * the CLI binary, so the suite self-skips on machines without them (local dev)
 * and runs for real in CI where both are provisioned.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface Availability {
  ok: boolean;
  reason?: string;
  devcontainerBin: string;
}

/** Resolve the `devcontainer` binary: env override → repo-local .bin → PATH. */
export function resolveDevcontainerBin(): string {
  if (process.env.DEVSPACE_DEVCONTAINER_BIN) return process.env.DEVSPACE_DEVCONTAINER_BIN;
  const here = dirname(fileURLToPath(import.meta.url)); // .../packages/sandbox-core/src
  const repoLocal = join(here, '..', '..', '..', 'node_modules', '.bin', 'devcontainer');
  if (existsSync(repoLocal)) return repoLocal;
  return 'devcontainer';
}

/** The base image used by the integration tests; overridable for CI/offline. */
export const TEST_IMAGE =
  process.env.DEVSPACE_TEST_IMAGE ?? 'mcr.microsoft.com/devcontainers/base:ubuntu';

let cached: Availability | undefined;

/** Probe docker + devcontainer once; result is memoized for the run. */
export function detectAvailability(): Availability {
  if (cached) return cached;
  const devcontainerBin = resolveDevcontainerBin();
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    cached = { ok: false, reason: 'docker daemon not reachable', devcontainerBin };
    return cached;
  }
  try {
    execFileSync(devcontainerBin, ['--version'], { stdio: 'ignore' });
  } catch {
    cached = {
      ok: false,
      reason: `devcontainer CLI not runnable (${devcontainerBin})`,
      devcontainerBin,
    };
    return cached;
  }
  cached = { ok: true, devcontainerBin };
  return cached;
}

/** Force-remove any containers left behind by a given env label. */
export function forceRemoveByEnvLabel(envId: string): void {
  try {
    const ids = execFileSync('docker', ['ps', '-aq', '--filter', `label=devspace.envId=${envId}`], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length)
      execFileSync('docker', ['rm', '--force', '--volumes', ...ids], { stdio: 'ignore' });
  } catch {
    /* best-effort cleanup */
  }
}

/** Read a container's security/network hardening state via `docker inspect`. */
export function inspectHardening(containerId: string): {
  securityOpt: string[];
  networkMode: string;
} {
  const out = execFileSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{json .HostConfig.SecurityOpt}}\t{{.HostConfig.NetworkMode}}',
      containerId,
    ],
    { encoding: 'utf8' },
  ).trim();
  const [securityOptJson, networkMode] = out.split('\t');
  return {
    securityOpt: (JSON.parse(securityOptJson ?? 'null') as string[] | null) ?? [],
    networkMode: networkMode ?? '',
  };
}

/** True when the named docker network exists and is `--internal`. */
export function networkIsInternal(name: string): boolean {
  try {
    const out = execFileSync('docker', ['network', 'inspect', '--format', '{{.Internal}}', name], {
      encoding: 'utf8',
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/** Remove a docker network left behind by a failed test (best-effort). */
export function forceRemoveNetwork(name: string): void {
  try {
    execFileSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
  } catch {
    /* best-effort cleanup */
  }
}

/** Read a container's enforced HostConfig limits via `docker inspect`. */
export function inspectHostLimits(containerId: string): {
  memory: number;
  pidsLimit: number;
  nanoCpus: number;
} {
  const out = execFileSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}',
      containerId,
    ],
    { encoding: 'utf8' },
  ).trim();
  const [memory, pidsLimit, nanoCpus] = out.split(/\s+/).map(Number);
  return { memory: memory ?? 0, pidsLimit: pidsLimit ?? 0, nanoCpus: nanoCpus ?? 0 };
}
