/**
 * Warm pools (M9, m9-plan workstream C — top-risk #4, cold-start latency).
 * `WarmPoolSandboxCore` wraps ANY inner `SandboxCore` (local, remote, or
 * multi-host — composition, not a mode): configured pools are pre-provisioned
 * in the background, and a `createEnvironment` whose request exactly matches a
 * pool's template claims a warm env — verify, refresh + unmark on the owning
 * host, apply the request's secrets, hand out — in milliseconds instead of
 * minutes. Anything else falls through to the cold path unchanged, so a stale
 * template can only ever mean "pool never hits", never "agent runs in the
 * wrong container" (m9-plan Decision 5).
 *
 * Since M10 every fill is stamped with the pool's canonical key (`poolKey`),
 * so the HOST's env table records what is unclaimed warm stock: `fill()`
 * re-adopts marked envs after an orchestrator restart instead of leaking
 * them, and the claim hands out a clone freshened at claim time, not one as
 * old as fill time (m10-plan).
 *
 * Since M14 the host's table is the ONLY ledger and this wrapper's lists are
 * hints, so N controllers can share one fleet's stock (m14-plan Decisions
 * 4–5): a lost claim race (CONFLICT/NOT_FOUND — a sibling got there first)
 * drops the env and moves on, never destroys; a local miss re-sweeps the
 * host for sibling-filled stock before going cold; and top-up gates on the
 * GLOBAL marked count, so controllers converge on `size`, not N×size.
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
import { SandboxError } from './sandbox.js';
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
      if (template.poolKey !== undefined) {
        // The wrapper owns the mark (m10-plan Decision 7); a pre-marked
        // template is a config error, not something to second-guess.
        throw new Error('warm pool templates must not carry poolKey');
      }
      const key = canonicalRequestKey(template);
      if (this.pools.has(key)) throw new Error('duplicate warm pool template');
      this.pools.set(key, { key, template, size: spec.size, ready: [] });
    }
  }

  /**
   * Re-adopt orphaned warm stock, then top every pool up to its size. Never
   * rejects — failures log (m9-plan Decision 7). The orphan sweep runs here
   * and not on the per-claim kicks: `fill()` is the boot-time entry, which is
   * exactly when a restarted control plane must reclaim what its predecessor
   * warmed (m10-plan Decision 6).
   */
  async fill(): Promise<void> {
    await this.adoptOrphans();
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
      const tried = new Set<string>();
      let swept = false;
      for (;;) {
        const envId = pool.ready.shift();
        if (envId === undefined) {
          // Local list exhausted. Once per request, ask the ledger: a sibling
          // controller may hold warm stock this instance never tracked
          // (m14-plan Decision 5). Anything already tried stays excluded.
          if (swept) break;
          swept = true;
          await this.adoptFromHost(pool, tried);
          if (pool.ready.length === 0) break;
          continue;
        }
        tried.add(envId);
        const claimed = await this.claim(envId, parsed.secrets);
        if (claimed) {
          this.kick(pool);
          return claimed;
        }
      }
      // Empty (or every warm env was dead/lost): go cold, but refill now.
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
   * Verify → refresh + unmark on the owning host → apply-secrets → hand out;
   * anything less destroys (m9-plan Decision 6, extended by m10-plan
   * Decision 2) — UNLESS the claim was lost to a sibling controller
   * (m14-plan Decision 4): CONFLICT means the mark is gone (the env may be a
   * TENANT's now) and NOT_FOUND means a sibling destroyed/trimmed it, so
   * both drop without touching the env. Returns null when this warm env
   * cannot be used — the caller tries the next one or falls through cold.
   * An env with a stale clone or half-applied secrets never reaches a
   * tenant and never returns to the pool.
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
    if (!env.poolKey) {
      // Already unmarked: a sibling claimed it between our tracking and now.
      this.onLog(`claim: lost ${envId} to a sibling controller (already claimed); dropping`);
      return null;
    }
    // The host freshens the clone and clears the pool mark in one operation;
    // a failure (dead remote, wiped workspace) costs a cold create, never a
    // stale hand-out.
    let claimed: Environment;
    try {
      claimed = await this.inner.claimEnvironment(envId);
    } catch (err) {
      if (err instanceof SandboxError && (err.code === 'CONFLICT' || err.code === 'NOT_FOUND')) {
        // Lost the race, not a broken env: the mark was the capability and a
        // sibling took it (or trimmed the env). Destroying here could kill a
        // tenant's live workspace — drop and move on.
        this.onLog(`claim: lost ${envId} to a sibling controller (${err.code}); dropping`);
        return null;
      }
      this.onLog(`claim: refresh of ${envId} failed: ${message(err)}; destroying`);
      await this.inner.destroyEnvironment(envId).catch(() => {});
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
    return claimed;
  }

  /**
   * The restart path (m10-plan Decision 6): ready envs carrying one of OUR
   * pool keys and not already tracked are re-adopted FIFO up to pool size;
   * anything beyond size (a shrunk config) is destroyed — re-adoption must
   * close the leak, not re-home it. Foreign marks and unmarked tenant envs
   * are never touched. Tolerant like the census: a listing failure logs and
   * the top-up still runs.
   */
  private async adoptOrphans(): Promise<void> {
    if (this.stopped) return;
    let envs: Environment[];
    try {
      envs = await this.inner.listEnvironments();
    } catch (err) {
      this.onLog(`orphan sweep failed (top-up continues): ${message(err)}`);
      return;
    }
    for (const env of envs) {
      if (env.status !== 'ready' || !env.poolKey) continue;
      const pool = this.pools.get(env.poolKey);
      if (!pool || pool.ready.includes(env.envId)) continue;
      if (pool.ready.length < pool.size) {
        pool.ready.push(env.envId);
        this.onLog(
          `re-adopted ${env.envId} (${pool.ready.length}/${pool.size} for ${pool.template.repoUrl ?? 'scratch'})`,
        );
      } else {
        this.onLog(`destroying excess warm env ${env.envId}`);
        await this.inner
          .destroyEnvironment(env.envId)
          .catch((err: unknown) => this.onLog(`destroy ${env.envId} failed: ${message(err)}`));
      }
    }
  }

  /**
   * Adopt marked ready envs from the host's table into the local list —
   * the claim-miss path to sibling-filled stock (M14). Tolerant: a listing
   * failure logs and the caller goes cold.
   */
  private async adoptFromHost(pool: Pool, exclude: Set<string>): Promise<void> {
    let envs: Environment[];
    try {
      envs = await this.inner.listEnvironments();
    } catch (err) {
      this.onLog(`sibling-stock sweep failed (going cold): ${message(err)}`);
      return;
    }
    for (const env of envs) {
      if (env.status !== 'ready' || env.poolKey !== pool.key) continue;
      if (exclude.has(env.envId) || pool.ready.includes(env.envId)) continue;
      pool.ready.push(env.envId);
    }
  }

  /**
   * GLOBAL warm stock for a pool — the host's table is the ledger (m14-plan
   * Decision 5). Adopts untracked marked envs as it counts, so sibling fills
   * become claimable here; falls back to the local count when listing fails
   * (an unreachable fleet must degrade to single-controller behavior, never
   * block fills).
   */
  private async stock(pool: Pool): Promise<number> {
    let envs: Environment[];
    try {
      envs = await this.inner.listEnvironments();
    } catch {
      return pool.ready.length;
    }
    const marked = envs.filter((e) => e.status === 'ready' && e.poolKey === pool.key);
    for (const env of marked) {
      if (!pool.ready.includes(env.envId)) pool.ready.push(env.envId);
    }
    return marked.length;
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
   * Gated on the GLOBAL stock (M14): N controllers filling the same pool
   * converge on `size` warm envs, not N×size. Two of them can still both
   * read `size-1` and both provision — the overshoot is bounded by the
   * controller count and the boot-time sweep trims it.
   */
  private topUp(pool: Pool): Promise<void> {
    if (pool.filling) return pool.filling;
    if (this.stopped) return Promise.resolve();
    pool.filling = (async (): Promise<void> => {
      try {
        while (!this.stopped && (await this.stock(pool)) < pool.size) {
          // Stamped with the pool's key (M10): the host's env table — not this
          // process's memory — records what is unclaimed warm stock.
          const env = await this.inner.createEnvironment({
            ...pool.template,
            poolKey: pool.key,
          });
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
 * Canonical identity of a request MINUS its secrets and pool mark (m9-plan
 * Decision 5, m10-plan Decision 1): schema-normalized, keys sorted
 * recursively, so matching is exact on everything that shapes the env (repo,
 * ref, resources, mounts, overrides) and blind to bookkeeping — who the
 * tenant is, which pool provisioned it.
 */
export function canonicalRequestKey(req: CreateEnvironmentRequest): string {
  const {
    secrets: _secrets,
    poolKey: _poolKey,
    ...rest
  } = CreateEnvironmentRequestSchema.parse(req);
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
