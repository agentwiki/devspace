import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventBus,
  createInMemoryRepositories,
  IllegalTransitionError,
} from './index.js';

describe('in-memory repositories', () => {
  it('creates a work unit and transitions it legally', async () => {
    const repos = createInMemoryRepositories();
    const conv = await repos.conversations.create({
      platform: 'discord',
      externalChannelId: 'chan-1',
      userId: 'u1',
    });
    const wu = await repos.workUnits.create({ conversationId: conv.id });
    expect(wu.state).toBe('CREATED');

    const provisioning = await repos.workUnits.transition(wu.id, 'repoChoice', {
      repoUrl: 'https://github.com/acme/widgets',
    });
    expect(provisioning.state).toBe('PROVISIONING');
    expect(provisioning.repoUrl).toBe('https://github.com/acme/widgets');
  });

  it('resolves a conversation by (platform, externalChannelId) — gateway cold miss (M4)', async () => {
    const repos = createInMemoryRepositories();
    const conv = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C1:1712345678.000200',
      userId: 'u1',
    });
    await expect(
      repos.conversations.getByExternalChannelId('slack', 'C1:1712345678.000200'),
    ).resolves.toMatchObject({ id: conv.id });
    // Same key on another platform is a different conversation namespace.
    await expect(
      repos.conversations.getByExternalChannelId('discord', 'C1:1712345678.000200'),
    ).resolves.toBeNull();
  });

  it("lists a user's conversations per platform, newest first — App Home read (M6)", async () => {
    let tick = 0;
    const repos = createInMemoryRepositories(() => new Date(++tick * 1000).toISOString());
    const first = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C1:1',
      userId: 'u1',
    });
    const second = await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C1:2',
      userId: 'u1',
    });
    await repos.conversations.create({
      platform: 'discord',
      externalChannelId: 'D1',
      userId: 'u1',
    });
    await repos.conversations.create({
      platform: 'slack',
      externalChannelId: 'C1:3',
      userId: 'u2',
    });

    const listed = await repos.conversations.listByUser('slack', 'u1');
    expect(listed.map((c) => c.id)).toEqual([second.id, first.id]);
    await expect(repos.conversations.listByUser('slack', 'nobody')).resolves.toEqual([]);
  });

  it('rejects an illegal transition', async () => {
    const repos = createInMemoryRepositories();
    const conv = await repos.conversations.create({
      platform: 'discord',
      externalChannelId: 'chan-2',
      userId: 'u1',
    });
    const wu = await repos.workUnits.create({ conversationId: conv.id });
    await expect(repos.workUnits.transition(wu.id, 'prCreated')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it('stores secrets as ciphertext only and appends events', async () => {
    const repos = createInMemoryRepositories();
    await repos.secrets.put({ userId: 'u1', name: 'LLM_KEY', ciphertext: 'xxx', keyId: 'k1' });
    const got = await repos.secrets.get('u1', 'LLM_KEY');
    expect(got?.ciphertext).toBe('xxx');

    await repos.events.append({ topic: 'env.ready', payload: { envId: 'e1' } });
    expect(await repos.events.list('env.ready')).toHaveLength(1);
  });

  it('resolves and deletes a secret by record id; re-put upserts in place', async () => {
    const repos = createInMemoryRepositories();
    const rec = await repos.secrets.put({
      userId: 'u1',
      conversationId: 'c1',
      name: 'LLM_KEY',
      ciphertext: 'ct1',
      keyId: 'k1',
    });
    expect((await repos.secrets.getById(rec.id))?.ciphertext).toBe('ct1');

    // Re-put the same (user, conversation, name) rotates ciphertext, keeps the id.
    const again = await repos.secrets.put({
      userId: 'u1',
      conversationId: 'c1',
      name: 'LLM_KEY',
      ciphertext: 'ct2',
      keyId: 'k2',
    });
    expect(again.id).toBe(rec.id);
    expect((await repos.secrets.getById(rec.id))?.ciphertext).toBe('ct2');

    await repos.secrets.delete(rec.id);
    expect(await repos.secrets.getById(rec.id)).toBeNull();
    expect(await repos.secrets.get('u1', 'LLM_KEY', 'c1')).toBeNull();
    await expect(repos.secrets.delete(rec.id)).resolves.toBeUndefined(); // idempotent
  });

  it('appends and lists audit entries by conversation (M5)', async () => {
    const repos = createInMemoryRepositories();
    const rec = await repos.audit.append({
      userId: 'u1',
      conversationId: 'c1',
      workUnitId: 'wu1',
      action: 'secret.resolved',
      detail: { name: 'GITHUB_TOKEN', purpose: 'pr.create' },
    });
    expect(rec.id).toBeTruthy();
    expect(rec.at).toBeTruthy();
    await repos.audit.append({ conversationId: 'c2', action: 'teardown', detail: {} });

    const forC1 = await repos.audit.listByConversation('c1');
    expect(forC1).toHaveLength(1);
    expect(forC1[0]).toMatchObject({ action: 'secret.resolved', workUnitId: 'wu1' });
    expect(await repos.audit.listByConversation('c2')).toHaveLength(1);
    expect(await repos.audit.listByConversation('nope')).toHaveLength(0);
  });

  it('tracks event consumption', async () => {
    const repos = createInMemoryRepositories();
    const e = await repos.events.append({ topic: 't', payload: {} });
    expect(await repos.events.listUnconsumed()).toHaveLength(1);
    await repos.events.markConsumed(e.id);
    expect(await repos.events.listUnconsumed()).toHaveLength(0);
    await expect(repos.events.markConsumed('missing')).resolves.toBeUndefined();
  });
});

describe('in-memory event bus', () => {
  it('appends a durable row, fans out synchronously, and marks consumed', async () => {
    const repos = createInMemoryRepositories();
    const bus = createInMemoryEventBus(repos.events);
    const seen: string[] = [];
    const off = bus.subscribe((evt) => {
      seen.push(evt.topic);
    });

    const published = await bus.publish({ topic: 'pr.merged', payload: { prNumber: 7 } });
    expect(published.topic).toBe('pr.merged');
    expect(seen).toEqual(['pr.merged']);
    // Durable row exists and was stamped consumed by the synchronous delivery.
    expect(await repos.events.listUnconsumed()).toHaveLength(0);

    off();
    await bus.publish({ topic: 'pr.closed', payload: {} });
    expect(seen).toEqual(['pr.merged']); // unsubscribed handler no longer fires
  });
});
