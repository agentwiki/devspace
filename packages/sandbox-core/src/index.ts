/**
 * @devspace/sandbox-core
 *
 * Agent-agnostic environment engine. Wraps `devcontainers/cli` (`devcontainer
 * up/build/exec`) plus Docker for lifecycle, streaming exec, fs, and ports.
 * It exposes ONLY generic primitives; it has no concept of "agents" or "chat".
 * Mounting an agent runtime is just another `mounts[]` entry to this layer.
 */
import type {
  CreateEnvironmentRequest,
  Environment,
  ExecRequest,
  FsEntry,
} from '@devspace/contracts';
import type { ExecStream } from './exec.js';

export * from './exec.js';

export interface SandboxCore {
  createEnvironment(req: CreateEnvironmentRequest): Promise<Environment>;
  getEnvironment(envId: string): Promise<Environment | null>;
  destroyEnvironment(envId: string): Promise<void>;

  /** The full-duplex primitive that ACP rides on. */
  exec(envId: string, req: ExecRequest): Promise<ExecStream>;

  fsRead(envId: string, path: string): Promise<Uint8Array>;
  fsWrite(envId: string, path: string, data: Uint8Array, mode?: number): Promise<void>;
  fsList(envId: string, path: string): Promise<FsEntry[]>;

  forwardPort(envId: string, containerPort: number): Promise<{ proxyUrl: string; token: string }>;
}

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`sandbox-core.${method} is not implemented yet (lands in M1)`);
    this.name = 'NotImplementedError';
  }
}

/**
 * M0 placeholder. The M1 implementation will shell out to `devcontainer up`
 * and stream `devcontainer exec` over a gRPC/WS bidi channel. Kept as a typed
 * skeleton so dependents compile and wire against the real interface today.
 */
export class DevcontainerSandboxCore implements SandboxCore {
  async createEnvironment(_req: CreateEnvironmentRequest): Promise<Environment> {
    throw new NotImplementedError('createEnvironment');
  }
  async getEnvironment(_envId: string): Promise<Environment | null> {
    throw new NotImplementedError('getEnvironment');
  }
  async destroyEnvironment(_envId: string): Promise<void> {
    throw new NotImplementedError('destroyEnvironment');
  }
  async exec(_envId: string, _req: ExecRequest): Promise<ExecStream> {
    throw new NotImplementedError('exec');
  }
  async fsRead(_envId: string, _path: string): Promise<Uint8Array> {
    throw new NotImplementedError('fsRead');
  }
  async fsWrite(_envId: string, _path: string, _data: Uint8Array, _mode?: number): Promise<void> {
    throw new NotImplementedError('fsWrite');
  }
  async fsList(_envId: string, _path: string): Promise<FsEntry[]> {
    throw new NotImplementedError('fsList');
  }
  async forwardPort(_envId: string, _containerPort: number): Promise<{ proxyUrl: string; token: string }> {
    throw new NotImplementedError('forwardPort');
  }
}
