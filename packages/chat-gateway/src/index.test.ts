import { describe, expect, it } from 'vitest';
import { DiscordAdapter, SlackAdapter } from './index.js';

describe('SlackAdapter (primary)', () => {
  it('declares the slack platform on both adapter and renderer surfaces', () => {
    const adapter = new SlackAdapter({ botToken: 'xoxb', appToken: 'xapp' });
    expect(adapter.platform).toBe('slack');
  });

  it('render before start() is a dropped no-op, never a throw', async () => {
    const warnings: string[] = [];
    const adapter = new SlackAdapter(
      { botToken: 'xoxb', appToken: 'xapp' },
      { warn: (m) => warnings.push(m) },
    );
    await expect(
      adapter.render({ type: 'post_message', conversationId: 'c', text: 't' }),
    ).resolves.toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('DiscordAdapter (additional)', () => {
  it('declares the discord platform on both adapter and renderer surfaces', () => {
    const adapter = new DiscordAdapter({ token: 't', applicationId: 'a' });
    expect(adapter.platform).toBe('discord');
  });

  it('does not implement live behavior yet (M6)', async () => {
    const adapter = new DiscordAdapter({ token: 't', applicationId: 'a' });
    await expect(adapter.start(async () => {})).rejects.toThrow(/not implemented/);
  });
});
