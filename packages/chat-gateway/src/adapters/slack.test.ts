/**
 * SlackAdapter tests: recorded Slack payloads (fixtures/) replayed through a
 * REAL Bolt App via an injected receiver — Bolt's own routing + ignoreSelf
 * middleware run, no live Slack — and a fake WebClient asserts the outbound
 * calls (m4-plan workstream C / Decision 3).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { App, Receiver } from '@slack/bolt';
import type { ChatEvent } from '@devspace/contracts';
import { parseRepoChoice, SlackAdapter } from './slack.js';
import { ConversationBinding } from '../binding.js';
import type { Clock } from '../status.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Feeds recorded payloads into the real Bolt middleware chain. */
class FakeReceiver implements Receiver {
  private app!: App;
  init(app: App): void {
    this.app = app;
  }
  async start(): Promise<unknown> {
    return undefined;
  }
  async stop(): Promise<unknown> {
    return undefined;
  }
  async dispatch(body: Record<string, unknown>): Promise<void> {
    await this.app.processEvent({ body, ack: async () => {}, retryNum: undefined });
  }
}

function fakeWebClient() {
  let n = 0;
  return {
    postMessage: vi.fn(
      async (_args: { channel: string; thread_ts?: string; text: string; blocks?: unknown[] }) => ({
        ts: `9999.${String((n += 1)).padStart(6, '0')}`,
      }),
    ),
    update: vi.fn(
      async (_args: { channel: string; ts: string; text: string; blocks?: unknown[] }) => {},
    ),
    publishHome: vi.fn(async (_args: { userId: string; view: unknown }) => {}),
  };
}

interface HarnessOptions {
  binding?: ConversationBinding;
  listSessions?: ConstructorParameters<typeof SlackAdapter>[1] extends infer O
    ? O extends { listSessions?: infer L }
      ? L
      : never
    : never;
  clock?: Clock;
  minStreamIntervalMs?: number;
}

async function startAdapter(opts: HarnessOptions = {}) {
  const receiver = new FakeReceiver();
  const client = fakeWebClient();
  const binding = opts.binding ?? new ConversationBinding();
  const events: ChatEvent[] = [];
  const warnings: string[] = [];
  const emit = vi.fn(async (event: ChatEvent) => {
    events.push(event);
    return event.type === 'conversation.created' ? { conversationId: 'conv-1' } : undefined;
  });
  const adapter = new SlackAdapter(
    { botToken: 'xoxb-test', appToken: 'xapp-test' },
    {
      receiver,
      client,
      binding,
      authorize: async () => ({ botToken: 'xoxb-test', botId: 'B0001', botUserId: 'UBOT' }),
      listSessions: opts.listSessions,
      clock: opts.clock,
      minStreamIntervalMs: opts.minStreamIntervalMs,
      warn: (message) => warnings.push(message),
    },
  );
  await adapter.start(emit);
  return { adapter, receiver, client, binding, events, emit, warnings };
}

describe('parseRepoChoice', () => {
  it('accepts a plain URL with an optional ref', () => {
    expect(parseRepoChoice('https://github.com/acme/widgets main')).toEqual({
      repoUrl: 'https://github.com/acme/widgets',
      ref: 'main',
      empty: false,
    });
  });

  it('unwraps Slack auto-links, with and without a label', () => {
    expect(parseRepoChoice('<https://github.com/a/b>').repoUrl).toBe('https://github.com/a/b');
    expect(parseRepoChoice('<https://github.com/a/b|a/b>').repoUrl).toBe('https://github.com/a/b');
  });

  it('expands owner/repo shorthand to github.com', () => {
    expect(parseRepoChoice('acme/widgets').repoUrl).toBe('https://github.com/acme/widgets');
  });

  it('maps empty or non-URL text to an empty choice', () => {
    expect(parseRepoChoice('')).toEqual({ empty: true });
    expect(parseRepoChoice('   ')).toEqual({ empty: true });
    expect(parseRepoChoice('not a repo')).toEqual({ empty: true });
  });
});

