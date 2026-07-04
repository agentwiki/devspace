/**
 * The real SandboxCore: composes a Provisioner (create) and a ContainerRuntime
 * (exec/destroy/liveness) and layers fs operations on top of the exec
 * primitive. It is agent-agnostic — it knows nothing of ACP, agents, or chat;
 * mounting an agent runtime is just another entry in `req.mounts`.
 *
 * Both collaborators are injected, so the whole lifecycle is unit-tested with a
 * fake runtime + provisioner (no Docker daemon). The default constructor wires
 * the real docker/devcontainer-backed implementations.
 */
import { randomUUID } from 'node:crypto';
import type {
  CreateEnvironmentRequest,
  Environment,
  ExecRequest,
  FsEntry,
  SecretSpec,
} from '@devspace/contracts';
import { CreateEnvironmentRequestSchema } from '@devspace/contracts';
import { nodeCommandRunner, runOrThrow } from './cli.js';
import type { CommandRunner } from './cli.js';
import type { EnvStateStore, PersistedEnvState } from './env-state.js';
import { captureExec } from './exec.js';
import type { ExecStream } from './exec.js';
import type { SandboxHardening } from './hardening.js';
import {
  DevcontainerProvisioner,
  GIT_REFRESH_RESET_ARGS,
  buildGitRefreshArgs,
} from './provision.js';
import type { Provisioner } from './provision.js';
import { DockerRuntime } from './runtime.js';
import type { ContainerRuntime } from './runtime.js';
import type { PreviewRegistrar } from './preview-proxy.js';

/** Typed error carrying one of the contract ErrorCodes. */
export class SandboxError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'PROVISION_FAILED' | 'EXEC_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

interface EnvRecord {
  env: Environment;
  containerId?: string;
  /** Per-env network created at provision time (removed on teardown). */
  networkName?: string;
  /** Resolved env-target secrets, injected into every exec (never logged). */
  secretEnv: Record<string, string>;
  /** Host-side workspace + clone source, kept for claim-time refresh (M10). */
  workspaceFolder?: string;
  repoUrl?: string;
  ref?: string;
}

export interface SandboxCoreDeps {
  runtime: ContainerRuntime;
  provisioner: Provisioner;
  /** Preview ingress (M6). `forwardPort` rejects clearly when absent. */
  preview: PreviewRegistrar;
}

export interface SandboxCore {
  createEnvironment(req: CreateEnvironmentRequest): Promise<Environment>;
  getEnvironment(envId: string): Promise<Environment | null>;
  /** Every environment this core knows (M9 — the census/ops read). */
  listEnvironments(): Promise<Environment[]>;
  /** Attach secrets to a LIVE environment (M9 — the warm-claim seam). */
  applySecrets(envId: string, secrets: SecretSpec[]): Promise<void>;
  /**
   * Hand a pool-owned env to a tenant (M10): the owning host freshens the
   * workspace clone and clears the pool mark. CONFLICT unless the env is
   * ready AND carries a poolKey — the mark is the capability (m10-plan
   * Decision 3); a refresh failure is EXEC_FAILED and the caller destroys.
   */
  claimEnvironment(envId: string): Promise<Environment>;
  destroyEnvironment(envId: string): Promise<void>;
  exec(envId: string, req: ExecRequest): Promise<ExecStream>;
  fsRead(envId: string, path: string): Promise<Uint8Array>;
  fsWrite(envId: string, path: string, data: Uint8Array, mode?: number): Promise<void>;
  fsList(envId: string, path: string): Promise<FsEntry[]>;
  forwardPort(envId: string, containerPort: number): Promise<{ proxyUrl: string; token: string }>;
}

export class DevcontainerSandboxCore implements SandboxCore {
  private readonly runtime: ContainerRuntime;
  private readonly provisioner: Provisioner;
  private readonly preview?: PreviewRegistrar;
  private readonly envs = new Map<string, EnvRecord>();
  /** Host-side git for the claim-time refresh (M10) — never in-container. */
  private readonly runner: CommandRunner;
  private readonly git: string;

  /** Host-side cap on live envs (M9, m9-plan Decision 3); undefined = uncapped. */
  private readonly maxEnvs?: number;

