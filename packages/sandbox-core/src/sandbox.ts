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
import { nodeCommandRunner } from './cli.js';
import type { CommandRunner } from './cli.js';
import { captureExec } from './exec.js';
import type { ExecStream } from './exec.js';
import { DevcontainerProvisioner } from './provision.js';
import type { Provisioner } from './provision.js';
import { DockerRuntime } from './runtime.js';
import type { ContainerRuntime } from './runtime.js';

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
  /** Resolved env-target secrets, injected into every exec (never logged). */
  secretEnv: Record<string, string>;
}

export interface SandboxCoreDeps {
  runtime: ContainerRuntime;
  provisioner: Provisioner;
}

export interface SandboxCore {
  createEnvironment(req: CreateEnvironmentRequest): Promise<Environment>;
  getEnvironment(envId: string): Promise<Environment | null>;
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
  private readonly envs = new Map<string, EnvRecord>();

  constructor(deps?: Partial<SandboxCoreDeps> & { runner?: CommandRunner }) {
    const runner = deps?.runner ?? nodeCommandRunner;
    this.runtime = deps?.runtime ?? new DockerRuntime(runner);
    this.provisioner = deps?.provisioner ?? new DevcontainerProvisioner(runner);
  }

  async createEnvironment(input: CreateEnvironmentRequest): Promise<Environment> {
    // Re-validate to apply schema defaults (resources/mounts/secrets) even if a
    // caller hands us a partially-populated object.
    const req = CreateEnvironmentRequestSchema.parse(input);
    const envId = `env_${randomUUID()}`;
    const record: EnvRecord = {
      env: { envId, status: 'provisioning', ports: [], createdAt: new Date().toISOString() },
      secretEnv: envSecrets(req.secrets),
    };
    this.envs.set(envId, record);

    try {
      const { containerId } = await this.provisioner.provision(envId, req);
      record.containerId = containerId;
      record.env = { ...record.env, status: 'ready', containerId };
      // File-target secrets land inside the container only after it is ready,
      // so nothing sensitive ever touches the workspace on disk.
      await this.writeFileSecrets(envId, req.secrets);
      return record.env;
    } catch (err) {
      record.env = { ...record.env, status: 'failed' };
      throw new SandboxError(
        'PROVISION_FAILED',
        `failed to provision ${envId}: ${errMessage(err)}`,
      );
    }
  }

  getEnvironment(envId: string): Promise<Environment | null> {
    return Promise.resolve(this.envs.get(envId)?.env ?? null);
  }

  async destroyEnvironment(envId: string): Promise<void> {
    const record = this.envs.get(envId);
    if (!record) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
    record.env = { ...record.env, status: 'stopping' };
    if (record.containerId) {
      await this.runtime.destroy(record.containerId);
    }
    record.env = { ...record.env, status: 'stopped', containerId: undefined };
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

  forwardPort(
    _envId: string,
    _containerPort: number,
  ): Promise<{ proxyUrl: string; token: string }> {
    // The ports preview proxy is explicitly out of M1 scope (roadmap: "Out:
    // ports proxy polish"; lands with the M5 preview proxy).
    return Promise.reject(
      new SandboxError('EXEC_FAILED', 'forwardPort is not implemented until M5'),
    );
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
