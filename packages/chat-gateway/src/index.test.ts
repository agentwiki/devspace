import { describe, expect, it } from 'vitest';
import { DiscordAdapter, SlackAdapter } from './index.js';

describe('SlackAdapter (primary)', () => {
  it('declares the slack platform on both adapter and renderer surfaces', () => {
    const adapter = new SlackAdapter({ botToken: 'xoxb', appToken: 'xapp' });
    expect(adapter.platform).toBe('slack');
  });

  it('does not implement live behavior yet (M4)', async () => {
    const adapter = new SlackAdapter({ botToken: 'xoxb', appToken: 'xapp' });
    await expect(adapter.start(async () => {})).rejects.toThrow(/not implemented/);
  });
});

describe('DiscordAdapter (additional)', () => {
  it('declares the discord platform on both adapter and renderer surfaces', () => {
    const adapter = new DiscordAdapter({ token: 't', applicationId: 'a' });
    expect(adapter.platform).toBe('discord');
  });

  it('does not implement live behavior yet (M4)', async () => {
    const adapter = new DiscordAdapter({ token: 't', applicationId: 'a' });
    await expect(adapter.start(async () => {})).rejects.toThrow(/not implemented/);
  });
});
