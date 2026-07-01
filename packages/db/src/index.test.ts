import { describe, expect, it } from 'vitest';
import { createInMemoryRepositories, IllegalTransitionError } from './index.js';

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
});