  /** Durable env table (M11); absent = the documented in-memory posture. */
  private readonly stateStore?: EnvStateStore;

  constructor(
    deps?: Partial<SandboxCoreDeps> & {
      runner?: CommandRunner;
      hardening?: SandboxHardening;
      maxEnvs?: number;
      gitPath?: string;
      stateStore?: EnvStateStore;
    },
  ) {
    const runner = deps?.runner ?? nodeCommandRunner;
    this.runner = runner;
    this.git = deps?.gitPath ?? 'git';
    this.runtime = deps?.runtime ?? new DockerRuntime(runner);
    this.provisioner =
      deps?.provisioner ?? new DevcontainerProvisioner(runner, { hardening: deps?.hardening });
    this.preview = deps?.preview;
    this.maxEnvs = deps?.maxEnvs;
    this.stateStore = deps?.stateStore;
  }

  async createEnvironment(input: CreateEnvironmentRequest): Promise<Environment> {
    // Re-validate to apply schema defaults (resources/mounts/secrets) even if a
    // caller hands us a partially-populated object.
    const req = CreateEnvironmentRequestSchema.parse(input);
    // The host-side backstop for a mis-counting (freshly restarted) placement
    // layer: live envs, not records — stopped/failed history never blocks.
    if (this.maxEnvs !== undefined) {
      const live = [...this.envs.values()].filter(
        (r) => r.env.status === 'provisioning' || r.env.status === 'ready',
      ).length;
      if (live >= this.maxEnvs) {
        throw new SandboxError(
          'PROVISION_FAILED',
          `host at capacity (${live}/${this.maxEnvs} live environments)`,
        );
      }
    }
    const envId = `env_${randomUUID()}`;
    const record: EnvRecord = {
      env: {
        envId,
        status: 'provisioning',
        ports: [],
        createdAt: new Date().toISOString(),
        ...(req.poolKey ? { poolKey: req.poolKey } : {}),
      },
      secretEnv: envSecrets(req.secrets),
      repoUrl: req.repoUrl,
      ref: req.ref,
    };
    this.envs.set(envId, record);
    if (this.stateStore) {
      try {
        await this.stateStore.save(persistedState(record));
      } catch (err) {
        record.env = { ...record.env, status: 'failed' };
        throw new SandboxError(
          'PROVISION_FAILED',
          `failed to persist ${envId}: ${errMessage(err)}`,
        );
      }
    }

    try {
      const { containerId, networkName, workspaceFolder } = await this.provisioner.provision(
        envId,
        req,
      );
      record.containerId = containerId;
      record.networkName = networkName;
      record.workspaceFolder = workspaceFolder;
      record.env = { ...record.env, status: 'ready', containerId };
      if (this.stateStore) {
        try {
          await this.stateStore.save(persistedState(record));
        } catch (err) {
          // A durable host must not serve an env it will forget (m11-plan
          // Decision 5) — destroy rather than hand out.
          await this.runtime.destroy(containerId).catch(() => {});
          if (networkName) await this.runtime.removeNetwork?.(networkName).catch(() => {});
          record.containerId = undefined;
          record.networkName = undefined;
          throw new Error(`failed to persist env state: ${errMessage(err)}`);
        }
      }
      // File-target secrets land inside the container only after it is ready,
      // so nothing sensitive ever touches the workspace on disk.
      await this.writeFileSecrets(envId, req.secrets);
      return record.env;
    } catch (err) {
      record.env = { ...record.env, status: 'failed' };
      // A failed env must not be re-adopted at the next boot.
      await this.stateStore?.remove(envId).catch(() => {});
      throw new SandboxError(
        'PROVISION_FAILED',
        `failed to provision ${envId}: ${errMessage(err)}`,
      );
    }
  }

  getEnvironment(envId: string): Promise<Environment | null> {
    return Promise.resolve(this.envs.get(envId)?.env ?? null);
  }

  listEnvironments(): Promise<Environment[]> {
    return Promise.resolve([...this.envs.values()].map((r) => r.env));
  }

