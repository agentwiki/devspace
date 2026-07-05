/**
 * Discord adapter (additional surface) — the M6 implementation.
 *
 * Mirrors the Slack adapter's model exactly: a session IS a thread. `/devspace`
 * (or a mention) roots a message and creates a thread from it; replies in a
 * bound thread are `message.posted` (with the shared `!port` normalization);
 * button presses are `action.invoked` with the raw customId (the same stable
 * action ids); renders come back as plain-markdown messages, an edited-in-place
 * status line, button rows, and coalesced stream edits (same StatusRegistry /
 * StreamCoalescer as Slack).
 *
 * All of that logic codes against the thin `DiscordTransport` seam and is
 * tested over a fake (m6-plan Decision 7) — discord.js objects are deep class
 * instances that can't be replayed offline the way Bolt payload fixtures can.
 * The real discord.js glue lives in ../discord/transport.js and is the
 * documented-untested boundary, like Bolt's own WebSocket internals in M4.
 *
 * The binding reuses the generic `<channel>:<thread>` codec: `channel` is the
 * parent channel id, `thread` the thread (itself a channel in Discord).
 */
import type { ChatPlatform, RenderCommand, RepoChoice } from '@devspace/contracts';
import type {
  ChatAdapter,
  ChatRenderer,
  EmitChatEvent,
  MessageRef,
  StreamHandle,
} from '../index.js';
import { parseHistoryCommand, parsePortCommand } from '../index.js';
import { ConversationBinding, decodeRef, encodeRef, type ThreadRef } from '../binding.js';
import { StatusRegistry, StreamCoalescer, type Clock } from '../status.js';
import {
  actionsBodies,
  messageBodies,
  sessionListBody,
  statusBody,
  streamBody,
  type DiscordMessageBody,
} from '../discord/messages.js';
import type { HomeSession } from '../slack/blocks.js';
import {
  REPO_PICKER_MODAL_PREFIX,
  SECRETS_MODAL_PREFIX,
  decodeModalId,
  parseRepoPickerSubmission,
  parseSecretsSubmission,
  repoPickerModal,
  secretsModal,
  type DiscordModal,
  type ModalFields,
} from '../discord/modals.js';
import { choiceFromSubmission, parseRepoChoice } from './slack.js';

/* -------------------------------------------------------------------------- */
/* The transport seam                                                          */
/* -------------------------------------------------------------------------- */

export interface DiscordSlashEvent {
  /** Which slash command fired: `/devspace` or `/sessions` (M7-C). */
  command: 'devspace' | 'sessions';
  channelId: string;
  userId: string;
  /** The command's raw argument text ("<repoUrl> [ref]", possibly empty). */
  text: string;
  /** Opaque handle for `openModal`/`replyEphemeral` (the trigger_id equivalent). */
  interactionId: string;
}

export interface DiscordMessageEvent {
  /** Channel the message was posted in (the THREAD id for thread messages). */
  channelId: string;
  /** The thread's parent channel — set iff the message is inside a thread. */
  parentChannelId?: string;
  userId: string;
  content: string;
  mentionsBot: boolean;
  fromBot: boolean;
}

export interface DiscordButtonEvent {
  channelId: string;
  parentChannelId?: string;
  userId: string;
  customId: string;
  /** Opaque handle for `openModal` (Discord's trigger_id equivalent, M7-B). */
  interactionId: string;
}

/** A modal submission (M7-B): the modal's custom_id carries the context —
 * `devspace-secrets:<ref>` / `devspace-repo-picker:<channel>` (Decision 5). */
export interface DiscordModalSubmitEvent {
  customId: string;
  userId: string;
  fields: ModalFields;
}

export interface DiscordInboundHandlers {
  slashCommand(event: DiscordSlashEvent): Promise<void>;
  message(event: DiscordMessageEvent): Promise<void>;
  button(event: DiscordButtonEvent): Promise<void>;
  modalSubmit(event: DiscordModalSubmitEvent): Promise<void>;
}

/**
 * Everything the adapter needs from Discord, and nothing more. The real
 * implementation wraps discord.js; tests inject a fake.
 */
