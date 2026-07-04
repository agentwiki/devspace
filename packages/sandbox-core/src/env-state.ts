/**
 * Durable host env table (M11): one JSON state file per environment under
 * `SANDBOX_STATE_DIR`, so a sandbox-core-svc restart no longer forgets which
 * envs — pool marks included — it was serving. Metadata ONLY: secret values
 * and preview tokens never land on host disk (m11-plan Decision 2; the
 * M1/M5 line). The store is a hint, not truth — recovery verifies every
 * record against the Docker daemon before re-adopting it (Decision 4).
 *
 * Writes are atomic (temp + rename, Decision 6): a crash mid-write can only
 * leave a torn `.tmp` file, which `loadAll` sweeps; a corrupt state file is
 * reported in `skipped`, never thrown — a bad file must not fail boot.
 */
import { mkdirSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { EnvStatusSchema, ResourceLimitsSchema } from '@devspace/contracts';

/**
 * The slice of an env record the host must not forget across a restart.
 * `workspaceFolder`/`repoUrl`/`ref` keep the claim-time refresh (M10) working
 * on recovered warm stock; `poolKey` is the mark the orphan sweep re-adopts.
 */
export const PersistedEnvStateSchema = z.object({
  envId: z.string().min(1),
  status: EnvStatusSchema,
  containerId: z.string().optional(),
  networkName: z.string().optional(),
  workspaceFolder: z.string().optional(),
  repoUrl: z.string().optional(),
  ref: z.string().optional(),
  poolKey: z.string().optional(),
  createdAt: z.string().datetime(),
  /**
   * The resource grant the env holds (M12) — a size, not a secret; optional
   * so pre-M12 state files load unchanged (their envs recover echo-less and
   * upstream weighs the contract defaults).
   */
  resources: ResourceLimitsSchema.optional(),
});
export type PersistedEnvState = z.infer<typeof PersistedEnvStateSchema>;

export interface EnvStateStore {
  /** Persist one env's state (atomic overwrite). */
  save(state: PersistedEnvState): Promise<void>;
  /** Forget one env (idempotent — removing a missing record is fine). */
  remove(envId: string): Promise<void>;
  /**
   * Every readable record, oldest first (deterministic recovery order — the
   * M10 orphan sweep adopts FIFO). Unparseable files land in `skipped`.
   */
  loadAll(): Promise<{ states: PersistedEnvState[]; skipped: string[] }>;
}

/** The real store: `<dir>/<envId>.json` per env. */
export class FileEnvStateStore implements EnvStateStore {
  constructor(private readonly dir: string) {
    // Fail at construction (= boot) when the dir cannot exist — a durable
    // host that cannot write its table must not start (Decision 5's spirit).
    mkdirSync(dir, { recursive: true });
  }

  async save(state: PersistedEnvState): Promise<void> {
    const file = this.fileFor(state.envId);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, file);
  }

  async remove(envId: string): Promise<void> {
    await rm(this.fileFor(envId), { force: true });
  }

  async loadAll(): Promise<{ states: PersistedEnvState[]; skipped: string[] }> {
    const states: PersistedEnvState[] = [];
    const skipped: string[] = [];
    for (const name of await readdir(this.dir)) {
      const path = join(this.dir, name);
      if (name.endsWith('.tmp')) {
        // A torn write from a crash mid-save; the rename never happened.
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      if (!name.endsWith('.json')) continue;
      try {
        states.push(PersistedEnvStateSchema.parse(JSON.parse(await readFile(path, 'utf8'))));
      } catch {
        skipped.push(name);
      }
    }
    states.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.envId.localeCompare(b.envId)
        : a.createdAt.localeCompare(b.createdAt),
    );
    return { states, skipped };
  }

  private fileFor(envId: string): string {
    return join(this.dir, `${sanitize(envId)}.json`);
  }
}

/**
 * Durable-table config from the environment (`SANDBOX_STATE_DIR`); undefined
 * when unset — the zero-config boot keeps the documented in-memory posture
 * byte-for-byte (m11-plan Decision 3).
 */
export function envStateStoreFromEnv(
  env: Record<string, string | undefined>,
): FileEnvStateStore | undefined {
  const dir = env.SANDBOX_STATE_DIR?.trim();
  if (!dir) return undefined;
  return new FileEnvStateStore(dir);
}

/** Keep envId safe as a file name (same shape provision.ts uses for paths). */
function sanitize(envId: string): string {
  return envId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}