  /**
   * Late-bound secrets (M9, m9-plan Decision 4), preserving the M1 discipline:
   * env-target values merge into the per-exec injection map (never baked into
   * the container config), file-target values land 0600 via the exec-based fs
   * path. File paths are validated BEFORE anything applies, so a bad spec
   * cannot leave the env half-secreted.
   */
  async applySecrets(envId: string, secrets: SecretSpec[]): Promise<void> {
    const record = this.requireReady(envId);
    for (const secret of secrets) {
      if (secret.target === 'file' && !secret.path) {
        throw new SandboxError('EXEC_FAILED', `file secret ${secret.name} is missing a path`);
      }
    }
    for (const secret of secrets) {
      if (secret.target === 'env') record.secretEnv[secret.name] = secret.value;
    }
    await this.writeFileSecrets(envId, secrets);
  }

  /**
   * Claim-time refresh + unmark, in one host operation (M10, m10-plan
   * Decision 2): freshen the workspace clone with the same host-side git
   * (and credentials) the fill-time clone used, then clear the pool mark.
   * The mark is the capability — an env without one refuses with CONFLICT,
   * so a buggy pool can never hard-reset a tenant's workspace.
   */
  async claimEnvironment(envId: string): Promise<Environment> {
    const record = this.requireReady(envId);
    if (!record.env.poolKey) {
      throw new SandboxError('CONFLICT', `environment ${envId} is not pool-owned`);
    }
    if (record.repoUrl && record.workspaceFolder) {
      try {
        const cwd = record.workspaceFolder;
        await runOrThrow(this.runner, this.git, buildGitRefreshArgs(record.ref), { cwd });
        await runOrThrow(this.runner, this.git, [...GIT_REFRESH_RESET_ARGS], { cwd });
      } catch (err) {
        // Still pool-owned and intact — the claimer destroys and goes cold.
        throw new SandboxError(
          'EXEC_FAILED',
          `claim refresh of ${envId} failed: ${errMessage(err)}`,
        );
      }
    }
    const { poolKey: _poolKey, ...claimed } = record.env;
    // Persist the unmark BEFORE applying it in memory: a claim the durable
    // table forgot would resurrect the pool mark at the next restart and let
    // the orphan sweep hard-reset a TENANT workspace (m11-plan Decision 5).
    // On failure nothing moved — memory and disk still agree the env is
    // pool-owned, and the claimer destroys and goes cold.
    if (this.stateStore) {
      try {
        await this.stateStore.save(persistedState({ ...record, env: claimed }));
      } catch (err) {
        throw new SandboxError(
          'EXEC_FAILED',
          `claim of ${envId} failed to persist: ${errMessage(err)}`,
        );
      }
    }
    record.env = claimed;
    return record.env;
  }

  async destroyEnvironment(envId: string): Promise<void> {
    const record = this.envs.get(envId);
    if (!record) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
    record.env = { ...record.env, status: 'stopping' };
    // Best-effort: an interrupted destroy must not be re-adopted as ready at
    // the next boot — recovery completes it instead (m11-plan Decision 4).
    if (this.stateStore) await this.stateStore.save(persistedState(record)).catch(() => {});
    // No preview URL survives its env (m6-plan Decision 5).
    this.preview?.revokeEnv(envId);
    if (record.containerId) {
      await this.runtime.destroy(record.containerId);
    }
    // The per-env network outlives its only container by a moment; removal is
    // best-effort (a racing daemon cleanup may have taken it already).
    if (record.networkName) {
      await this.runtime.removeNetwork?.(record.networkName).catch(() => {});
      record.networkName = undefined;
    }
    record.env = { ...record.env, status: 'stopped', containerId: undefined };
    // Best-effort: a leftover file for a dead container is dropped at recovery.
    if (this.stateStore) await this.stateStore.remove(envId).catch(() => {});
  }

