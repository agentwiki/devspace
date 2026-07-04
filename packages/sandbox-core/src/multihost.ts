/**
 * Multi-host placement (M8, m8-plan workstream C; weighted in M12): compose N
 * named `SandboxCore` hosts behind the same interface. Placement admission is
 * fit-checked per dimension — an env-count slot (the M8/M9 backstop) plus,
 * when a host declares cpu/memory budgets, room for the request's grant —
 * and ranking is least fractional utilization (m12-plan Decisions 4–5), ties
 * in config order, draining and unfit hosts skipped. Routing is sticky and
 * in-memory with cold-miss rediscovery (M8 Decision 7): the remote hosts
 * durably ARE the env table, so an orchestrator restart re-learns its fleet
 * lazily by probing `getEnvironment` instead of orphaning live envs.
 */
import type {
  CreateEnvironmentRequest,
  Environment,
  ExecRequest,
  FsEntry,
  SecretSpec,
} from '@devspace/contracts';
import { CreateEnvironmentRequestSchema, ResourceLimitsSchema } from '@devspace/contracts';
import type { ExecStream } from './exec.js';
import { SandboxError } from './sandbox.js';
import type { SandboxCore } from './sandbox.js';

export interface SandboxHost {
  name: string;
  core: SandboxCore;
  /** Max live envs placed on (or adopted by) this host. */
  capacity: number;
  /** Cpu budget in cores (M12); undefined = no cpu fit-check on this host. */
  cpu?: number;
  /** Memory budget in MB (M12); undefined = no memory fit-check. */
  memMB?: number;
  /** A draining host takes no new envs but keeps serving its own. */
  draining?: boolean;
}

/** One parsed `SANDBOX_HOSTS` entry (the `core` is dialed by the boot layer). */
export interface SandboxHostConfig {
  name: string;
  url: string;
  capacity: number;
  cpu?: number;
  memMB?: number;
  draining: boolean;
}

export const DEFAULT_HOST_CAPACITY = 8;

/** The resource footprint an env (or in-flight placement) occupies. */
interface EnvWeight {
  cpu: number;
  memMB: number;
}

/** A host's occupied load: the env count plus the summed weights. */
interface HostLoad {
  count: number;
  cpu: number;
  memMB: number;
}

/**
 * What an echo-less env weighs (m12-plan Decision 2): the contract defaults —
 * the same values a pre-M12 host's provisioner actually applied when the
 * request omitted resources.
 */
const DEFAULT_ENV_WEIGHT: EnvWeight = (() => {
  const { cpu, memMB } = ResourceLimitsSchema.parse({});
  return { cpu, memMB };
})();

function weightOf(env: Environment): EnvWeight {
  const grant = env.resources ?? DEFAULT_ENV_WEIGHT;
  return { cpu: grant.cpu, memMB: grant.memMB };
}

