import { describe, expect, it } from 'vitest';
import { DiscordAdapter } from './index.js';

describe('DiscordAdapter', () => {
  it('declares the discord platform on both adapter and renderer surfaces', () => {
    const adapter = new DiscordAdapter({ token: 't', applicationId: 'a' });
    expect(adapter.platform).toBe('discord');
  });

  it('does not implement live behavior yet (M4)', async () => {
    const adapter = new DiscordAdapter({ token: 't', applicationId: 'a' });
    await expect(adapter.start(async () => {})).rejects.toThrow(/not implemented/);
  });
});