  /**
   * Boot-time recovery (M11): re-adopt what the durable table remembers,
   * trusting the daemon over the file (m11-plan Decision 4). Only a `ready`
   * record whose container still exists comes back — with an EMPTY per-exec
   * secret map (secrets are never on host disk; the control plane re-attaches
   * via `applySecrets`) and empty `ports` (preview routes are in-memory
   * capabilities). Anything else is a crashed transition: best-effort destroy
   * of container + per-env network, and the record is dropped. Corrupt state
   * files are reported in `skipped`, never fatal. No-op without a store.
   */
  async recover(): Promise<{ recovered: string[]; discarded: string[]; skipped: string[] }> {
    const summary = {
      recovered: [] as string[],
      discarded: [] as string[],
      skipped: [] as string[],
    };
    if (!this.stateStore) return summary;
    const { states, skipped } = await this.stateStore.loadAll();
    summary.skipped = skipped;
    for (const state of states) {
      if (this.envs.has(state.envId)) continue;
      const alive = state.containerId ? await this.runtime.exists(state.containerId) : false;
      if (state.status === 'ready' && alive) {
        this.envs.set(state.envId, {
          env: {
            envId: state.envId,
            status: 'ready',
            containerId: state.containerId,
            ports: [],
            createdAt: state.createdAt,
            ...(state.poolKey ? { poolKey: state.poolKey } : {}),
          },
          containerId: state.containerId,
          networkName: state.networkName,
          secretEnv: {},
          workspaceFolder: state.workspaceFolder,
          repoUrl: state.repoUrl,
          ref: state.ref,
        });
        summary.recovered.push(state.envId);
      } else {
        if (alive) await this.runtime.destroy(state.containerId!).catch(() => {});
        if (state.networkName) {
          await this.runtime.removeNetwork?.(state.networkName).catch(() => {});
        }
        await this.stateStore.remove(state.envId).catch(() => {});
        summary.discarded.push(state.envId);
      }
    }
    return summary;
  }

  // `async` so a failed env lookup rejects the promise rather than throwing synchronously.
  async exec(envId: string, req: ExecRequest): Promise<ExecStream> {
    const record = this.requireReady(envId);
    // Secrets first so an explicit req.env can still override for a one-off call.
    const env = { ...record.secretEnv, ...(req.env ?? {}) };
    return this.runtime.execStream(record.containerId!, { ...req, env });
  }

  async fsRead(envId: string, path: string): Promise<Uint8Array> {
    const { code, stdout, stderr } = await this.capture(envId, ['cat', '--', path]);
    if (code !== 0)
      throw new SandboxError('EXEC_FAILED', `fsRead(${path}) failed: ${stderr.toString().trim()}`);
    return new Uint8Array(stdout);
  }

  async fsWrite(envId: string, path: string, data: Uint8Array, mode?: number): Promise<void> {
    const containerId = this.requireReady(envId).containerId!;
    // `sh -c 'cat > "$1"' sh <path>` streams stdin straight to the target file,
    // preserving arbitrary bytes and honoring backpressure on large writes.
    const stream = this.runtime.execStream(containerId, {
      cmd: ['sh', '-c', 'cat > "$1"', 'sh', path],
      tty: false,
    });
    await pumpStdin(stream, data);
    const code = await stream.done;
    if (code !== 0) throw new SandboxError('EXEC_FAILED', `fsWrite(${path}) exited ${code}`);
    if (mode !== undefined) {
      const chmod = await this.capture(envId, ['chmod', mode.toString(8), '--', path]);
      if (chmod.code !== 0) {
        throw new SandboxError(
          'EXEC_FAILED',
          `chmod(${path}) failed: ${chmod.stderr.toString().trim()}`,
        );
      }
    }
  }

  async fsList(envId: string, path: string): Promise<FsEntry[]> {
    // GNU find gives us name/type/size in one shot without fragile ls parsing.
    const { code, stdout, stderr } = await this.capture(envId, [
      'find',
      path,
      '-maxdepth',
      '1',
      '-mindepth',
      '1',
      '-printf',
      '%f\t%y\t%s\n',
    ]);
    if (code !== 0)
      throw new SandboxError('EXEC_FAILED', `fsList(${path}) failed: ${stderr.toString().trim()}`);
    return parseFindOutput(stdout.toString());
  }

