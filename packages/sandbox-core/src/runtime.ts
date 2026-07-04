/**
 * The container runtime: the narrow set of operations sandbox-core performs on
 * an already-provisioned container. Provisioning itself (clone + `devcontainer
 * up`) lives in provision.ts; everything post-`up` — exec, teardown, liveness —
 * goes through `docker` here.
 *
 * The docker argv builders are pure functions and are unit-tested directly, so
 * the (untestable-without-a-daemon) part is reduced to "hand this argv to
 * spawn", which the CommandRunner seam covers.
 */
import type { ExecRequest } from '@devspace/contracts';
import type { CommandRunner } from './cli.js';
import { runOrThrow } from './cli.js';
import type { ExecStream } from './exec.js';
import { dockerNetworkRmArgs } from './hardening.js';

export interface ContainerRuntime {
  /** Full-duplex exec inside the container (the load-bearing primitive). */
  execStream(containerId: string, req: ExecRequest): ExecStream;
  /** Force-remove the container and its anonymous volumes. */
  destroy(containerId: string): Promise<void>;
  /** True if the container still exists (any state). */
  exists(containerId: string): Promise<boolean>;
  /**
   * One usage sample per RUNNING container (M16): measured cpu in cores and
   * memory in MB — grant units. Optional: a runtime without it simply cannot
   * report host stats.
   */
  stats?(): Promise<ContainerUsage[]>;
  /** Remove a per-env network created at provision time (M5 hardening). */
  removeNetwork?(name: string): Promise<void>;
  /**
   * The container's IP as seen from the host — on `networkName` when given
   * (the M5 per-env network), else the first attached network with an
   * address. Null when the container has no usable address (M6 preview).
   */
  containerIp?(containerId: string, networkName?: string): Promise<string | null>;
}

/**
 * Build the argv for `docker exec`. Kept pure and total so it can be asserted
 * exactly in tests. `-i` is always present (stdin is half of the duplex); `-t`
 * only when a TTY was requested. Env is passed as repeated `-e K=V`.
 */
