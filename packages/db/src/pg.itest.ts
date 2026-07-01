/**
 * Postgres integration tests. These exercise the real driver, the real
 * `SELECT … FOR UPDATE` transition, and real LISTEN/NOTIFY.
 *
 * - Locally: self-skips when DATABASE_URL is unset or the server is unreachable,
 *   so `pnpm -r test:integration` is a no-op on a laptop without Postgres.
 * - In CI: `DEVSPACE_REQUIRE_PG=1` flips the skip into a hard failure, so a
 *   misconfigured URL can never masquerade as a green run.
 *
 * Migrations must already be applied (the CI job runs `db:migrate` first).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { createPgEventBus, createPostgresRepositories, IllegalTransitionError } from './index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REQUIRE_PG = process.env.DEVSPACE_REQUIRE_PG === '1';

async function probe(): Promise<{ ok: boolean; reason?: string }> {
  if (!DATABASE_URL) return { ok: false, reason: 'DATABASE_URL unset' };
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `unreachable: ${(err as Error).message}` };
  } finally {
    await pool.end();
  }
}

const availability = await probe();

// Must-not-skip guard: in CI a failed probe is a test failure, not a silent skip.
if (REQUIRE_PG && !availability.ok) {
  throw new Error(
    `DEVSPACE_REQUIRE_PG=1 but Postgres is not usable (${availability.reason}). ` +
      'Refusing to let the integration suite masquerade as a pass.',
  );
}

const suite = availability.ok ? describe : describe.skip;

suite('postgres repositories', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  // Isolate every test from the others and from prior runs.
  afterEach(async () => {
    await pool.query('TRUNCATE events, secrets, work_units, conversations CASCADE');
  });

  it('round-trips conversations, work units, secrets, and events', async () => {
    const repos = createPostgresRepositories(pool);
    const conv = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C123',
      userId: 'u1',
    });
    expect(await repos.conversations.get(conv.id)).toMatchObject({ platform: 'slack' });

    const wu = await repos.workUnits.create({ conversationId: conv.id });
    expect(wu.state).toBe('CREATED');
    const ready = await repos.workUnits.transition(wu.id, 'repoChoice', { repoUrl: 'https://x/r' });
    expect(ready.state).toBe('PROVISIONING');
    expect(ready.repoUrl).toBe('https://x/r');

    const sec = await repos.secrets.put({
      userId: 'u1',
      conversationId: conv.id,
      name: 'LLM_KEY',
      ciphertext: 'ct',
      keyId: 'k1',
    });
    expect((await repos.secrets.getById(sec.id))?.ciphertext).toBe('ct');
    expect((await repos.secrets.get('u1', 'LLM_KEY', conv.id))?.id).toBe(sec.id);

    // Re-put upserts (unique index on user/conv/name), keeping the same id.
    const rotated = await repos.secrets.put({
      userId: 'u1',
      conversationId: conv.id,
      name: 'LLM_KEY',
      ciphertext: 'ct2',
      keyId: 'k2',
    });
    expect(rotated.id).toBe(sec.id);
    expect((await repos.secrets.getById(sec.id))?.keyId).toBe('k2');

    await repos.secrets.delete(sec.id);
    expect(await repos.secrets.getById(sec.id)).toBeNull();

    const evt = await repos.events.append({ topic: 't', workUnitId: wu.id, payload: { a: 1 } });
    expect(await repos.events.listUnconsumed()).toHaveLength(1);
    await repos.events.markConsumed(evt.id);
    expect(await repos.events.listUnconsumed()).toHaveLength(0);
  });

  it('rejects a genuinely illegal transition', async () => {
    const repos = createPostgresRepositories(pool);
    const conv = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C-ill',
      userId: 'u1',
    });
    const wu = await repos.workUnits.create({ conversationId: conv.id });
    await expect(repos.workUnits.transition(wu.id, 'prCreated')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it('transition atomicity: a blocked writer recomputes rather than mis-erroring', async () => {
    // Two real connections. A holds FOR UPDATE on the row; B's transition must
    // block on the lock, then recompute against the state A committed — so a
    // lost update is NEVER misreported as an illegal transition.
    const repos = createPostgresRepositories(pool);
    const conv = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C-lock',
      userId: 'u1',
    });
    const wu = await repos.workUnits.create({ conversationId: conv.id });

    const a: PoolClient = await pool.connect();
    try {
      await a.query('BEGIN');
      await a.query('SELECT * FROM work_units WHERE id = $1 FOR UPDATE', [wu.id]);

      // B attempts the transition while A holds the lock.
      const bTransition = repos.workUnits.transition(wu.id, 'repoChoice');

      // Assert B is genuinely blocked on the row lock (waiting on `a`'s tx).
      await waitFor(async () => {
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND query ILIKE '%update%work_units%'`,
        );
        return (rows[0]?.n ?? 0) >= 1;
      });

      // A advances the row and commits; B's lock is released.
      await a.query(`UPDATE work_units SET state = 'PROVISIONING' WHERE id = $1`, [wu.id]);
      await a.query('COMMIT');

      // B re-read PROVISIONING and repoChoice is illegal from there → a TRUE
      // illegal transition, not a lost-update false positive.
      await expect(bTransition).rejects.toBeInstanceOf(IllegalTransitionError);
      expect((await repos.workUnits.get(wu.id))?.state).toBe('PROVISIONING');
    } finally {
      a.release();
    }
  });

  it('event bus delivers via LISTEN/NOTIFY and stamps consumed_at', async () => {
    const repos = createPostgresRepositories(pool);
    const bus = createPgEventBus(pool, repos.events, { recoveryIntervalMs: 60_000 });
    const received: string[] = [];
    let resolveGot: () => void;
    const got = new Promise<void>((r) => (resolveGot = r));
    bus.subscribe((evt) => {
      received.push(evt.id);
      resolveGot();
    });

    await bus.start(); // LISTEN confirmed before we publish
    try {
      const published = await bus.publish({ topic: 'pr.merged', payload: { n: 1 } });
      await withTimeout(got, 5_000, 'notify not delivered');
      expect(received).toContain(published.id);
      await waitFor(async () => (await repos.events.listUnconsumed()).length === 0);
    } finally {
      await bus.stop();
    }
  });

  it('event bus recovers a missed NOTIFY via the unconsumed sweep', async () => {
    const repos = createPostgresRepositories(pool);
    // Simulate a dropped NOTIFY: append the row directly, no publish/pg_notify.
    const orphan = await repos.events.append({ topic: 'pr.closed', payload: {} });

    const bus = createPgEventBus(pool, repos.events, { recoveryIntervalMs: 60_000 });
    const received: string[] = [];
    let resolveGot: () => void;
    const got = new Promise<void>((r) => (resolveGot = r));
    bus.subscribe((evt) => {
      received.push(evt.id);
      resolveGot();
    });

    // start() runs an immediate recovery sweep, which must pick up the orphan.
    await bus.start();
    try {
      await withTimeout(got, 5_000, 'recovery sweep did not deliver orphan');
      expect(received).toContain(orphan.id);
      await waitFor(async () => (await repos.events.listUnconsumed()).length === 0);
    } finally {
      await bus.stop();
    }
  });
});

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await sleep(25);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
