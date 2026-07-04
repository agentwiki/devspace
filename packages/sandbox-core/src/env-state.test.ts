import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileEnvStateStore, envStateStoreFromEnv } from './env-state.js';
import type { PersistedEnvState } from './env-state.js';

const state = (over: Partial<PersistedEnvState> = {}): PersistedEnvState => ({
  envId: 'env_a',
  status: 'ready',
  containerId: 'cont-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('FileEnvStateStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devspace-envstate-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a full record and overwrites atomically', async () => {
    const store = new FileEnvStateStore(dir);
    await store.save(
      state({
        networkName: 'net-a',
        workspaceFolder: '/ws/a',
        repoUrl: 'https://x/r.git',
        ref: 'main',
        poolKey: 'pool-1',
      }),
    );
    // Overwrite: the claim path re-saves the same env without its mark.
    await store.save(
      state({ networkName: 'net-a', workspaceFolder: '/ws/a', repoUrl: 'https://x/r.git' }),
    );
    const { states, skipped } = await store.loadAll();
    expect(skipped).toEqual([]);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ envId: 'env_a', repoUrl: 'https://x/r.git' });
    expect(states[0]!.poolKey).toBeUndefined();
    // No torn temp file left behind by the rename dance.
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('remove forgets the env and is idempotent', async () => {
    const store = new FileEnvStateStore(dir);
    await store.save(state());
    await store.remove('env_a');
    await store.remove('env_a');
    expect((await store.loadAll()).states).toEqual([]);
  });

  it('never persists secret values or preview tokens (the schema has no field for them)', async () => {
    const store = new FileEnvStateStore(dir);
    await store.save(state({ poolKey: 'pool-1' }));
    const raw = await readFile(join(dir, 'env_a.json'), 'utf8');
    expect(raw).not.toMatch(/secret|token|ports/i);
  });

  it('skips corrupt files and sweeps stale .tmp files without failing', async () => {
    const store = new FileEnvStateStore(dir);
    await store.save(state());
    await writeFile(join(dir, 'env_bad.json'), '{ not json', 'utf8');
    await writeFile(join(dir, 'env_wrong.json'), JSON.stringify({ envId: 'x' }), 'utf8');
    await writeFile(join(dir, 'env_torn.json.tmp'), '{', 'utf8');
    const { states, skipped } = await store.loadAll();
    expect(states.map((s) => s.envId)).toEqual(['env_a']);
    expect(skipped.sort()).toEqual(['env_bad.json', 'env_wrong.json']);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('loads oldest first for deterministic FIFO re-adoption', async () => {
    const store = new FileEnvStateStore(dir);
    await store.save(state({ envId: 'env_new', createdAt: '2026-01-02T00:00:00.000Z' }));
    await store.save(state({ envId: 'env_old', createdAt: '2026-01-01T00:00:00.000Z' }));
    const { states } = await store.loadAll();
    expect(states.map((s) => s.envId)).toEqual(['env_old', 'env_new']);
  });

  it('creates the directory at construction', async () => {
    const nested = join(dir, 'a', 'b');
    const store = new FileEnvStateStore(nested);
    await store.save(state());
    expect((await store.loadAll()).states).toHaveLength(1);
  });
});

describe('envStateStoreFromEnv', () => {
  it('is undefined when SANDBOX_STATE_DIR is unset or blank', () => {
    expect(envStateStoreFromEnv({})).toBeUndefined();
    expect(envStateStoreFromEnv({ SANDBOX_STATE_DIR: '  ' })).toBeUndefined();
  });

  it('builds a store rooted at the configured dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devspace-envstate-cfg-'));
    try {
      const store = envStateStoreFromEnv({ SANDBOX_STATE_DIR: dir });
      expect(store).toBeInstanceOf(FileEnvStateStore);
      await store!.save(state());
      expect((await store!.loadAll()).states).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
