/**
 * Provisioning: turn a CreateEnvironmentRequest into a running container.
 *
 * Flow (`devcontainer up`, per the roadmap): prepare a workspace folder (shallow
 * git clone when a repoUrl is given, otherwise an empty scratch dir), synthesize
 * an effective devcontainer.json that merges the repo's own config with our
 * overrides + resource `runArgs` + generic mounts, then shell out to
 * `devcontainer up` and read the containerId back from its JSON result.
 *
 * Secrets are deliberately NOT baked into the on-disk config — env secrets are
 * injected per-exec by the sandbox, and file secrets are written into the
 * container after it is ready. Nothing sensitive ever hits the workspace disk.
 *
 * The pure pieces (config merge, resource args, argv builders, output parsing)
 * are exported and unit-tested; `provision()` just sequences them.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateEnvironmentRequest, MountSpec, ResourceLimits } from '@devspace/contracts';
import type { CommandRunner } from './cli.js';
import { runOrThrow } from './cli.js';
import type { SandboxHardening } from './hardening.js';
import {
  DEMO_HARDENING,
  dockerNetworkCreateArgs,
  dockerNetworkRmArgs,
  hardeningRunArgs,
  ownsNetworkLifecycle,
  proxyContainerEnv,
  resolveNetworkName,
} from './hardening.js';

/** A JSON-ish devcontainer.json shape — we only touch a few known keys. */
export type DevcontainerConfig = Record<string, unknown> & {
  image?: string;
  dockerFile?: string;
  dockerComposeFile?: unknown;
  runArgs?: string[];
  mounts?: string[];
  containerEnv?: Record<string, string>;
};

/** Hard cap on process count — a cheap first line of defense vs fork bombs. */
export const DEFAULT_PIDS_LIMIT = 4096;

/**
 * Map resource limits to `docker run` flags injected via devcontainer
 * `runArgs`. cpu and memory are reliably enforced by cgroups on any driver;
 * diskMB is intentionally omitted because `--storage-opt size=` only works on
 * a subset of storage drivers (xfs+pquota) and errors out on plain overlay2.
 * Disk quota is revisited under M5 hardening.
 */
export function resourceRunArgs(
  resources: ResourceLimits,
  pidsLimit = DEFAULT_PIDS_LIMIT,
): string[] {
  return [`--cpus=${resources.cpu}`, `--memory=${resources.memMB}m`, `--pids-limit=${pidsLimit}`];
}

/** Map generic mounts to devcontainer.json `mounts` string entries. */
export function mountConfigEntries(mounts: readonly MountSpec[]): string[] {
  return mounts.map((m) => {
    const type = m.source.startsWith('/') ? 'bind' : 'volume';
    const parts = [`type=${type}`, `source=${m.source}`, `target=${m.target}`];
    if (m.ro) parts.push('readonly');
    return parts.join(',');
  });
}

/**
 * Merge the repo's devcontainer.json with our overrides and injected
 * runArgs/mounts. `override` wins over the repo config; our resource runArgs,
 * hardening runArgs, and generic mounts are appended so they never clobber
 * what the repo/override set. `containerEnv` is the one exception to the
 * append rule: our entries (the egress proxy vars) MERGE OVER the repo's —
 * they are policy, and a repo config must not be able to unset them.
 */
export function mergeDevcontainerConfig(input: {
  repoConfig?: DevcontainerConfig;
  override?: Record<string, unknown>;
  baseImage?: string;
  resources: ResourceLimits;
  mounts: readonly MountSpec[];
  /** Host hardening profile (m5-plan Decision 1); omitted = demo mode. */
  hardening?: SandboxHardening;
  /** Resolved network for this env (per-env profiles resolve by envId). */
  networkName?: string;
  /** Policy env for every in-container process (e.g. egress proxy vars). */
  containerEnv?: Record<string, string>;
}): DevcontainerConfig {
  const base: DevcontainerConfig = { ...input.repoConfig, ...input.override };

  // Only default an image when nothing else defines the build source.
  if (!base.image && !base.dockerFile && !base.dockerComposeFile && input.baseImage) {
    base.image = input.baseImage;
  }

  const runArgs = [
    ...(base.runArgs ?? []),
    ...resourceRunArgs(input.resources),
    ...(input.hardening
      ? hardeningRunArgs(input.hardening, {
          diskMB: input.resources.diskMB,
          networkName: input.networkName,
        })
      : []),
  ];
  const mounts = [...(base.mounts ?? []), ...mountConfigEntries(input.mounts)];
  const containerEnv = { ...base.containerEnv, ...input.containerEnv };
  return {
    ...base,
    runArgs,
    mounts,
    ...(Object.keys(containerEnv).length > 0 ? { containerEnv } : {}),
  };
}

export function buildGitCloneArgs(repoUrl: string, dest: string, ref?: string): string[] {
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push('--', repoUrl, dest);
  return args;
}

export function buildDevcontainerUpArgs(input: {
  workspaceFolder: string;
  configPath: string;
  idLabel: string;
}): string[] {
  return [
    'up',
    '--workspace-folder',
    input.workspaceFolder,
    '--config',
    input.configPath,
    '--id-label',
    input.idLabel,
  ];
}

