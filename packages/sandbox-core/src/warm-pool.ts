/**
 * Warm pools (M9, m9-plan workstream C — top-risk #4, cold-start latency).
 * `WarmPoolSandboxCore` wraps ANY inner `SandboxCore` (local, remote, or
 * multi-host — composition, not a mode): configured pools are pre-provisioned
 * in the background, and a `createEnvironment` whose request exactly matches a
 * pool's template claims a warm env — verify, apply the request's secrets,
 * hand out — in milliseconds instead of minutes. Anything else falls through
 * to the cold path unchanged, so a stale template can only ever mean "pool
 * never hits", never "agent runs in the wrong container" (Decision 5).
 */
import type {
  CreateEnvironmentRequest,
  Environment,
  ExecRequest,
  FsEntry,
  SecretSpec,
} from '@devspace/contracts';
import { CreateEnvironmentRequestSchema } from '@devspace/contracts';
import type { ExecStream } from './exec.js';
import type { SandboxCore } from './sandbox.js';

/** One configured pool: a full template request (secrets empty) + target size. */
export interface WarmPoolSpec {
  template: CreateEnvironmentRequest;
  size: number;
}

/** One parsed `SANDBOX_WARM_POOLS` entry (the boot layer builds the template). */
export interface WarmPoolConfig {
  repoUrl: string;
  ref?: string;
  size: number;
}

export interface WarmPoolOptions {
  onLog?: (line: string) => void;
}

interface Pool {
  key: string;
  template: CreateEnvironmentRequest;
  size: number;
  /** Warm envIds ready to claim (FIFO — oldest clone goes first). */
  ready: string[];
  /** Single-flight guard: the one in-flight filler per pool (Decision 7). */
  filling?: Promise<void>;
}

export class WarmPoolSandboxCore implements SandboxCore {
  private readonly pools = new Map<string, Pool>();
  private readonly onLog: (line: string) => void;
  private stopped = false;

  constructor(
    private readonly inner: SandboxCore,
    specs: WarmPoolSpec[],
    opts: WarmPoolOptions = {},
  ) {
    this.onLog = opts.onLog ?? (() => {});
    for (const spec of specs) {
      if (spec.size < 1 || !Number.isInteger(spec.size)) {
        throw new Error(`warm pool size must be a positive integer, got ${spec.size}`);
      }
      const template = CreateEnvironmentRequestSchema.parse(spec.template);
      if (template.secrets.length > 0) {
        // A pooled env is provisioned before its tenant is known; a template
        // carrying secrets is a config error, not something to half-honor.
        throw new Error('warm pool templates must not carry secrets');
      }
      const key = canonicalRequestKey(template);
      if (this.pools.has(key)) throw new Error('duplicate warm pool template');
      this.pools.set(key, { key, template, size: spec.size, ready: [] });
    }
  }