  /**
   * Expose a container port through the preview proxy (M6): resolve the
   * container's host-reachable IP (the per-env network when hardening created
   * one), register a capability-token route, and record the mapping on the
   * environment. Idempotent per port — re-forwarding returns the live route.
   */
  async forwardPort(
    envId: string,
    containerPort: number,
  ): Promise<{ proxyUrl: string; token: string }> {
    const record = this.requireReady(envId);
    if (!this.preview) {
      throw new SandboxError(
        'EXEC_FAILED',
        'preview proxy not configured (set PREVIEW_PROXY_PORT)',
      );
    }
    const existing = record.env.ports.find((p) => p.containerPort === containerPort);
    if (existing) return { proxyUrl: existing.proxyUrl, token: existing.token };

    const ip = await this.runtime.containerIp?.(record.containerId!, record.networkName);
    if (!ip) {
      throw new SandboxError('EXEC_FAILED', `no host-reachable address for ${envId}`);
    }
    const route = this.preview.register(envId, { host: ip, port: containerPort });
    record.env = {
      ...record.env,
      ports: [...record.env.ports, { containerPort, proxyUrl: route.proxyUrl, token: route.token }],
    };
    return { proxyUrl: route.proxyUrl, token: route.token };
  }

  private requireReady(envId: string): EnvRecord {
    const record = this.envs.get(envId);
    if (!record) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
    if (record.env.status !== 'ready' || !record.containerId) {
      throw new SandboxError(
        'CONFLICT',
        `environment ${envId} is not ready (status=${record.env.status})`,
      );
    }
    return record;
  }

  private capture(envId: string, cmd: string[]): ReturnType<typeof captureExec> {
    const record = this.requireReady(envId);
    const env = { ...record.secretEnv };
    return captureExec(this.runtime.execStream(record.containerId!, { cmd, env, tty: false }));
  }

  private async writeFileSecrets(envId: string, secrets: readonly SecretSpec[]): Promise<void> {
    for (const secret of secrets) {
      if (secret.target !== 'file') continue;
      if (!secret.path)
        throw new SandboxError('EXEC_FAILED', `file secret ${secret.name} is missing a path`);
      await this.fsWrite(envId, secret.path, new TextEncoder().encode(secret.value), 0o600);
    }
  }
}

/**
 * Host-side env cap from the environment (`SANDBOX_MAX_ENVS`); undefined when
 * unset. Config errors throw — a typo'd cap must fail at boot, not silently
 * run uncapped (the hardening fail-fast precedent).
 */
export function maxEnvsFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env.SANDBOX_MAX_ENVS?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`SANDBOX_MAX_ENVS must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * The durable slice of an env record (M11): metadata only — `secretEnv` and
 * `ports` (capability tokens) never land on host disk (m11-plan Decision 2).
 */
function persistedState(record: EnvRecord): PersistedEnvState {
  return {
    envId: record.env.envId,
    status: record.env.status,
    createdAt: record.env.createdAt,
    ...(record.containerId ? { containerId: record.containerId } : {}),
    ...(record.networkName ? { networkName: record.networkName } : {}),
    ...(record.workspaceFolder ? { workspaceFolder: record.workspaceFolder } : {}),
    ...(record.repoUrl ? { repoUrl: record.repoUrl } : {}),
    ...(record.ref ? { ref: record.ref } : {}),
    ...(record.env.poolKey ? { poolKey: record.env.poolKey } : {}),
  };
}

/** Collect env-target secrets into a plain map for exec injection. */
function envSecrets(secrets: readonly SecretSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of secrets) if (s.target === 'env') out[s.name] = s.value;
  return out;
}

/** Stream a buffer to a process's stdin, respecting backpressure, then EOF. */
async function pumpStdin(stream: ExecStream, data: Uint8Array): Promise<void> {
  const CHUNK = 64 * 1024;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const ok = stream.writeStdin(data.subarray(offset, offset + CHUNK));
    if (!ok) await stream.drain();
  }
  stream.closeStdin();
}

const TYPE_MAP: Record<string, FsEntry['type']> = { f: 'file', d: 'dir', l: 'symlink' };

/** Parse `find -printf '%f\t%y\t%s\n'` output into FsEntry rows. */
export function parseFindOutput(stdout: string): FsEntry[] {
  const entries: FsEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [name, type, size] = line.split('\t');
    if (name === undefined || type === undefined) continue;
    entries.push({ name, type: TYPE_MAP[type] ?? 'other', size: Number(size ?? 0) || 0 });
  }
  return entries;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
