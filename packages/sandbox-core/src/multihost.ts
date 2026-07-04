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
  /**
   * In-flight placements per host. Provisioning takes minutes, so without a
   * reservation every concurrent create would read the same (stale) load and
   * pile onto one host past its capacity.
   */
  private readonly pending = new Map<string, number>();

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

  /**
   * Boot-time fleet census (M9, m9-plan Decisions 1–2): adopt every live env
   * on every reachable host so a restart never zeroes counted load until lazy
   * re-adoption. A down host is reported, not fatal — cold-miss rediscovery
   * still covers whatever it holds once it returns.
   */
  async adoptFleet(): Promise<{ adopted: number; failures: { host: string; error: string }[] }> {
    let adopted = 0;
    const failures: { host: string; error: string }[] = [];
    for (const host of this.hosts) {
      try {
        for (const env of await host.core.listEnvironments()) {
          if (this.adopt(env, host.name)) adopted++;
        }
      } catch (err) {
        failures.push({ host: host.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { adopted, failures };
  }

  async createEnvironment(req: CreateEnvironmentRequest): Promise<Environment> {
    const host = this.place();
    this.pending.set(host.name, (this.pending.get(host.name) ?? 0) + 1);
    try {
      const env = await host.core.createEnvironment(req);
      this.routes.set(env.envId, host.name);
      return env;
    } finally {
      const left = (this.pending.get(host.name) ?? 1) - 1;
      if (left > 0) this.pending.set(host.name, left);
      else this.pending.delete(host.name);
    }
  }

  async getEnvironment(envId: string): Promise<Environment | null> {
    const routed = this.routes.get(envId);
    if (routed) {
      const host = this.hosts.find((h) => h.name === routed)!;
      const env = await host.core.getEnvironment(envId);
      if (env) return env;
      // The owning host no longer knows the env (wiped/restarted): evict the
      // route so a phantom entry does not inflate that host's load forever.
      // Ids are host-generated — the env cannot have moved, so answer null.
      this.routes.delete(envId);
      return null;
    }
    const host = await this.probe(envId);
    if (!host) return null;
    return host.core.getEnvironment(envId);
  }

  /**
   * The whole fleet's env table. Strict on purpose: a down host surfaces as
   * an error, never as an empty list — "everything is fine" must not be a
   * lie. Live envs are adopted into the routing table as they are read.
   */
  async listEnvironments(): Promise<Environment[]> {
    const all: Environment[] = [];
    for (const host of this.hosts) {
      for (const env of await host.core.listEnvironments()) {
        this.adopt(env, host.name);
        all.push(env);
      }
    }
    return all;
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

  /**
   * Route a listed env to its host if it should occupy a placement slot.
   * Only live envs count — a stopped/failed record must not eat capacity —
   * and an existing route wins (ids are host-generated, so a conflict cannot
   * arise from this codebase; first-hit-sticky keeps behavior deterministic).
   */
  private adopt(env: Environment, hostName: string): boolean {
    if (env.status !== 'provisioning' && env.status !== 'ready') return false;
    if (this.routes.has(env.envId)) return false;
    this.routes.set(env.envId, hostName);
    return true;
  }

  /** Least-loaded placement over non-draining hosts with free capacity. */
  private place(): SandboxHost {
    const load = new Map<string, number>(this.pending);
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
    return this.probe(envId);
  }

  /**
   * Cold miss (orchestrator restart): the hosts still hold the containers.
   * First hit wins and becomes sticky; probing is O(hosts), misses only. A
   * probe FAILURE is not a miss — treating an unreachable host as "doesn't
   * have it" would turn a transient blip into NOT_FOUND for a live env, so if
   * nothing answered positively and anything errored, the error surfaces.
   */
  private async probe(envId: string): Promise<SandboxHost | undefined> {
    const failed: string[] = [];
    let firstError: unknown;
    for (const host of this.hosts) {
      try {
        const env = await host.core.getEnvironment(envId);
        if (env) {
          this.routes.set(envId, host.name);
          return host;
        }
      } catch (err) {
        failed.push(host.name);
        firstError ??= err;
      }
    }
    if (failed.length > 0) {
      const message = firstError instanceof Error ? firstError.message : String(firstError);
      throw new SandboxError(
        'EXEC_FAILED',
        `fleet probe for ${envId} failed on ${failed.join(', ')}: ${message}`,
      );
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