describe('SlackAdapter inbound (recorded payloads through real Bolt)', () => {
  it('/devspace roots a thread and emits conversation.created with the parsed repo', async () => {
    const h = await startAdapter();
    await h.receiver.dispatch(fixture('command-devspace.json'));

    // The bot rooted the session thread in the channel…
    expect(h.client.postMessage).toHaveBeenCalledTimes(1);
    expect(h.client.postMessage.mock.calls[0]![0]).toMatchObject({ channel: 'C0123ABC' });
    // …and the emitted event carries the reversible ref + parsed repoChoice.
    expect(h.events).toEqual([
      {
        type: 'conversation.created',
        platform: 'slack',
        externalChannelId: 'C0123ABC:9999.000001',
        userId: 'U111',
        repoChoice: { repoUrl: 'https://github.com/acme/widgets', ref: 'main', empty: false },
      },
    ]);
    // The returned conversationId is bound to the thread for the render path.
    expect(h.binding.refFor('conv-1')).toEqual({ channel: 'C0123ABC', threadTs: '9999.000001' });
  });

  it('an app mention on a fresh thread creates a conversation (shorthand expanded)', async () => {
    const h = await startAdapter();
    await h.receiver.dispatch(fixture('event-app-mention.json'));
    expect(h.events).toEqual([
      {
        type: 'conversation.created',
        platform: 'slack',
        externalChannelId: 'C0123ABC:1712345680.000400',
        userId: 'U111',
        repoChoice: { repoUrl: 'https://github.com/acme/widgets', ref: undefined, empty: false },
      },
    ]);
    expect(h.binding.refFor('conv-1')).toEqual({
      channel: 'C0123ABC',
      threadTs: '1712345680.000400',
    });
  });

  it('a mention inside an already-bound thread is a message, not a new conversation', async () => {
    const binding = new ConversationBinding();
    binding.bind('conv-9', { channel: 'C0123ABC', threadTs: '1712345680.000400' });
    const h = await startAdapter({ binding });
    await h.receiver.dispatch(fixture('event-app-mention.json'));
    expect(h.events).toEqual([
      { type: 'message.posted', conversationId: 'conv-9', userId: 'U111', text: 'acme/widgets' },
    ]);
  });

  it('a human reply in a bound thread emits message.posted', async () => {
    const binding = new ConversationBinding();
    binding.bind('conv-t', { channel: 'C0123ABC', threadTs: '1712345678.000200' });
    const h = await startAdapter({ binding });
    await h.receiver.dispatch(fixture('event-thread-message.json'));
    expect(h.events).toEqual([
      {
        type: 'message.posted',
        conversationId: 'conv-t',
        userId: 'U111',
        text: 'add a healthcheck endpoint',
      },
    ]);
  });

  it('ignores replies in unbound threads and the bot’s own messages', async () => {
    const binding = new ConversationBinding();
    binding.bind('conv-t', { channel: 'C0123ABC', threadTs: '1712345678.000200' });
    const h = await startAdapter({ binding });
    // Unbound thread: fresh adapter state has no binding for this thread.
    const unbound = await startAdapter();
    await unbound.receiver.dispatch(fixture('event-thread-message.json'));
    expect(unbound.events).toEqual([]);
    // The bot's own turn output echoed back: real ignoreSelf middleware drops it.
    await h.receiver.dispatch(fixture('event-bot-own-message.json'));
    expect(h.events).toEqual([]);
  });

  it('a Block Kit click emits action.invoked with the raw action_id', async () => {
    const binding = new ConversationBinding();
    binding.bind('conv-a', { channel: 'C0123ABC', threadTs: '1712345678.000200' });
    const h = await startAdapter({ binding });
    await h.receiver.dispatch(fixture('action-approve.json'));
    expect(h.events).toEqual([
      {
        type: 'action.invoked',
        conversationId: 'conv-a',
        userId: 'U111',
        actionId: 'approve:req-1',
        payload: {},
      },
    ]);
  });

  it('app_home_opened publishes the session list view', async () => {
    const h = await startAdapter({
      listSessions: async (slackUserId: string) => {
        expect(slackUserId).toBe('U111');
        return [{ conversationId: 'c1', state: 'WORKING', repoUrl: 'https://github.com/o/r' }];
      },
    });
    await h.receiver.dispatch(fixture('event-app-home-opened.json'));
    expect(h.client.publishHome).toHaveBeenCalledTimes(1);
    const { userId, view } = h.client.publishHome.mock.calls[0]![0];
    expect(userId).toBe('U111');
    expect(JSON.stringify(view)).toContain('*WORKING*');
  });
});

