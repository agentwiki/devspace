/**
 * DiscordAdapter suite (m6-plan C): the whole adapter — session rooting,
 * thread binding, action routing, `!port` normalization, status
 * edit-in-place, coalesced streams — driven over a FAKE DiscordTransport
 * (Decision 7: discord.js glue is the documented-untested boundary; every
 * behavior above the seam is asserted here).
 */
import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@devspace/contracts';
import type { ChatEventResult, EmitChatEvent } from '../index.js';
import { ConversationBinding } from '../binding.js';
import type { Clock } from '../status.js';
import {
  DiscordAdapter,
  type DiscordInboundHandlers,
  type DiscordMessageEvent,
  type DiscordTransport,
} from './discord.js';
import { actionsBodies, messageBodies, statusBody, streamBody } from '../discord/messages.js';
import {
  REPO_PICKER_MODAL_PREFIX,
  SECRETS_MODAL_PREFIX,
  type DiscordModal,
} from '../discord/modals.js';

/* -------------------------------------------------------------------------- */
/* Fake transport                                                              */
/* -------------------------------------------------------------------------- */

interface Posted {
  channelId: string;
  messageId: string;
  content: string;
  components?: unknown[];
}

class FakeTransport implements DiscordTransport {
  handlers?: DiscordInboundHandlers;
  posted: Posted[] = [];
  edits: Posted[] = [];
  threads: Array<{ channelId: string; rootMessageId: string; name: string }> = [];
  modals: Array<{ interactionId: string; modal: DiscordModal }> = [];
  stopped = false;
  private counter = 0;