export interface DiscordTransport {
  start(handlers: DiscordInboundHandlers): Promise<void>;
  stop(): Promise<void>;
  postMessage(channelId: string, body: DiscordMessageBody): Promise<{ messageId: string }>;
  /** Create a thread rooted at an existing message. */
  createThread(
    channelId: string,
    rootMessageId: string,
    name: string,
  ): Promise<{ threadId: string }>;
  editMessage(channelId: string, messageId: string, body: DiscordMessageBody): Promise<void>;
  /** Show a modal AS the response to a still-unacked interaction (M7-B). */
  openModal(interactionId: string, modal: DiscordModal): Promise<void>;
  /** Reply ephemerally to a still-unacked interaction (`/sessions`, M7-C). */
  replyEphemeral(interactionId: string, body: DiscordMessageBody): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

export interface DiscordAdapterOptions {
  /** Wired with orchestrator-backed cold-miss resolvers by the service. */
  binding?: ConversationBinding;
  /** `/sessions` list source (the App Home read); default = empty-state hint. */
  listSessions?: (discordUserId: string) => Promise<HomeSession[]>;
  /** Stream flush interval (default 1000ms — Discord edits are rate-limited too). */
  minStreamIntervalMs?: number;
  clock?: Clock;
  /** Render-path warnings (unbound conversation, transport failure). */
  warn?: (message: string) => void;
  /** Thread name for new sessions. */
  threadName?: string;
}

/** Strip <@…> user/role mentions (Discord's wire form matches Slack's shape). */
function stripMentions(text: string): string {
  return text.replace(/<@[!&]?[^>]+>/g, ' ').trim();
}

/** decodeRef that maps a malformed modal context to null instead of throwing. */
function decodeRefSafe(externalChannelId: string): ThreadRef | null {
  try {
    return decodeRef(externalChannelId);
  } catch {
    return null;
  }
}

interface StreamState {
  conversationId: string;
  messageId?: string;
}

export class DiscordAdapter implements ChatAdapter, ChatRenderer {
  readonly platform: ChatPlatform = 'discord';

  private readonly binding: ConversationBinding;
  private readonly status = new StatusRegistry();
  private readonly coalescer: StreamCoalescer;
  private readonly streams = new Map<string, StreamState>();
  private readonly warn: (message: string) => void;
  private readonly threadName: string;
  private readonly listSessions?: (discordUserId: string) => Promise<HomeSession[]>;
  private streamCounter = 0;
  private emit?: EmitChatEvent;