export class MultiHostSandboxCore implements SandboxCore {
  private readonly hosts: SandboxHost[];
  /**
   * envId -> owning host + the weight it occupies there; a host's counted
   * load is this table grouped by host. The weight lives on the route so
   * eviction/destroy free it exactly when they free the slot (m12-plan
   * Decision 7) — no second table to drift.
   */
  private readonly routes = new Map<string, { host: string; weight: EnvWeight }>();
  /**
   * In-flight placements per host. Provisioning takes minutes, so without a
   * reservation every concurrent create would read the same (stale) load and
   * pile onto one host past its capacity — or, since M12, past a budget
   * (m12-plan Decision 6).
   */
  private readonly pending = new Map<string, HostLoad>();

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
    return this.routes.get(envId)?.host;
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
    // Parse for the schema defaults: the request's grant IS the placement
    // weight (m12-plan Decision 1), known before any container exists.
    const parsed = CreateEnvironmentRequestSchema.parse(req);
    const weight: EnvWeight = { cpu: parsed.resources.cpu, memMB: parsed.resources.memMB };
    const host = this.place(weight);
    this.reserve(host.name, weight);
    try {
      const env = await host.core.createEnvironment(parsed);
      // Prefer the host's echo (what it actually granted); our own hosts echo
      // the parsed request back, so this only differs across version skew.
      this.routes.set(env.envId, {
        host: host.name,
        weight: env.resources ? weightOf(env) : weight,
      });
      return env;
    } finally {
      this.release(host.name, weight);
    }
  }

  async getEnvironment(envId: string): Promise<Environment | null> {
    const routed = this.routes.get(envId)?.host;
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

  async applySecrets(envId: string, secrets: SecretSpec[]): Promise<void> {
    return (await this.requireHost(envId)).core.applySecrets(envId, secrets);
  }

  async claimEnvironment(envId: string): Promise<Environment> {
    return (await this.requireHost(envId)).core.claimEnvironment(envId);
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
   * The env's echoed grant becomes its counted weight (defaults when a
   * pre-M12 host echoes nothing).
   */
  private adopt(env: Environment, hostName: string): boolean {
    if (env.status !== 'provisioning' && env.status !== 'ready') return false;
    if (this.routes.has(env.envId)) return false;
    this.routes.set(env.envId, { host: hostName, weight: weightOf(env) });
    return true;
  }

  /** Reserve an in-flight placement's footprint on a host. */
  private reserve(hostName: string, weight: EnvWeight): void {
    const load = this.pending.get(hostName) ?? { count: 0, cpu: 0, memMB: 0 };
    this.pending.set(hostName, {
      count: load.count + 1,
      cpu: load.cpu + weight.cpu,
      memMB: load.memMB + weight.memMB,
    });
  }

  /** Release an in-flight reservation (the route now carries it, or it failed). */
  private release(hostName: string, weight: EnvWeight): void {
    const load = this.pending.get(hostName);
    if (!load) return;
    if (load.count <= 1) this.pending.delete(hostName);
    else {
      this.pending.set(hostName, {
        count: load.count - 1,
        cpu: load.cpu - weight.cpu,
        memMB: load.memMB - weight.memMB,
      });
    }
  }

  /** Occupied load per host: in-flight reservations + adopted/placed routes. */
  private loads(): Map<string, HostLoad> {
    const loads = new Map<string, HostLoad>();
    for (const [name, load] of this.pending) loads.set(name, { ...load });
    for (const { host, weight } of this.routes.values()) {
      const load = loads.get(host) ?? { count: 0, cpu: 0, memMB: 0 };
      loads.set(host, {
        count: load.count + 1,
        cpu: load.cpu + weight.cpu,
        memMB: load.memMB + weight.memMB,
      });
    }
    return loads;
  }

  /**
   * Weighted least-loaded placement (m12-plan Decisions 4–5). Admission: not
   * draining, an env-count slot free, and the request's grant fits every
   * budget the host declares. Ranking: lowest max-fractional utilization over
   * the host's declared dimensions (count/capacity always; cpu and memory
   * when budgeted — the max keeps a cpu-saturated, memory-empty host from
   * winning on an average). Strict `<` keeps ties in config order. The three
   * refusals stay distinguishable: full, unfit, and draining are different
   * operator problems.
   */
  private place(weight: EnvWeight): SandboxHost {
    const loads = this.loads();
    let best: SandboxHost | undefined;
    let bestScore = Infinity;
    let anySlot = false;
    let anyFit = false;
    for (const host of this.hosts) {
      const load = loads.get(host.name) ?? { count: 0, cpu: 0, memMB: 0 };
      const hasSlot = load.count < host.capacity;
      const fits =
        hasSlot &&
        (host.cpu === undefined || load.cpu + weight.cpu <= host.cpu) &&
        (host.memMB === undefined || load.memMB + weight.memMB <= host.memMB);
      if (hasSlot) anySlot = true;
      if (fits) anyFit = true;
      if (host.draining || !fits) continue;
      const score = Math.max(
        load.count / host.capacity,
        host.cpu === undefined ? 0 : load.cpu / host.cpu,
        host.memMB === undefined ? 0 : load.memMB / host.memMB,
      );
      if (score < bestScore) {
        best = host;
        bestScore = score;
      }
    }
    if (best) return best;
    if (anyFit) {
      throw new SandboxError(
        'PROVISION_FAILED',
        'no sandbox host accepts placements (all non-full hosts are draining)',
      );
    }
    throw new SandboxError(
      'PROVISION_FAILED',
      anySlot
        ? `no sandbox host fits the requested resources (cpu=${weight.cpu}, mem=${weight.memMB}MB)`
        : 'no sandbox host has capacity left',
    );
  }

  /** Resolve an env's host; on a routing miss, probe the fleet and adopt. */
  private async findHost(envId: string): Promise<SandboxHost | undefined> {
    const routed = this.routes.get(envId)?.host;
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
          this.routes.set(envId, { host: host.name, weight: weightOf(env) });
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
 * Parse `SANDBOX_HOSTS`: comma-separated
 * `name=url[|capacity][|cpu=<cores>][|mem=<MB>][|drain]`.
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
    let cpu: number | undefined;
    let memMB: number | undefined;
    let draining = false;
    for (const flag of flags) {
      if (flag === 'drain') {
        draining = true;
      } else if (flag.startsWith('cpu=')) {
        const value = Number(flag.slice(4));
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`SANDBOX_HOSTS entry "${name}": cpu budget must be positive cores`);
        }
        cpu = value;
      } else if (flag.startsWith('mem=')) {
        const value = flag.slice(4);
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          throw new Error(
            `SANDBOX_HOSTS entry "${name}": mem budget must be a positive MB integer`,
          );
        }
        memMB = Number(value);
      } else if (/^\d+$/.test(flag) && Number(flag) > 0) {
        capacity = Number(flag);
      } else {
        throw new Error(`SANDBOX_HOSTS entry "${name}": unknown flag "${flag}"`);
      }
    }
    hosts.push({ name, url: url.replace(/\/+$/, ''), capacity, cpu, memMB, draining });
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