export interface DevcontainerUpResult {
  outcome: string;
  containerId: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
}

/**
 * `devcontainer up` emits progress on stderr and a single JSON result object on
 * stdout. Scan from the last line for a JSON object carrying `outcome`.
 */
export function parseDevcontainerUpOutput(stdout: string): DevcontainerUpResult {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Partial<DevcontainerUpResult>;
      if (parsed.outcome) {
        if (parsed.outcome !== 'success' || !parsed.containerId) {
          throw new Error(`devcontainer up failed: ${line}`);
        }
        return parsed as DevcontainerUpResult;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('devcontainer up failed')) throw err;
      // not JSON — keep scanning
    }
  }
  throw new Error('could not parse a devcontainer up result from output');
}

export interface ProvisionResult {
  containerId: string;
  workspaceFolder: string;
  remoteUser?: string;
  /** Per-env network created for this env (owner: sandbox teardown). */
  networkName?: string;
}

export interface Provisioner {
  provision(envId: string, req: CreateEnvironmentRequest): Promise<ProvisionResult>;
}

export interface DevcontainerProvisionerOptions {
  devcontainerPath?: string;
  gitPath?: string;
  dockerPath?: string;
  /** Root under which per-env workspaces are created. */
  workspaceRoot?: string;
  /** Timeout for the (potentially slow) `devcontainer up`. */
  upTimeoutMs?: number;
  /**
   * Host isolation policy applied to EVERY env (m5-plan Decision 1). Defaults
   * to demo mode (plain Docker); production boots pass a hardened profile.
   */
  hardening?: SandboxHardening;
}

/** Provisions containers via `git` + `devcontainers/cli`. */
export class DevcontainerProvisioner implements Provisioner {
  private readonly devcontainer: string;
  private readonly git: string;
  private readonly docker: string;
  private readonly workspaceRoot: string;
  private readonly upTimeoutMs: number;
  private readonly hardening: SandboxHardening;

  constructor(
    private readonly runner: CommandRunner,
    options: DevcontainerProvisionerOptions = {},
  ) {
    this.devcontainer = options.devcontainerPath ?? 'devcontainer';
    this.git = options.gitPath ?? 'git';
    this.docker = options.dockerPath ?? 'docker';
    this.workspaceRoot = options.workspaceRoot ?? tmpdir();
    this.upTimeoutMs = options.upTimeoutMs ?? 10 * 60 * 1000;
    this.hardening = options.hardening ?? DEMO_HARDENING;
  }

  async provision(envId: string, req: CreateEnvironmentRequest): Promise<ProvisionResult> {
    const workspaceFolder = await mkdtemp(join(this.workspaceRoot, `devspace-${sanitize(envId)}-`));
    const networkName = resolveNetworkName(this.hardening, envId);
    let createdNetwork = false;
    try {
      if (req.repoUrl) {
        await runOrThrow(
          this.runner,
          this.git,
          buildGitCloneArgs(req.repoUrl, workspaceFolder, req.ref),
        );
      }

      // Per-env isolated network before `up` — no route out, no env↔env.
      if (networkName && ownsNetworkLifecycle(this.hardening)) {
        await runOrThrow(
          this.runner,
          this.docker,
          dockerNetworkCreateArgs(networkName, { internal: true }),
        );
        createdNetwork = true;
      }

      const config = mergeDevcontainerConfig({
        override: req.devcontainerOverride,
        baseImage: req.baseImage,
        resources: req.resources,
        mounts: req.mounts,
        hardening: this.hardening,
        networkName,
        containerEnv: this.hardening.egressProxyUrl
          ? proxyContainerEnv(this.hardening.egressProxyUrl)
          : undefined,
      });

      // Write our synthesized config to a sibling path and point `--config` at
      // it, so we never overwrite a repo's own .devcontainer/devcontainer.json.
      const configDir = join(workspaceFolder, '.devspace');
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, 'devcontainer.json');
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

      const result = await runOrThrow(
        this.runner,
        this.devcontainer,
        buildDevcontainerUpArgs({
          workspaceFolder,
          configPath,
          idLabel: `devspace.envId=${envId}`,
        }),
        { timeoutMs: this.upTimeoutMs },
      );
      const parsed = parseDevcontainerUpOutput(result.stdout);
      return {
        containerId: parsed.containerId,
        workspaceFolder,
        remoteUser: parsed.remoteUser,
        networkName: createdNetwork ? networkName : undefined,
      };
    } catch (err) {
      // Best-effort cleanup of the scratch workspace + network on failure.
      await rm(workspaceFolder, { recursive: true, force: true }).catch(() => {});
      if (createdNetwork && networkName) {
        await this.runner.run(this.docker, dockerNetworkRmArgs(networkName)).catch(() => {});
      }
      throw err;
    }
  }
}

/** Keep envId safe for use in a filesystem path prefix. */
function sanitize(envId: string): string {
  return envId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}