  constructor(
    private readonly transport: DiscordTransport,
    opts: DiscordAdapterOptions = {},
  ) {
    this.binding = opts.binding ?? new ConversationBinding();
    this.warn = opts.warn ?? ((message) => console.warn(`[discord] ${message}`));
    this.threadName = opts.threadName ?? 'devspace session';
    this.listSessions = opts.listSessions;
    this.coalescer = new StreamCoalescer((streamId, text) => this.flushStream(streamId, text), {
      minIntervalMs: opts.minStreamIntervalMs,
      clock: opts.clock,
      onError: (streamId, err) => this.warn(`stream ${streamId} flush failed: ${String(err)}`),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Inbound: Discord -> ChatEvent                                       */
  /* ------------------------------------------------------------------ */

  async start(emit: EmitChatEvent): Promise<void> {
    this.emit = emit;
    await this.transport.start({
      slashCommand: async ({ command, channelId, userId, text, interactionId }) => {
        // `/sessions` (M7-C): the ephemeral session list, same read as App Home.
        if (command === 'sessions') {
          const sessions = (await this.listSessions?.(userId)) ?? [];
          await this.transport.replyEphemeral(interactionId, sessionListBody(sessions));
          return;
        }
        // Bare `/devspace` opens the repo picker instead of an empty session
        // (m6-plan Decision 9, Discord edition) — dismissal creates nothing.
        if (!text.trim()) {
          await this.transport.openModal(interactionId, repoPickerModal(channelId));
          return;
        }
        await this.rootConversation(channelId, userId, parseRepoChoice(text));
      },

      message: async (event) => {
        if (event.fromBot) return;
        const inThread = event.parentChannelId !== undefined;
        if (inThread) {
          const ref: ThreadRef = { channel: event.parentChannelId!, threadTs: event.channelId };
          const conversationId = await this.binding.conversationFor(ref);
          if (conversationId) {
            const text = event.mentionsBot ? stripMentions(event.content) : event.content;
            // `!port <n>` is chat ergonomics for the expose-port action (M6).
            const port = parsePortCommand(text);
            if (port !== null) {
              await this.emitSafe({
                type: 'action.invoked',
                conversationId,
                userId: event.userId,
                actionId: `expose-port:${port}`,
                payload: {},
              });
              return;
            }
            // `!history` replays the durable transcript (M21) — same shape.
            if (parseHistoryCommand(text)) {
              await this.emitSafe({
                type: 'action.invoked',
                conversationId,
                userId: event.userId,
                actionId: 'view-history',
                payload: {},
              });
              return;
            }
            await this.emitSafe({
              type: 'message.posted',
              conversationId,
              userId: event.userId,
              text,
            });
            return;
          }
          // A mention in an unbound thread adopts it as a session (the Slack
          // app_mention parallel); anything else in a foreign thread is noise.
          if (event.mentionsBot) {
            await this.createConversation(ref, event.userId, {
              choice: parseRepoChoice(stripMentions(event.content)),
            });
          }
          return;
        }
        // A mention in a plain channel roots a fresh session thread.
        if (event.mentionsBot) {
          await this.rootConversation(
            event.channelId,
            event.userId,
            parseRepoChoice(stripMentions(event.content)),
          );
        }
      },

      button: async (event) => {
        if (event.parentChannelId === undefined) return; // session buttons live in threads
        const ref: ThreadRef = { channel: event.parentChannelId, threadTs: event.channelId };
        // set-secrets is pure platform UI (m6-plan Decision 8): the modal IS
        // the interaction response — no orchestrator round-trip here (M7-B).
        if (event.customId === 'set-secrets') {
          await this.transport.openModal(event.interactionId, secretsModal(encodeRef(ref)));
          return;
        }
        const conversationId = await this.binding.conversationFor(ref);
        if (!conversationId) return;
        await this.emitSafe({
          type: 'action.invoked',
          conversationId,
          userId: event.userId,
          actionId: event.customId,
          payload: {},
        });
      },

      modalSubmit: async (event) => {
        const decoded = decodeModalId(event.customId);
        if (!decoded) return;
        if (decoded.prefix === SECRETS_MODAL_PREFIX) {
          await this.onSecretsSubmitted(decoded.context, event.userId, event.fields);
          return;
        }
        if (decoded.prefix === REPO_PICKER_MODAL_PREFIX) {
          await this.rootConversation(
            decoded.context,
            event.userId,
            choiceFromSubmission(parseRepoPickerSubmission(event.fields)),
          );
        }
      },
    });
  }

  /** One `secret.submitted` per filled field — same semantics as the Slack
   * modal (the event path, whitelist and redaction hooks are shared). */
  private async onSecretsSubmitted(
    encodedRef: string,
    userId: string,
    fields: ModalFields,
  ): Promise<void> {
    const ref = decodeRefSafe(encodedRef);
    if (!ref) return;
    const conversationId = await this.binding.conversationFor(ref);
    if (!conversationId) return;
    for (const { name, value } of parseSecretsSubmission(fields)) {
      await this.emitSafe({ type: 'secret.submitted', conversationId, userId, name, value });
    }
  }

  async stop(): Promise<void> {
    await this.coalescer.endAll();
    await this.transport.stop();
  }

  /** Root a session: post the root message, thread it, bind, emit created. */
  private async rootConversation(
    channelId: string,
    userId: string,
    choice: RepoChoice,
  ): Promise<void> {
    const root = await this.transport.postMessage(channelId, {
      content: 'Starting a devspace session in this thread…',
    });
    const { threadId } = await this.transport.createThread(
      channelId,
      root.messageId,
      this.threadName,
    );
    await this.createConversation({ channel: channelId, threadTs: threadId }, userId, { choice });
  }

  private async createConversation(
    ref: ThreadRef,
    userId: string,
    { choice }: { choice: RepoChoice },
  ): Promise<void> {
    const result = await this.emitSafe({
      type: 'conversation.created',
      platform: 'discord',
      externalChannelId: encodeRef(ref),
      userId,
      repoChoice: choice,
    });
    // Warm the cache for everything after this event; renders emitted DURING
    // handleChatEvent are covered by the binding's DB-backed resolvers (M4).
    if (result?.conversationId) this.binding.bind(result.conversationId, ref);
  }

  private async emitSafe(
    event: Parameters<EmitChatEvent>[0],
  ): Promise<Awaited<ReturnType<EmitChatEvent>>> {
    if (!this.emit) throw new Error('DiscordAdapter not started');
    try {
      return await this.emit(event);
    } catch (err) {
      this.warn(`emit ${event.type} failed: ${String(err)}`);
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Outbound: RenderCommand -> Discord                                  */
  /* ------------------------------------------------------------------ */

  async render(command: RenderCommand): Promise<MessageRef | void> {
    try {
      return await this.renderUnsafe(command);
    } catch (err) {
      // The render path never throws (M4 discipline): log and drop.
      this.warn(`render ${command.type} for ${command.conversationId} failed: ${String(err)}`);
    }
  }

  private async renderUnsafe(command: RenderCommand): Promise<MessageRef | void> {
    if (command.type === 'stream_append') {
      let stream = this.streams.get(command.streamId);
      if (!stream) {
        stream = { conversationId: command.conversationId };
        this.streams.set(command.streamId, stream);
      }
      this.coalescer.append(command.streamId, command.chunk);
      return;
    }

    const ref = await this.binding.refForAsync(command.conversationId);
    if (!ref) {
      this.warn(`no thread bound for conversation ${command.conversationId}; dropping render`);
      return;
    }
    const threadId = ref.threadTs;

    switch (command.type) {
      case 'post_message':
        return this.postBodies(command.conversationId, threadId, messageBodies(command.text));
      case 'update_status': {
        const body = statusBody(command.state, command.text);
        const existing = this.status.get(command.conversationId);
        if (existing) {
          await this.transport.editMessage(threadId, existing, body);
          return { conversationId: command.conversationId, messageId: existing };
        }
        const { messageId } = await this.transport.postMessage(threadId, body);
        this.status.set(command.conversationId, messageId);
        return { conversationId: command.conversationId, messageId };
      }
      case 'post_actions':
        return this.postBodies(
          command.conversationId,
          threadId,
          actionsBodies(command.text, command.actions),
        );
    }
  }

  private async postBodies(
    conversationId: string,
    threadId: string,
    bodies: DiscordMessageBody[],
  ): Promise<MessageRef> {
    let last = { messageId: '' };
    for (const body of bodies) last = await this.transport.postMessage(threadId, body);
    return { conversationId, messageId: last.messageId };
  }

  async openStream(conversationId: string): Promise<StreamHandle> {
    const streamId = `${conversationId}#${(this.streamCounter += 1)}`;
    this.streams.set(streamId, { conversationId });
    return {
      streamId,
      append: async (chunk) => this.coalescer.append(streamId, chunk),
      end: async () => this.coalescer.end(streamId),
    };
  }

  /** Coalescer flush: first delivery posts the stream message, later ones edit it. */
  private async flushStream(streamId: string, text: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    const ref = await this.binding.refForAsync(stream.conversationId);
    if (!ref) {
      this.warn(`no thread bound for stream ${streamId}; dropping flush`);
      return;
    }
    const body = streamBody(text);
    if (!stream.messageId) {
      const { messageId } = await this.transport.postMessage(ref.threadTs, body);
      stream.messageId = messageId;
      return;
    }
    await this.transport.editMessage(ref.threadTs, stream.messageId, body);
  }
}