  async start(handlers: DiscordInboundHandlers): Promise<void> {
    this.handlers = handlers;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async postMessage(
    channelId: string,
    body: { content: string; components?: unknown[] },
  ): Promise<{ messageId: string }> {
    const messageId = `m${(this.counter += 1)}`;
    this.posted.push({ channelId, messageId, ...body });
    return { messageId };
  }
  async createThread(
    channelId: string,
    rootMessageId: string,
    name: string,
  ): Promise<{ threadId: string }> {
    this.threads.push({ channelId, rootMessageId, name });
    return { threadId: `thread-of-${rootMessageId}` };
  }
  async editMessage(
    channelId: string,
    messageId: string,
    body: { content: string; components?: unknown[] },
  ): Promise<void> {
    this.edits.push({ channelId, messageId, ...body });
  }
  async openModal(interactionId: string, modal: DiscordModal): Promise<void> {
    this.modals.push({ interactionId, modal });
  }
}

interface Harness {
  adapter: DiscordAdapter;
  transport: FakeTransport;
  events: ChatEvent[];
  binding: ConversationBinding;
  warnings: string[];
}

async function startAdapter(
  opts: {
    binding?: ConversationBinding;
    emit?: EmitChatEvent;
    clock?: Clock;
    minStreamIntervalMs?: number;
  } = {},
): Promise<Harness> {
  const transport = new FakeTransport();
  const events: ChatEvent[] = [];
  const warnings: string[] = [];
  const binding = opts.binding ?? new ConversationBinding();
  const adapter = new DiscordAdapter(transport, {
    binding,
    warn: (m) => warnings.push(m),
    clock: opts.clock,
    minStreamIntervalMs: opts.minStreamIntervalMs,
  });
  const emit: EmitChatEvent =
    opts.emit ??
    (async (event): Promise<ChatEventResult | void> => {
      events.push(event);
      if (event.type === 'conversation.created') return { conversationId: 'conv-1' };
    });
  await adapter.start(async (event) => {
    events.push(event);
    if (opts.emit) return opts.emit(event);
    if (event.type === 'conversation.created') return { conversationId: 'conv-1' };
  });
  void emit;
  return { adapter, transport, events, binding, warnings };
}

const handlers = (h: Harness): DiscordInboundHandlers => h.transport.handlers!;

const threadMessage = (over: Partial<DiscordMessageEvent> = {}): DiscordMessageEvent => ({
  channelId: 'thread-of-m1',
  parentChannelId: 'C100',
  userId: 'U7',
  content: 'add a healthcheck endpoint',
  mentionsBot: false,
  fromBot: false,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* Inbound                                                                     */
/* -------------------------------------------------------------------------- */

describe('DiscordAdapter inbound', () => {
  it('/devspace roots a message, threads it, and emits conversation.created', async () => {
    const h = await startAdapter();
    await handlers(h).slashCommand({
      channelId: 'C100',
      userId: 'U7',
      text: 'acme/widgets main',
      interactionId: 'i1',
    });

    expect(h.transport.posted[0]).toMatchObject({
      channelId: 'C100',
      content: expect.stringContaining('Starting a devspace session'),
    });
    expect(h.transport.threads).toEqual([
      { channelId: 'C100', rootMessageId: 'm1', name: 'devspace session' },
    ]);
    expect(h.events).toEqual([
      {
        type: 'conversation.created',
        platform: 'discord',
        externalChannelId: 'C100:thread-of-m1',
        userId: 'U7',
        repoChoice: { repoUrl: 'https://github.com/acme/widgets', ref: 'main', empty: false },
      },
    ]);
    // The returned id is bound so subsequent thread replies route.
    await handlers(h).message(threadMessage());
    expect(h.events.at(-1)).toMatchObject({ type: 'message.posted', conversationId: 'conv-1' });
  });

  it('a mention in a plain channel roots a session (mentions stripped)', async () => {
    const h = await startAdapter();
    await handlers(h).message(
      threadMessage({
        channelId: 'C200',
        parentChannelId: undefined,
        content: '<@BOT1> acme/widgets',
        mentionsBot: true,
      }),
    );
    expect(h.transport.threads).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'conversation.created',
      repoChoice: { repoUrl: 'https://github.com/acme/widgets' },
    });
  });

  it('a mention inside an unbound thread adopts it; inside a bound thread it is a message', async () => {
    const h = await startAdapter();
    await handlers(h).message(
      threadMessage({ content: '<@BOT1> acme/widgets', mentionsBot: true }),
    );
    expect(h.events[0]).toMatchObject({
      type: 'conversation.created',
      externalChannelId: 'C100:thread-of-m1',
    });
    // Now bound — the next mention is a plain message with mentions stripped.
    await handlers(h).message(threadMessage({ content: '<@BOT1> continue', mentionsBot: true }));
    expect(h.events.at(-1)).toEqual({
      type: 'message.posted',
      conversationId: 'conv-1',
      userId: 'U7',
      text: 'continue',
    });
  });

  it('routes replies only in bound threads and never echoes bots', async () => {
    const h = await startAdapter();
    await handlers(h).message(threadMessage()); // unbound thread, no mention
    expect(h.events).toEqual([]);
    await handlers(h).message(threadMessage({ fromBot: true, mentionsBot: true }));
    expect(h.events).toEqual([]);
    // Plain channel chatter without a mention is ignored too.
    await handlers(h).message(threadMessage({ parentChannelId: undefined }));
    expect(h.events).toEqual([]);
  });

  it('`!port <n>` in a bound thread becomes the expose-port action (M6)', async () => {
    const h = await startAdapter();
    h.binding.bind('conv-p', { channel: 'C100', threadTs: 'thread-of-m1' });
    await handlers(h).message(threadMessage({ content: '!port 3000' }));
    expect(h.events).toEqual([
      {
        type: 'action.invoked',
        conversationId: 'conv-p',
        userId: 'U7',
        actionId: 'expose-port:3000',
        payload: {},
      },
    ]);
  });

  it('button presses emit action.invoked with the raw customId', async () => {
    const h = await startAdapter();
    h.binding.bind('conv-b', { channel: 'C100', threadTs: 'thread-of-m1' });
    await handlers(h).button({
      channelId: 'thread-of-m1',
      parentChannelId: 'C100',
      userId: 'U7',
      customId: 'approve:req-42',
      interactionId: 'i2',
    });
    expect(h.events).toEqual([
      {
        type: 'action.invoked',
        conversationId: 'conv-b',
        userId: 'U7',
        actionId: 'approve:req-42',
        payload: {},
      },
    ]);
    // Buttons outside threads (or unbound threads) are ignored.
    await handlers(h).button({
      channelId: 'C100',
      userId: 'U7',
      customId: 'view-pr',
      interactionId: 'i3',
    });
    await handlers(h).button({
      channelId: 'thread-of-m9',
      parentChannelId: 'C100',
      userId: 'U7',
      customId: 'view-pr',
      interactionId: 'i4',
    });
    expect(h.events).toHaveLength(1);
  });

  it('a throwing emit is contained (emitSafe) and warned, never rethrown', async () => {
    const h = await startAdapter({
      emit: async () => {
        throw new Error('orchestrator down');
      },
    });
    await expect(
      handlers(h).slashCommand({
        channelId: 'C100',
        userId: 'U7',
        text: 'acme/widgets',
        interactionId: 'i5',
      }),
    ).resolves.toBeUndefined();
    expect(h.warnings.some((w) => w.includes('orchestrator down'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Modals (M7-B)                                                               */
/* -------------------------------------------------------------------------- */

describe('DiscordAdapter modals', () => {
  it('bare /devspace opens the repo picker and creates nothing', async () => {
    const h = await startAdapter();
    await handlers(h).slashCommand({
      channelId: 'C100',
      userId: 'U7',
      text: '',
      interactionId: 'i1',
    });
    expect(h.transport.modals).toEqual([
      {
        interactionId: 'i1',
        modal: expect.objectContaining({ custom_id: `${REPO_PICKER_MODAL_PREFIX}:C100` }),
      },
    ]);
    // Dismissal-shaped flow: no submission ever arrives — nothing was created.
    expect(h.events).toEqual([]);
    expect(h.transport.threads).toEqual([]);
  });

  it('a repo-picker submission roots a session exactly like the arg path', async () => {
    const h = await startAdapter();
    await handlers(h).modalSubmit({
      customId: `${REPO_PICKER_MODAL_PREFIX}:C100`,
      userId: 'U7',
      fields: { repo: 'acme/widgets', ref: 'main' },
    });
    expect(h.transport.threads).toEqual([
      { channelId: 'C100', rootMessageId: 'm1', name: 'devspace session' },
    ]);
    expect(h.events).toEqual([
      {
        type: 'conversation.created',
        platform: 'discord',
        externalChannelId: 'C100:thread-of-m1',
        userId: 'U7',
        repoChoice: { repoUrl: 'https://github.com/acme/widgets', ref: 'main', empty: false },
      },
    ]);
  });

  it('the set-secrets button opens the secrets modal with the thread ref in its custom_id', async () => {
    const h = await startAdapter();
    await handlers(h).button({
      channelId: 'thread-of-m1',
      parentChannelId: 'C100',
      userId: 'U7',
      customId: 'set-secrets',
      interactionId: 'i9',
    });
    expect(h.transport.modals).toEqual([
      {
        interactionId: 'i9',
        modal: expect.objectContaining({
          custom_id: `${SECRETS_MODAL_PREFIX}:C100:thread-of-m1`,
        }),
      },
    ]);
    // Pure platform UI: nothing reached the orchestrator.
    expect(h.events).toEqual([]);
  });

  it('a secrets submission emits one secret.submitted per FILLED field', async () => {
    const h = await startAdapter();
    h.binding.bind('conv-s', { channel: 'C100', threadTs: 'thread-of-m1' });
    await handlers(h).modalSubmit({
      customId: `${SECRETS_MODAL_PREFIX}:C100:thread-of-m1`,
      userId: 'U7',
      fields: { llm_key: ' sk-123 ', github_token: '', github_clone_token: 'ghp_ro' },
    });
    expect(h.events).toEqual([
      {
        type: 'secret.submitted',
        conversationId: 'conv-s',
        userId: 'U7',
        name: 'LLM_KEY',
        value: 'sk-123',
      },
      {
        type: 'secret.submitted',
        conversationId: 'conv-s',
        userId: 'U7',
        name: 'GITHUB_CLONE_TOKEN',
        value: 'ghp_ro',
      },
    ]);
  });

  it('malformed or unbound modal submissions are dropped, never thrown', async () => {
    const h = await startAdapter();
    // No prefix separator at all.
    await handlers(h).modalSubmit({ customId: 'garbage', userId: 'U7', fields: {} });
    // Unknown prefix.
    await handlers(h).modalSubmit({ customId: 'other:thing', userId: 'U7', fields: {} });
    // Secrets for a thread that is not a devspace session (unbound).
    await handlers(h).modalSubmit({
      customId: `${SECRETS_MODAL_PREFIX}:C9:T9`,
      userId: 'U7',
      fields: { llm_key: 'sk-x' },
    });
    // Malformed ref inside a secrets id (no channel:thread shape).
    await handlers(h).modalSubmit({
      customId: `${SECRETS_MODAL_PREFIX}:noshape`,
      userId: 'U7',
      fields: { llm_key: 'sk-x' },
    });
    expect(h.events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Outbound                                                                    */
/* -------------------------------------------------------------------------- */

async function boundAdapter(clock?: Clock): Promise<Harness> {
  const binding = new ConversationBinding();
  binding.bind('conv-1', { channel: 'C100', threadTs: 'T1' });
  return startAdapter({ binding, clock, minStreamIntervalMs: 1000 });
}

describe('DiscordAdapter outbound', () => {
  it('post_message posts every chunk into the thread', async () => {
    const h = await boundAdapter();
    const long = `${'x'.repeat(1990)}\n${'y'.repeat(100)}`;
    await h.adapter.render({ type: 'post_message', conversationId: 'conv-1', text: long });
    const bodies = messageBodies(long);
    expect(bodies).toHaveLength(2);
    expect(h.transport.posted.map((p) => p.channelId)).toEqual(['T1', 'T1']);
    expect(h.transport.posted.map((p) => p.content)).toEqual(bodies.map((b) => b.content));
  });

  it('update_status posts once then edits the same message in place', async () => {
    const h = await boundAdapter();
    await h.adapter.render({
      type: 'update_status',
      conversationId: 'conv-1',
      state: 'PROVISIONING',
      text: 'Provisioning…',
    });
    await h.adapter.render({
      type: 'update_status',
      conversationId: 'conv-1',
      state: 'READY',
      text: 'Environment ready.',
    });
    expect(h.transport.posted).toHaveLength(1);
    expect(h.transport.posted[0]!.content).toBe(
      statusBody('PROVISIONING', 'Provisioning…').content,
    );
    expect(h.transport.edits).toEqual([
      {
        channelId: 'T1',
        messageId: h.transport.posted[0]!.messageId,
        content: statusBody('READY', 'Environment ready.').content,
      },
    ]);
  });

  it('post_actions carries button rows with stable custom_ids', async () => {
    const h = await boundAdapter();
    const actions = [
      { actionId: 'create-pr', label: 'Create PR', style: 'primary' as const },
      { actionId: 'view-pr', label: 'View PR', style: 'secondary' as const },
    ];
    await h.adapter.render({
      type: 'post_actions',
      conversationId: 'conv-1',
      text: 'Ready to ship?',
      actions,
    });
    expect(h.transport.posted).toHaveLength(1);
    expect(h.transport.posted[0]!.components).toEqual(
      actionsBodies('Ready to ship?', actions)[0]!.components,
    );
  });

  it('stream_append coalesces: one post, then rate-limited full-text edits', async () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const clock: Clock = {
      now: () => now,
      setTimeout: (fn, ms) => {
        const t = { at: now + ms, fn };
        timers.push(t);
        return t;
      },
      clearTimeout: (handle) => {
        const i = timers.indexOf(handle as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const h = await boundAdapter(clock);

    await h.adapter.render({
      type: 'stream_append',
      conversationId: 'conv-1',
      streamId: 's1',
      chunk: 'first ',
    });
    await Promise.resolve();
    expect(h.transport.posted).toHaveLength(1);
    expect(h.transport.posted[0]!.content).toBe('first ');

    // Within the interval: buffered, not shipped.
    await h.adapter.render({
      type: 'stream_append',
      conversationId: 'conv-1',
      streamId: 's1',
      chunk: 'second',
    });
    expect(h.transport.edits).toHaveLength(0);

    // Fire the debounce timer — the edit carries the FULL accumulated text.
    now = 1000;
    const due = timers.splice(0, timers.length);
    for (const t of due) t.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.transport.edits).toEqual([
      { channelId: 'T1', messageId: 'm1', content: 'first second' },
    ]);
  });

  it('a long stream shows the tail under Discord’s 2000-char cap', () => {
    const text = 'a'.repeat(3000);
    const body = streamBody(text);
    expect(body.content).toHaveLength(2000);
    expect(body.content.startsWith('…')).toBe(true);
  });

  it('never throws from render: unbound conversations and transport failures warn', async () => {
    const h = await startAdapter(); // nothing bound
    await expect(
      h.adapter.render({ type: 'post_message', conversationId: 'conv-x', text: 'hi' }),
    ).resolves.toBeUndefined();
    expect(h.warnings.some((w) => w.includes('no thread bound'))).toBe(true);

    const bound = await boundAdapter();
    bound.transport.postMessage = async () => {
      throw new Error('discord 500');
    };
    await expect(
      bound.adapter.render({ type: 'post_message', conversationId: 'conv-1', text: 'hi' }),
    ).resolves.toBeUndefined();
    expect(bound.warnings.some((w) => w.includes('discord 500'))).toBe(true);
  });

  it('stop drains pending stream buffers before disconnecting', async () => {
    const now = 0;
    const clock: Clock = {
      now: () => now,
      setTimeout: () => ({}),
      clearTimeout: () => {},
    };
    const h = await boundAdapter(clock);
    await h.adapter.render({
      type: 'stream_append',
      conversationId: 'conv-1',
      streamId: 's1',
      chunk: 'only',
    });
    await Promise.resolve();
    h.transport.posted = [];
    // Buffer a second chunk inside the interval, then stop: it must flush.
    await h.adapter.render({
      type: 'stream_append',
      conversationId: 'conv-1',
      streamId: 's1',
      chunk: ' chunk',
    });
    await h.adapter.stop();
    expect(h.transport.stopped).toBe(true);
    expect(h.transport.edits.at(-1)?.content).toBe('only chunk');
  });
});
