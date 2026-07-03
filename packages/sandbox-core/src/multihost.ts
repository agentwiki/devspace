/**
 * Multi-host placement (M8, m8-plan workstream C): compose N named
 * `SandboxCore` hosts behind the same interface. Placement is deliberately
 * dumb (Decision 6): fewest live envs wins, ties break in config order,
 * draining and full hosts are skipped. Routing is sticky and in-memory with
 * cold-miss rediscovery (Decision 7): the remote hosts durably ARE the env
 * table, so an orchestrator restart re-learns its fleet lazily by probing
 * `getEnvironment` instead of orphaning live envs.
 */
import type {
  CreateEnvironmentRequest,
  Environment,
  ExecRequest,
  FsEntry,
} from '@devspace/contracts';
import type { ExecStream } from './exec.js';
import { SandboxError } from './sandbox.js';
import type { SandboxCore } from './sandbox.js';

export interface SandboxHost {
  name: string;
  core: SandboxCore;
  /** Max live envs placed on (or adopted by) this host. */
  capacity: number;
  /** A draining host takes no new envs but keeps serving its own. */
  draining?: boolean;
}

/** One parsed `SANDBOX_HOSTS` entry (the `core` is dialed by the boot layer). */
export interface SandboxHostConfig {
  name: string;
  url: string;
  capacity: number;
  draining: boolean;
}

export const DEFAULT_HOST_CAPACITY = 8;

export class MultiHostSandboxCore implements SandboxCore {
  private readonly hosts: SandboxHost[];
  /** envId -> host name; the capacity count is this table grouped by host. */
  private readonly routes = new Map<string, string>();

  constructor(hosts: SandboxHost[]) {
    if (hosts.length === 0) throw new Error('MultiHostSandboxCore needs at least one host');
    const names = new Set(hosts.map((h) => h.name));
    if (names.size !== hosts.length) throw new Error('sandbox host names must be unique');
    this.hosts = hosts.map((h) => ({ ...h }));
  }

  /** Flip a host's drain flag at runtime (placement-only; routing unaffected). */
  setDraining(name: string, draining: boolean): void {
    const host = this.hosts.find((h) => h.name === name);
    if (!host) throw new Error(`no such sandbox host: ${name}`);
    host.draining = draining;
  }

  /** Where an env lives, if this core knows it (introspection/tests). */
  hostOf(envId: string): string | undefined {
    return this.routes.get(envId);
  }

  async createEnvironment(req: CreateEnvironmentRequest): Promise<Environment> {
    const host = this.place();
    const env = await host.core.createEnvironment(req);
    this.routes.set(env.envId, host.name);
    return env;
  }

  async getEnvironment(envId: string): Promise<Environment | null> {
    const host = await this.findHost(envId);
    if (!host) return null;
    return host.core.getEnvironment(envId);
  }

  async destroyEnvironment(envId: string): Promise<void> {
    const host = await this.requireHost(envId);
    try {
      await host.core.destroyEnvironment(envId);
      this.routes.delete(envId);
    } catch (err) {
      // A host that no longer knows the env has nothing left to free either.
      if (err instanceof SandboxError && err.code === 'NOT_FOUND') this.routes.delete(envId);
      throw err;
    }
  }

  async exec(envId: string, req: ExecRequest): Promise<ExecStream> {
    return (await this.requireHost(envId)).core.exec(envId, req);
  }

  async fsRead(envId: string, path: string): Promise<Uint8Array> {
    return (await this.requireHost(envId)).core.fsRead(envId, path);
  }

  async fsWrite(envId: string, path: string, data: Uint8Array, mode?: number): Promise<void> {
    return (await this.requireHost(envId)).core.fsWrite(envId, path, data, mode);
  }

  async fsList(envId: string, path: string): Promise<FsEntry[]> {
    return (await this.requireHost(envId)).core.fsList(envId, path);
  }