  /** Top up every pool to its size. Never rejects — failures log (Decision 7). */
  async fill(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => this.topUp(pool)));
  }

  /** Destroy still-unclaimed warm envs (clean shutdown; see m9-plan risks). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const pool of this.pools.values()) {
      for (const envId of pool.ready.splice(0)) {
        await this.inner
          .destroyEnvironment(envId)
          .catch((err: unknown) => this.onLog(`stop: destroy ${envId} failed: ${message(err)}`));
      }
    }
  }

  async createEnvironment(req: CreateEnvironmentRequest): Promise<Environment> {
    const parsed = CreateEnvironmentRequestSchema.parse(req);
    const pool = this.pools.get(canonicalRequestKey(parsed));
    if (pool) {
      while (pool.ready.length > 0) {
        const envId = pool.ready.shift()!;
        const claimed = await this.claim(envId, parsed.secrets);
        if (claimed) {
          this.kick(pool);
          return claimed;
        }
      }
      // Empty (or every warm env was dead): go cold, but start refilling now.
      this.kick(pool);
    }
    return this.inner.createEnvironment(parsed);
  }

  getEnvironment(envId: string): Promise<Environment | null> {
    return this.inner.getEnvironment(envId);
  }

  listEnvironments(): Promise<Environment[]> {
    return this.inner.listEnvironments();
  }

  applySecrets(envId: string, secrets: SecretSpec[]): Promise<void> {
    return this.inner.applySecrets(envId, secrets);
  }

  claimEnvironment(envId: string): Promise<Environment> {
    return this.inner.claimEnvironment(envId);
  }

  destroyEnvironment(envId: string): Promise<void> {
    // Defensive: an externally-destroyed pooled id must not be handed out.
    for (const pool of this.pools.values()) {
      const at = pool.ready.indexOf(envId);
      if (at >= 0) pool.ready.splice(at, 1);
    }
    return this.inner.destroyEnvironment(envId);
  }

  exec(envId: string, req: ExecRequest): Promise<ExecStream> {
    return this.inner.exec(envId, req);
  }

  fsRead(envId: string, path: string): Promise<Uint8Array> {
    return this.inner.fsRead(envId, path);
  }

  fsWrite(envId: string, path: string, data: Uint8Array, mode?: number): Promise<void> {
    return this.inner.fsWrite(envId, path, data, mode);
  }

  fsList(envId: string, path: string): Promise<FsEntry[]> {
    return this.inner.fsList(envId, path);
  }

  forwardPort(envId: string, containerPort: number): Promise<{ proxyUrl: string; token: string }> {
    return this.inner.forwardPort(envId, containerPort);
  }

  /** Warm envs currently claimable for a template (introspection/tests). */
  warmCount(template: CreateEnvironmentRequest): number {
    return (
      this.pools.get(canonicalRequestKey(CreateEnvironmentRequestSchema.parse(template)))?.ready
        .length ?? 0
    );
  }

  /* ------------------------------------------------------------------------ */

  /**
   * Verify → apply-secrets → hand out; anything less destroys (Decision 6).
   * Returns null when this warm env cannot be used — the caller tries the
   * next one or falls through cold. An env with half-applied secrets never
   * reaches a tenant and never returns to the pool.
   */
  private async claim(envId: string, secrets: SecretSpec[]): Promise<Environment | null> {
    let env: Environment | null;
    try {
      env = await this.inner.getEnvironment(envId);
    } catch (err) {
      this.onLog(`claim: verify of ${envId} failed: ${message(err)}`);
      return null;
    }
    if (!env || env.status !== 'ready') {
      this.onLog(`claim: warm env ${envId} vanished (${env?.status ?? 'gone'}); dropping`);
      return null;
    }
    if (secrets.length > 0) {
      try {
        await this.inner.applySecrets(envId, secrets);
      } catch (err) {
        this.onLog(`claim: applySecrets on ${envId} failed: ${message(err)}; destroying`);
        await this.inner.destroyEnvironment(envId).catch(() => {});
        return null;
      }
    }
    return env;
  }

  /** Fire-and-forget top-up; topUp itself never rejects. */
  private kick(pool: Pool): void {
    void this.topUp(pool);
  }

  /**
   * Serial per-pool filler (Decision 7): provisioning a burst of warm envs is
   * exactly the stampede the placement layer's reservations exist to bound —
   * one at a time keeps the pool a background trickle. A failure logs and
   * stops; the next claim (or fill()) retries. Single-flight: a concurrent
   * call joins the in-flight fill instead of starting a second one, so
   * awaiting fill() is deterministic even when a claim already kicked.
   */
  private topUp(pool: Pool): Promise<void> {
    if (pool.filling) return pool.filling;
    if (this.stopped) return Promise.resolve();
    pool.filling = (async (): Promise<void> => {
      try {
        while (!this.stopped && pool.ready.length < pool.size) {
          const env = await this.inner.createEnvironment(pool.template);
          if (this.stopped) {
            // stop() raced the provision: this env is unclaimed and untracked.
            await this.inner.destroyEnvironment(env.envId).catch(() => {});
            return;
          }
          pool.ready.push(env.envId);
          this.onLog(
            `warmed ${env.envId} (${pool.ready.length}/${pool.size} for ${pool.template.repoUrl ?? 'scratch'})`,
          );
        }
      } catch (err) {
        this.onLog(`fill failed (retry on next claim): ${message(err)}`);
      } finally {
        pool.filling = undefined;
      }
    })();
    return pool.filling;
  }
}

/**
 * Canonical identity of a request MINUS its secrets (Decision 5): schema-
 * normalized, keys sorted recursively, so matching is exact on everything
 * that shapes the env (repo, ref, resources, mounts, overrides) and blind to
 * who the tenant is.
 */
export function canonicalRequestKey(req: CreateEnvironmentRequest): string {
  const { secrets: _secrets, ...rest } = CreateEnvironmentRequestSchema.parse(req);
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Parse `SANDBOX_WARM_POOLS`: comma-separated `repoUrl[#ref]=size`. Config
 * errors throw at boot — a typo'd pool must not silently mean "no pool".
 */
export function parseWarmPools(raw: string): WarmPoolConfig[] {
  const pools: WarmPoolConfig[] = [];
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = entry.lastIndexOf('=');
    if (eq <= 0) throw new Error(`SANDBOX_WARM_POOLS entry "${entry}" is not repoUrl[#ref]=size`);
    const size = entry.slice(eq + 1).trim();
    if (!/^\d+$/.test(size) || Number(size) < 1) {
      throw new Error(`SANDBOX_WARM_POOLS entry "${entry}": size must be a positive integer`);
    }
    let repoUrl = entry.slice(0, eq).trim();
    let ref: string | undefined;
    const hash = repoUrl.lastIndexOf('#');
    if (hash > 0) {
      ref = repoUrl.slice(hash + 1).trim() || undefined;
      repoUrl = repoUrl.slice(0, hash).trim();
    }
    // http(s) only — the same shape RepoChoice/CreateEnvironmentRequest take.
    if (!/^https?:\/\//.test(repoUrl)) {
      throw new Error(
        `SANDBOX_WARM_POOLS entry "${entry}" needs an http(s) repo url, got "${repoUrl}"`,
      );
    }
    pools.push({ repoUrl, ref, size: Number(size) });
  }
  if (pools.length === 0) throw new Error('SANDBOX_WARM_POOLS is set but names no pools');
  return pools;
}

/** Warm-pool config from the environment; undefined when unset. */
export function warmPoolsFromEnv(
  env: Record<string, string | undefined>,
): WarmPoolConfig[] | undefined {
  const raw = env.SANDBOX_WARM_POOLS?.trim();
  if (!raw) return undefined;
  return parseWarmPools(raw);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