export function dockerExecArgs(containerId: string, req: ExecRequest): string[] {
  const args = ['exec', '-i'];
  if (req.tty) args.push('-t');
  if (req.cwd) args.push('-w', req.cwd);
  if (req.user) args.push('-u', req.user);
  for (const [key, value] of Object.entries(req.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(containerId, ...req.cmd);
  return args;
}

export const dockerRmArgs = (containerId: string): string[] => [
  'rm',
  '--force',
  '--volumes',
  containerId,
];

export const dockerInspectArgs = (containerId: string): string[] => [
  'inspect',
  '--format',
  '{{.Id}}',
  containerId,
];

export const dockerInspectNetworksArgs = (containerId: string): string[] => [
  'inspect',
  '--format',
  '{{json .NetworkSettings.Networks}}',
  containerId,
];

/**
 * Parse `docker inspect --format '{{json .NetworkSettings.Networks}}'` output
 * into the container's IP. Prefers `networkName` when given (the M5 per-env
 * network — the address the host can actually reach); otherwise the first
 * network with a non-empty address. Pure and total: malformed JSON or no
 * address → null, never throw.
 */
export function parseContainerIp(stdout: string, networkName?: string): string | null {
  let networks: unknown;
  try {
    networks = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof networks !== 'object' || networks === null) return null;
  const entries = Object.entries(networks as Record<string, unknown>);
  const ipOf = (value: unknown): string | null => {
    const ip = (value as { IPAddress?: unknown } | null)?.IPAddress;
    return typeof ip === 'string' && ip.length > 0 ? ip : null;
  };
  if (networkName !== undefined) {
    const named = entries.find(([name]) => name === networkName);
    return named ? ipOf(named[1]) : null;
  }
  for (const [, value] of entries) {
    const ip = ipOf(value);
    if (ip) return ip;
  }
  return null;
}

/** One container's measured usage, as reported by the runtime (M16). */
export interface ContainerUsage {
  /** The id docker reports — SHORT (12-char) for `docker stats`. */
  containerId: string;
  /** Measured cpu in cores (docker's CPUPerc is percent-of-one-core). */
  cpu: number;
  /** Measured memory in MB. */
  memMB: number;
}

/**
 * Argv for one usage sample of every running container. Deliberately not
 * per-id: a container that died between listing and sampling would fail the
 * whole read; sampling everything and attributing afterwards cannot.
 */
export const dockerStatsArgs = (): string[] => ['stats', '--no-stream', '--format', '{{json .}}'];

/**
 * Parse `docker stats --no-stream --format '{{json .}}'` output (one JSON
 * object per line) into usage rows in grant units. Pure and total: malformed
 * lines, unparsable percentages, and unknown size units are skipped — a
 * stats read never throws over one garbled row.
 */
export function parseDockerStats(stdout: string): ContainerUsage[] {
  const rows: ContainerUsage[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const row = parsed as {
      ID?: unknown;
      Container?: unknown;
      CPUPerc?: unknown;
      MemUsage?: unknown;
    };
    const containerId =
      typeof row.ID === 'string' && row.ID
        ? row.ID
        : typeof row.Container === 'string'
          ? row.Container
          : '';
    if (!containerId) continue;
    const cpu = parseCpuPercent(row.CPUPerc);
    const memMB = parseMemUsage(row.MemUsage);
    if (cpu === null || memMB === null) continue;
    rows.push({ containerId, cpu, memMB });
  }
  return rows;
}

/** "12.34%" → 0.1234 cores-of-use per percent-of-one-core; null on garbage. */
function parseCpuPercent(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([\d.]+)\s*%$/.exec(value.trim());
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? percent / 100 : null;
}

/** "1.5GiB / 15.61GiB" → the USED half in MB; null on garbage. */
function parseMemUsage(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const used = value.split('/')[0]?.trim();
  if (!used) return null;
  return parseByteSize(used);
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
};

/** "556KiB" / "1.5GB" → MB (MiB — the unit `--memory` enforces); null on garbage. */
export function parseByteSize(value: string): number | null {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = BYTE_UNITS[match[2]!.toLowerCase()];
  if (!Number.isFinite(amount) || unit === undefined) return null;
  return (amount * unit) / 1024 ** 2;
}

export interface DockerRuntimeOptions {
  /** Path/name of the docker binary. */
  dockerPath?: string;
}

/** Talks to a local Docker daemon via the `docker` CLI. */
export class DockerRuntime implements ContainerRuntime {
  private readonly docker: string;

  constructor(
    private readonly runner: CommandRunner,
    options: DockerRuntimeOptions = {},
  ) {
    this.docker = options.dockerPath ?? 'docker';
  }

  execStream(containerId: string, req: ExecRequest): ExecStream {
    return this.runner.stream(this.docker, dockerExecArgs(containerId, req));
  }

  async destroy(containerId: string): Promise<void> {
    await runOrThrow(this.runner, this.docker, dockerRmArgs(containerId));
  }

  async exists(containerId: string): Promise<boolean> {
    const result = await this.runner.run(this.docker, dockerInspectArgs(containerId));
    return result.code === 0;
  }

  async stats(): Promise<ContainerUsage[]> {
    const result = await runOrThrow(this.runner, this.docker, dockerStatsArgs());
    return parseDockerStats(result.stdout);
  }

  async removeNetwork(name: string): Promise<void> {
    await runOrThrow(this.runner, this.docker, dockerNetworkRmArgs(name));
  }

  async containerIp(containerId: string, networkName?: string): Promise<string | null> {
    const result = await this.runner.run(this.docker, dockerInspectNetworksArgs(containerId));
    if (result.code !== 0) return null;
    return parseContainerIp(result.stdout, networkName);
  }
}
