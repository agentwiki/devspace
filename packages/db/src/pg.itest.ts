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
    await pool.query(
      'TRUNCATE audit_log, transcripts, events, leases, secrets, work_units, conversations CASCADE',
    );
  });

  it('round-trips conversations, work units, secrets, and events', async () => {
    const repos = createPostgresRepositories(pool);
    const conv = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C123',
      userId: 'u1',
    });
    expect(await repos.conversations.get(conv.id)).toMatchObject({ platform: 'slack' });
    expect(await repos.conversations.getByExternalChannelId('slack', 'C123')).toMatchObject({
      id: conv.id,
    });
    expect(await repos.conversations.getByExternalChannelId('discord', 'C123')).toBeNull();
    expect((await repos.conversations.listByUser('slack', 'u1')).map((c) => c.id)).toEqual([
      conv.id,
    ]);
    expect(await repos.conversations.listByUser('slack', 'nobody')).toEqual([]);

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

  it('round-trips audit entries in insertion order (M5)', async () => {
    const repos = createPostgresRepositories(pool);
    const first = await repos.audit.append({
      userId: 'u1',
      conversationId: 'c-audit',
      workUnitId: 'wu-1',
      action: 'secret.resolved',
      detail: { name: 'GITHUB_TOKEN', purpose: 'pr.create' },
    });
    await repos.audit.append({ conversationId: 'c-audit', action: 'teardown', detail: {} });
    await repos.audit.append({ conversationId: 'c-other', action: 'teardown', detail: {} });

    const rows = await repos.audit.listByConversation('c-audit');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: first.id,
      action: 'secret.resolved',
      userId: 'u1',
      workUnitId: 'wu-1',
      detail: { name: 'GITHUB_TOKEN', purpose: 'pr.create' },
    });
    expect(rows[1]?.action).toBe('teardown');
  });

  it('touch stamps lastActivityAt without moving updatedAt or state (M17)', async () => {
    const repos = createPostgresRepositories(pool);
    const conv = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C-touch',
      userId: 'u1',
    });
    const wu = await repos.workUnits.create({ conversationId: conv.id });
    expect(wu.lastActivityAt).toBeUndefined(); // nullable column: pre-touch rows read as absent

    await repos.workUnits.touch(wu.id);
    const touched = await repos.workUnits.get(wu.id);
    expect(touched?.lastActivityAt).toBeTruthy();
    expect(touched?.updatedAt).toBe(wu.updatedAt);
    expect(touched?.state).toBe('CREATED');
    // Missing ids are a no-op, matching the in-memory contract.
    await expect(repos.workUnits.touch('missing')).resolves.toBeUndefined();
  });

  it('markIdleWarned stamps idleWarnedAt and nothing else (M18)', async () => {
    const repos = createPostgresRepositories(pool);
    const conv = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C-warned',
      userId: 'u1',
    });
    const wu = await repos.workUnits.create({ conversationId: conv.id });
    expect(wu.idleWarnedAt).toBeUndefined(); // nullable column: unwarned rows read as absent

    await repos.workUnits.markIdleWarned(wu.id);
    const warned = await repos.workUnits.get(wu.id);
    expect(warned?.idleWarnedAt).toBeTruthy();
    expect(warned?.updatedAt).toBe(wu.updatedAt);
    expect(warned?.lastActivityAt).toBeUndefined();
    // Missing ids are a no-op, matching the in-memory contract.
    await expect(repos.workUnits.markIdleWarned('missing')).resolves.toBeUndefined();
  });

  it('releaseEnv nulls envId + agentSessionId and nothing else (M18)', async () => {
    const repos = createPostgresRepositories(pool);
    const conv = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C-release',
      userId: 'u1',
    });
    const wu = await repos.workUnits.create({
      conversationId: conv.id,
      envId: 'env_9',
      agentSessionId: 'as_9',
    });

    await repos.workUnits.releaseEnv(wu.id);
    const after = await repos.workUnits.get(wu.id);
    expect(after?.envId).toBeUndefined();
    expect(after?.agentSessionId).toBeUndefined();
    expect(after?.state).toBe(wu.state);
    expect(after?.updatedAt).toBe(wu.updatedAt);
    // Missing ids are a no-op, matching the in-memory contract.
    await expect(repos.workUnits.releaseEnv('missing')).resolves.toBeUndefined();
  });

  it('transcripts round-trip: seq owns the order, the tail is chronological (M20)', async () => {
    const repos = createPostgresRepositories(pool);
    // A same-millisecond burst: created_at may collide; seq must not.
    const texts = ['one', 'two', 'three', 'four'];
    for (const [i, text] of texts.entries()) {
      await repos.transcripts.append({
        conversationId: 'c-tr',
        workUnitId: 'wu-tr',
        role: i % 2 === 0 ? 'user' : 'agent',
        text,
      });
    }
    await repos.transcripts.append({ conversationId: 'c-other', role: 'user', text: 'foreign' });

    const all = await repos.transcripts.listByConversation('c-tr');
    expect(all.map((t) => t.text)).toEqual(texts);
    expect(all[0]).toMatchObject({ role: 'user', workUnitId: 'wu-tr', conversationId: 'c-tr' });
    expect(all[0]?.createdAt).toBeTruthy();

    // The tail is the newest n, oldest-first, and never crosses conversations.
    const tail = await repos.transcripts.listTail('c-tr', 2);
    expect(tail.map((t) => t.text)).toEqual(['three', 'four']);
    expect(await repos.transcripts.listTail('c-tr', 99)).toHaveLength(4);
    expect(await repos.transcripts.listTail('c-none', 5)).toEqual([]);
  });

  it('deleteBefore prunes strictly-older rows on both tables and counts them (M21)', async () => {
    const repos = createPostgresRepositories(pool);
    await repos.transcripts.append({ conversationId: 'c-ret', role: 'user', text: 'old' });
    await repos.audit.append({ conversationId: 'c-ret', action: 'old.action', detail: {} });
    // A cutoff between the two batches — wall-clock, so a real pause.
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await repos.transcripts.append({ conversationId: 'c-ret', role: 'agent', text: 'fresh' });
    await repos.audit.append({ conversationId: 'c-ret', action: 'fresh.action', detail: {} });

    expect(await repos.transcripts.deleteBefore(cutoff)).toBe(1);
    expect((await repos.transcripts.listByConversation('c-ret')).map((t) => t.text)).toEqual([
      'fresh',
    ]);
    expect(await repos.audit.deleteBefore(cutoff)).toBe(1);
    expect((await repos.audit.listByConversation('c-ret')).map((a) => a.action)).toEqual([
      'fresh.action',
    ]);
    // Idempotent re-run.
    expect(await repos.transcripts.deleteBefore(cutoff)).toBe(0);
    expect(await repos.audit.deleteBefore(cutoff)).toBe(0);
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

  it('claim leases atomically: one winner per window, stale leases reclaim (M14)', async () => {
    const repos = createPostgresRepositories(pool);
    const evt = await repos.events.append({ topic: 'pr.merged', payload: {} });

    // Two instances race the same row; exactly one UPDATE can match.
    const [a, b] = await Promise.all([
      repos.events.claim(evt.id, 'ctrl-a', 60_000),
      repos.events.claim(evt.id, 'ctrl-b', 60_000),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(['ctrl-a', 'ctrl-b']).toContain(winners[0]?.claimedBy);

    // Inside the TTL the loser stays locked out…
    expect(await repos.events.claim(evt.id, 'ctrl-late', 60_000)).toBeNull();
    // …but a lease older than the TTL is presumed crashed and reclaimable.
    await pool.query(`UPDATE events SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [
      evt.id,
    ]);
    expect((await repos.events.claim(evt.id, 'ctrl-late', 60_000))?.claimedBy).toBe('ctrl-late');

    // A consumed row never reclaims, however old its lease.
    await repos.events.markConsumed(evt.id);
    await pool.query(`UPDATE events SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [
      evt.id,
    ]);
    expect(await repos.events.claim(evt.id, 'ctrl-x', 60_000)).toBeNull();
  });

  it('lease acquire is atomic: one winner, renewal, expiry reclaim, release (M15)', async () => {
    const repos = createPostgresRepositories(pool);

    // Two controllers race the same role; exactly one upsert can win.
    const [a, b] = await Promise.all([
      repos.leases.acquire('pr-reconciler', 'ctrl-a', 60_000),
      repos.leases.acquire('pr-reconciler', 'ctrl-b', 60_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const holder = a ? 'ctrl-a' : 'ctrl-b';
    const loser = a ? 'ctrl-b' : 'ctrl-a';
    expect((await repos.leases.get('pr-reconciler'))?.holder).toBe(holder);

    // The holder renews (tenure preserved); the loser stays locked out.
    const before = await repos.leases.get('pr-reconciler');
    expect(await repos.leases.acquire('pr-reconciler', holder, 60_000)).toBe(true);
    const after = await repos.leases.get('pr-reconciler');
    expect(after?.acquiredAt).toBe(before?.acquiredAt);
    expect(Date.parse(after!.renewedAt)).toBeGreaterThanOrEqual(Date.parse(before!.renewedAt));
    expect(await repos.leases.acquire('pr-reconciler', loser, 60_000)).toBe(false);

    // An expired lease is presumed crashed: re-grantable, takeover resets tenure.
    await pool.query(
      `UPDATE leases SET renewed_at = now() - interval '10 minutes' WHERE name = $1`,
      ['pr-reconciler'],
    );
    expect(await repos.leases.acquire('pr-reconciler', loser, 60_000)).toBe(true);
    const taken = await repos.leases.get('pr-reconciler');
    expect(taken?.holder).toBe(loser);
    expect(taken?.acquiredAt).not.toBe(before?.acquiredAt);

    // A non-holder release no-ops; the holder's frees the role immediately.
    await repos.leases.release('pr-reconciler', holder);
    expect((await repos.leases.get('pr-reconciler'))?.holder).toBe(loser);
    await repos.leases.release('pr-reconciler', loser);
    expect(await repos.leases.get('pr-reconciler')).toBeNull();
    expect(await repos.leases.acquire('pr-reconciler', holder, 60_000)).toBe(true);
  });

  it('two live buses over one database: each event runs on exactly one (M14)', async () => {
    const repos = createPostgresRepositories(pool);
    const handled: Array<{ bus: string; id: string }> = [];
    const busA = createPgEventBus(pool, repos.events, {
      recoveryIntervalMs: 60_000,
      instanceId: 'ctrl-a',
    });
    const busB = createPgEventBus(pool, repos.events, {
      recoveryIntervalMs: 60_000,
      instanceId: 'ctrl-b',
    });
    busA.subscribe((evt) => void handled.push({ bus: 'a', id: evt.id }));
    busB.subscribe((evt) => void handled.push({ bus: 'b', id: evt.id }));

    await busA.start();
    await busB.start();
    try {
      const published: string[] = [];
      for (let i = 0; i < 8; i++) {
        published.push((await busA.publish({ topic: 'pr.merged', payload: { i } })).id);
      }
      await waitFor(async () => (await repos.events.listUnconsumed()).length === 0);
      // Give any straggling double-delivery a beat to land before asserting.
      await sleep(100);
      // Every event was handled — and by exactly ONE of the two controllers.
      const byId = new Map<string, number>();
      for (const h of handled) byId.set(h.id, (byId.get(h.id) ?? 0) + 1);
      for (const id of published) expect(byId.get(id)).toBe(1);
      expect(handled).toHaveLength(published.length);
    } finally {
      await busA.stop();
      await busB.stop();
    }
  });

  it('a row claimed by a crashed controller is re-run once the lease expires (M14)', async () => {
    const repos = createPostgresRepositories(pool);
    // The "crash": a claim taken long ago, never consumed, no NOTIFY pending.
    const orphan = await repos.events.append({ topic: 'pr.closed', payload: {} });
    expect(await repos.events.claim(orphan.id, 'ctrl-dead', 60_000)).toBeTruthy();
    await pool.query(`UPDATE events SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [
      orphan.id,
    ]);

    const bus = createPgEventBus(pool, repos.events, {
      recoveryIntervalMs: 60_000,
      instanceId: 'ctrl-b',
      claimTtlMs: 60_000,
    });
    const received: string[] = [];
    let resolveGot: () => void;
    const got = new Promise<void>((r) => (resolveGot = r));
    bus.subscribe((evt) => {
      received.push(evt.id);
      resolveGot();
    });

    // start()'s immediate recovery sweep must reclaim and run the orphan.
    await bus.start();
    try {
      await withTimeout(got, 5_000, 'stale-leased row was not re-run');
      expect(received).toContain(orphan.id);
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