  async forwardPort(
    envId: string,
    containerPort: number,
  ): Promise<{ proxyUrl: string; token: string }> {
    return (await this.requireHost(envId)).core.forwardPort(envId, containerPort);
  }

  /* ------------------------------------------------------------------------ */

  /** Least-loaded placement over non-draining hosts with free capacity. */
  private place(): SandboxHost {
    const load = new Map<string, number>();
    for (const name of this.routes.values()) load.set(name, (load.get(name) ?? 0) + 1);

    let best: SandboxHost | undefined;
    let bestLoad = Infinity;
    let anyCapacity = false;
    for (const host of this.hosts) {
      const current = load.get(host.name) ?? 0;
      if (current < host.capacity) anyCapacity = true;
      if (host.draining || current >= host.capacity) continue;
      if (current < bestLoad) {
        best = host;
        bestLoad = current;
      }
    }
    if (best) return best;
    throw new SandboxError(
      'PROVISION_FAILED',
      anyCapacity
        ? 'no sandbox host accepts placements (all non-full hosts are draining)'
        : 'no sandbox host has capacity left',
    );
  }

  /** Resolve an env's host; on a routing miss, probe the fleet and adopt. */
  private async findHost(envId: string): Promise<SandboxHost | undefined> {
    const routed = this.routes.get(envId);
    if (routed) return this.hosts.find((h) => h.name === routed);
    // Cold miss (orchestrator restart): the hosts still hold the containers.
    // First hit wins and becomes sticky; probing is O(hosts), misses only.
    for (const host of this.hosts) {
      const env = await host.core.getEnvironment(envId).catch(() => null);
      if (env) {
        this.routes.set(envId, host.name);
        return host;
      }
    }
    return undefined;
  }

  private async requireHost(envId: string): Promise<SandboxHost> {
    const host = await this.findHost(envId);
    if (!host) throw new SandboxError('NOT_FOUND', `no sandbox host knows environment ${envId}`);
    return host;
  }
}

/**
 * Parse `SANDBOX_HOSTS`: comma-separated `name=url[|capacity][|drain]`.
 * Config errors throw — a fleet with a typo'd host must fail at boot, not
 * place envs onto half a fleet (the hardening fail-fast precedent).
 */
export function parseSandboxHosts(raw: string): SandboxHostConfig[] {
  const hosts: SandboxHostConfig[] = [];
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`SANDBOX_HOSTS entry "${entry}" is not name=url`);
    const name = entry.slice(0, eq).trim();
    const [url, ...flags] = entry
      .slice(eq + 1)
      .split('|')
      .map((s) => s.trim());
    if (!url || !/^https?:\/\//.test(url)) {
      throw new Error(`SANDBOX_HOSTS entry "${name}" needs an http(s) url, got "${url ?? ''}"`);
    }
    let capacity = DEFAULT_HOST_CAPACITY;
    let draining = false;
    for (const flag of flags) {
      if (flag === 'drain') {
        draining = true;
      } else if (/^\d+$/.test(flag) && Number(flag) > 0) {
        capacity = Number(flag);
      } else {
        throw new Error(`SANDBOX_HOSTS entry "${name}": unknown flag "${flag}"`);
      }
    }
    hosts.push({ name, url: url.replace(/\/+$/, ''), capacity, draining });
  }
  if (hosts.length === 0) throw new Error('SANDBOX_HOSTS is set but names no hosts');
  const names = new Set(hosts.map((h) => h.name));
  if (names.size !== hosts.length) throw new Error('SANDBOX_HOSTS names must be unique');
  return hosts;
}

/** Fleet config from the environment; undefined when SANDBOX_HOSTS is unset. */
export function sandboxHostsFromEnv(
  env: Record<string, string | undefined>,
): SandboxHostConfig[] | undefined {
  const raw = env.SANDBOX_HOSTS?.trim();
  if (!raw) return undefined;
  return parseSandboxHosts(raw);
}