describe('SlackAdapter render', () => {
  const ref = { channel: 'C0123ABC', threadTs: '1712345678.000200' };

  async function boundAdapter(opts: HarnessOptions = {}) {
    const binding = new ConversationBinding();
    binding.bind('conv-r', ref);
    return startAdapter({ ...opts, binding });
  }

  it('post_message replies into the bound thread', async () => {
    const h = await boundAdapter();
    const posted = await h.adapter.render({
      type: 'post_message',
      conversationId: 'conv-r',
      text: 'hello',
    });
    expect(h.client.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: ref.channel, thread_ts: ref.threadTs, text: 'hello' }),
    );
    expect(posted).toEqual({ conversationId: 'conv-r', messageId: '9999.000001' });
  });

  it('update_status posts once, then edits the same message in place', async () => {
    const h = await boundAdapter();
    await h.adapter.render({
      type: 'update_status',
      conversationId: 'conv-r',
      state: 'PROVISIONING',
      text: 'Provisioning…',
    });
    await h.adapter.render({
      type: 'update_status',
      conversationId: 'conv-r',
      state: 'READY',
      text: 'Environment ready.',
    });
    expect(h.client.postMessage).toHaveBeenCalledTimes(1);
    expect(h.client.update).toHaveBeenCalledTimes(1);
    expect(h.client.update.mock.calls[0]![0]).toMatchObject({
      channel: ref.channel,
      ts: '9999.000001',
      text: 'READY: Environment ready.',
    });
  });

  it('post_actions ships the buttons with their stable action_ids', async () => {
    const h = await boundAdapter();
    await h.adapter.render({
      type: 'post_actions',
      conversationId: 'conv-r',
      text: 'Approve?',
      actions: [
        { actionId: 'approve:req-1', label: 'Approve', style: 'primary' },
        { actionId: 'deny:req-1', label: 'Deny', style: 'danger' },
      ],
    });
    const blocks = h.client.postMessage.mock.calls[0]![0].blocks as { type: string }[];
    expect(blocks.at(-1)?.type).toBe('actions');
    expect(JSON.stringify(blocks)).toContain('approve:req-1');
  });

  it('a render for an unbound conversation is dropped with a warning, never thrown', async () => {
    const h = await startAdapter(); // nothing bound, no resolvers
    await expect(
      h.adapter.render({ type: 'post_message', conversationId: 'conv-ghost', text: 'x' }),
    ).resolves.toBeUndefined();
    expect(h.client.postMessage).not.toHaveBeenCalled();
    expect(h.warnings.join('\n')).toContain('conv-ghost');
  });

  it('an outbound cold miss resolves through the binding’s ref resolver (reconciler path)', async () => {
    const binding = new ConversationBinding({
      ref: async (conversationId) =>
        conversationId === 'conv-cold' ? 'C0123ABC:1712345678.000200' : null,
    });
    const h = await startAdapter({ binding });
    await h.adapter.render({
      type: 'update_status',
      conversationId: 'conv-cold',
      state: 'PR_MERGED',
      text: 'PR merged. 🎉',
    });
    expect(h.client.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: ref.channel, thread_ts: ref.threadTs }),
    );
  });

  it('stream_append posts on first flush, then edits with the accumulated text', async () => {
    const h = await boundAdapter({ minStreamIntervalMs: 0 });
    await h.adapter.render({
      type: 'stream_append',
      conversationId: 'conv-r',
      streamId: 's1',
      chunk: 'a',
    });
    await tick();
    await h.adapter.render({
      type: 'stream_append',
      conversationId: 'conv-r',
      streamId: 's1',
      chunk: 'b',
    });
    await tick();
    expect(h.client.postMessage).toHaveBeenCalledTimes(1);
    expect(h.client.postMessage.mock.calls[0]![0].text).toBe('a');
    expect(h.client.update).toHaveBeenCalledTimes(1);
    expect(h.client.update.mock.calls[0]![0]).toMatchObject({ ts: '9999.000001', text: 'ab' });
  });

  it('stop() drains pending stream buffers before shutting Bolt down', async () => {
    const h = await boundAdapter({ minStreamIntervalMs: 60_000 });
    await h.adapter.render({
      type: 'stream_append',
      conversationId: 'conv-r',
      streamId: 's1',
      chunk: 'a',
    });
    await tick();
    // Second chunk is parked behind the 60s debounce…
    await h.adapter.render({
      type: 'stream_append',
      conversationId: 'conv-r',
      streamId: 's1',
      chunk: 'b',
    });
    await h.adapter.stop(); // …and must not be lost.
    expect(h.client.update).toHaveBeenCalledTimes(1);
    expect(h.client.update.mock.calls[0]![0]).toMatchObject({ text: 'ab' });
  });

  it('openStream returns a handle backed by the coalescer', async () => {
    const h = await boundAdapter({ minStreamIntervalMs: 0 });
    const stream = await h.adapter.openStream('conv-r');
    await stream.append('x');
    await tick();
    await stream.end();
    expect(h.client.postMessage).toHaveBeenCalledTimes(1);
    expect(h.client.postMessage.mock.calls[0]![0].text).toBe('x');
  });
});
