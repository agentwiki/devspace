import { describe, expect, it } from 'vitest';
import { DiscordAdapter, SlackAdapter, parsePortCommand } from './index.js';

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
    const adapter = new DiscordAdapter({
      start: async () => {},
      stop: async () => {},
      postMessage: async () => ({ messageId: 'm1' }),
      createThread: async () => ({ threadId: 't1' }),
      editMessage: async () => {},
    });
    expect(adapter.platform).toBe('discord');
  });
});

describe('parsePortCommand (M6)', () => {
  it.each([
    ['!port 3000', 3000],
    ['  !port 8080  ', 8080],
    ['!port  65535', 65535],
    ['!port 0', null],
    ['!port 65536', null],
    ['!port http', null],
    ['!port', null],
    ['please !port 3000', null],
    ['expose port 3000', null],
  ])('%s -> %s', (text, expected) => {
    expect(parsePortCommand(text as string)).toBe(expected);
  });
});
