/**
 * Slack adapter (primary surface) — the M4 transport. Bolt over Socket Mode:
 *   - /devspace [repoUrl] [ref] or an app mention -> conversation.created
 *     (the adapter roots/adopts a thread; its ref is the externalChannelId)
 *   - human reply in a bound thread               -> message.posted
 *   - Block Kit button                            -> action.invoked (raw action_id)
 *   - app_home_opened                             -> views.publish session list
 * and renders RenderCommands via the pure builders in ../slack/blocks.js:
 * post_message (thread reply), update_status (in-place chat.update of one
 * status message), post_actions, stream_append (coalesced chat.update).
 *
 * The Web API and the Bolt receiver are injected in tests (fake client +
 * recorded payload fixtures through App.processEvent) — no live Slack; the
 * render path never throws (unbound/failed renders are logged and dropped).
 */
import { App, SocketModeReceiver } from '@slack/bolt';
import type { AppOptions, Receiver } from '@slack/bolt';
import type { ChatPlatform, RenderCommand, RepoChoice } from '@devspace/contracts';
import type {
  ChatAdapter,
  ChatRenderer,
  EmitChatEvent,
  MessageRef,
  StreamHandle,
} from '../index.js';
import { parsePortCommand } from '../index.js';
import { ConversationBinding, decodeRef, encodeRef, type ThreadRef } from '../binding.js';
import { StatusRegistry, StreamCoalescer, type Clock } from '../status.js';
import {
  REPO_PICKER_CALLBACK_ID,
  SECRETS_CALLBACK_ID,
  actionsBlocks,
  homeView,
  messageBlocks,
  parseRepoPickerSubmission,
  parseSecretsSubmission,
  repoPickerModal,
  secretsModal,
  statusBlocks,
  streamBlocks,
  type HomeSession,
  type SlackMessage,
  type ViewStateValues,
} from '../slack/blocks.js';

export interface SlackConfig {
  /** Bot User OAuth token (xoxb-…). */
  botToken: string;
  /** App-level token (xapp-…) for Socket Mode. */
  appToken: string;
  /** Signing secret; used when running over HTTP events instead of Socket Mode. */
  signingSecret?: string;
}

/** The (tiny) Web API surface the renderer needs; injected as a fake in tests. */
export interface SlackWebClient {
  postMessage(args: {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: unknown[];
  }): Promise<{ ts: string }>;
  update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
  publishHome(args: { userId: string; view: unknown }): Promise<void>;
  /** views.open — the secret-entry and repo-picker modals (M6-D). */
  openView(args: { trigger_id: string; view: unknown }): Promise<void>;
}

export interface SlackAdapterOptions {
  /** Injected in tests; default is a SocketModeReceiver over config.appToken. */
  receiver?: Receiver;
  /** Injected in tests; default wraps Bolt's own WebClient. */
  client?: SlackWebClient;
  /** Injected in tests to keep App construction offline (no auth.test). */
  authorize?: AppOptions['authorize'];
  /** Wired with orchestrator-backed cold-miss resolvers by the service (E). */
  binding?: ConversationBinding;
  /** App Home session list source; default renders the empty-state hint. */
  listSessions?: (slackUserId: string) => Promise<HomeSession[]>;
  /** Stream flush interval (default 1000ms — Slack's chat.update budget). */
  minStreamIntervalMs?: number;
  clock?: Clock;
  /** Render-path warnings (unbound conversation, transport failure). */
  warn?: (message: string) => void;
}

/** Parse "/devspace <repoUrl|owner/repo> [ref]" text into a RepoChoice. */
export function parseRepoChoice(text: string): RepoChoice {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return { empty: true };
  // Slack auto-links URLs: "<https://…>" or "<https://…|label>".
  let repoUrl = first.replace(/^<([^|>]+)(\|[^>]*)?>$/, '$1');
  if (/^[\w.-]+\/[\w.-]+$/.test(repoUrl)) repoUrl = `https://github.com/${repoUrl}`;
  try {
    new URL(repoUrl);
  } catch {
    return { empty: true };
  }
  return { repoUrl, ref: tokens[1], empty: false };
}

/** Strip leading/inline bot mentions from an app_mention text. */
function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, ' ').trim();
}

const ACTION_ID_PATTERN = /^((approve|deny):.+|create-pr|view-pr)$/;

/** decodeRef that maps malformed metadata to null instead of throwing. */
function decodeRefSafe(externalChannelId: string): ThreadRef | null {
  try {
    return decodeRef(externalChannelId);
  } catch {
    return null;
  }
}

interface StreamState {
  conversationId: string;
  ts?: string;
}

export class SlackAdapter implements ChatAdapter, ChatRenderer {
  readonly platform: ChatPlatform = 'slack';

  private readonly binding: ConversationBinding;
  private readonly status = new StatusRegistry();
  private readonly coalescer: StreamCoalescer;
  private readonly streams = new Map<string, StreamState>();
  private readonly warn: (message: string) => void;
  private streamCounter = 0;
  private app?: App;
  private client?: SlackWebClient;
  private emit?: EmitChatEvent;

  constructor(
    private readonly config: SlackConfig,
    private readonly opts: SlackAdapterOptions = {},
  ) {
    this.binding = opts.binding ?? new ConversationBinding();
    this.client = opts.client;
    this.warn = opts.warn ?? ((message) => console.warn(`[slack] ${message}`));
    this.coalescer = new StreamCoalescer((streamId, text) => this.flushStream(streamId, text), {
      minIntervalMs: opts.minStreamIntervalMs,
      clock: opts.clock,
      onError: (streamId, err) => this.warn(`stream ${streamId} flush failed: ${String(err)}`),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Inbound: Slack -> ChatEvent                                         */
  /* ------------------------------------------------------------------ */

  async start(emit: EmitChatEvent): Promise<void> {
    this.emit = emit;
    const receiver =
      this.opts.receiver ?? new SocketModeReceiver({ appToken: this.config.appToken });
    // Bolt rejects token+authorize together; tests inject authorize to stay offline.
    const app = this.opts.authorize
      ? new App({ receiver, authorize: this.opts.authorize })
      : new App({ receiver, token: this.config.botToken });
    this.app = app;
    this.client ??= {
      postMessage: async (args) => {
        const res = await app.client.chat.postMessage(
          args as Parameters<typeof app.client.chat.postMessage>[0],
        );
        return { ts: res.ts ?? '' };
      },
      update: async (args) => {
        await app.client.chat.update(args as Parameters<typeof app.client.chat.update>[0]);
      },
      publishHome: async ({ userId, view }) => {
        await app.client.views.publish({
          user_id: userId,
          view: view as Parameters<typeof app.client.views.publish>[0]['view'],
        });
      },
      openView: async ({ trigger_id, view }) => {
        await app.client.views.open({
          trigger_id,
          view: view as Parameters<typeof app.client.views.open>[0]['view'],
        });
      },
    };

    app.command('/devspace', async ({ command, ack }) => {
      await ack();
      // Bare `/devspace` opens the repo picker instead of an empty session
      // (m6-plan Decision 9) — dismissal creates nothing.
      if (!(command.text ?? '').trim()) {
        await this.mustClient().openView({
          trigger_id: command.trigger_id,
          view: repoPickerModal(command.channel_id),
        });
        return;
      }
      await this.rootThreadConversation(
        command.channel_id,
        command.user_id,
        parseRepoChoice(command.text ?? ''),
      );
    });

    app.event('app_mention', async ({ event }) => {
      const userId = event.user;
      if (!userId) return;
      const ref: ThreadRef = { channel: event.channel, threadTs: event.thread_ts ?? event.ts };
      const text = stripMentions(event.text ?? '');
      const existing = await this.binding.conversationFor(ref);
      if (existing) {
        // A mention inside a bound thread is just a message (the message
        // listener defers mention-texts to this handler — no double emit).
        await this.emitSafe({ type: 'message.posted', conversationId: existing, userId, text });
        return;
      }
      await this.createConversation(ref, userId, parseRepoChoice(text));
    });

    app.message(async ({ message, context }) => {
      // Only plain human replies inside a thread; Bolt's ignoreSelf already
      // filtered our own posts. Mention-texts belong to the app_mention path.
      if (message.subtype !== undefined) return;
      const { user, text, ts, thread_ts: threadTs, channel } = message;
      if (!user || !threadTs || threadTs === ts) return;
      if (context.botUserId && (text ?? '').includes(`<@${context.botUserId}>`)) return;
      const conversationId = await this.binding.conversationFor({ channel, threadTs });
      if (!conversationId) return; // not a devspace thread
      // `!port <n>` is chat ergonomics for the expose-port action (M6) — it
      // must not reach the agent as a prompt.
      const port = parsePortCommand(text ?? '');
      if (port !== null) {
        await this.emitSafe({
          type: 'action.invoked',
          conversationId,
          userId: user,
          actionId: `expose-port:${port}`,
          payload: {},
        });
        return;
      }
      await this.emitSafe({
        type: 'message.posted',
        conversationId,
        userId: user,
        text: text ?? '',
      });
    });

    app.action(ACTION_ID_PATTERN, async ({ ack, body, action }) => {
      await ack();
      if (body.type !== 'block_actions' || !('action_id' in action)) return;
      const channel = body.channel?.id;
      const message = body.message as { ts?: string; thread_ts?: string } | undefined;
      const threadTs = message?.thread_ts ?? message?.ts;
      if (!channel || !threadTs) return;
      const conversationId = await this.binding.conversationFor({ channel, threadTs });
      if (!conversationId) return;
      await this.emitSafe({
        type: 'action.invoked',
        conversationId,
        userId: body.user.id,
        actionId: action.action_id,
        payload: {},
      });
    });

    // set-secrets is pure platform UI: it opens the modal and never reaches
    // the orchestrator (m6-plan Decision 8). The thread ref rides
    // private_metadata so the submission needs no channel context.
    app.action('set-secrets', async ({ ack, body }) => {
      await ack();
      if (body.type !== 'block_actions') return;
      const channel = body.channel?.id;
      const message = body.message as { ts?: string; thread_ts?: string } | undefined;
      const threadTs = message?.thread_ts ?? message?.ts;
      if (!channel || !threadTs || !body.trigger_id) return;
      await this.mustClient().openView({
        trigger_id: body.trigger_id,
        view: secretsModal(encodeRef({ channel, threadTs })),
      });
    });

    app.view(SECRETS_CALLBACK_ID, async ({ ack, body, view }) => {
      await ack();
      const ref = decodeRefSafe(view.private_metadata);
      if (!ref) return;
      const conversationId = await this.binding.conversationFor(ref);
      if (!conversationId) return;
      for (const { name, value } of parseSecretsSubmission(view.state.values as ViewStateValues)) {
        await this.emitSafe({
          type: 'secret.submitted',
          conversationId,
          userId: body.user.id,
          name,
          value,
        });
      }
    });

    app.view(REPO_PICKER_CALLBACK_ID, async ({ ack, body, view }) => {
      await ack();
      const channel = view.private_metadata;
      if (!channel) return;
      await this.rootThreadConversation(
        channel,
        body.user.id,
        parseRepoChoice(parseRepoPickerSubmission(view.state.values as ViewStateValues)),
      );
    });

    app.event('app_home_opened', async ({ event }) => {
      if (event.tab !== undefined && event.tab !== 'home') return;
      const sessions = (await this.opts.listSessions?.(event.user)) ?? [];
      await this.mustClient().publishHome({ userId: event.user, view: homeView(sessions) });
    });

    await app.start();
  }

  async stop(): Promise<void> {
    await this.coalescer.endAll();
    await this.app?.stop();
  }

  /** Root a session thread with a message the bot owns, then bind it. */
  private async rootThreadConversation(
    channel: string,
    userId: string,
    repoChoice: RepoChoice,
  ): Promise<void> {
    const root = await this.mustClient().postMessage({
      channel,
      ...messageBlocks('Starting a devspace session in this thread…'),
    });
    await this.createConversation({ channel, threadTs: root.ts }, userId, repoChoice);
  }

  private async createConversation(
    ref: ThreadRef,
    userId: string,
    repoChoice: RepoChoice,
  ): Promise<void> {
    const result = await this.emitSafe({
      type: 'conversation.created',
      platform: 'slack',
      externalChannelId: encodeRef(ref),
      userId,
      repoChoice,
    });
    // Warm the cache for everything after this event. Renders emitted DURING
    // handleChatEvent (e.g. the PROVISIONING status) precede this bind — the
    // binding's DB-backed resolvers cover that window.
    if (result?.conversationId) this.binding.bind(result.conversationId, ref);
  }

  private async emitSafe(
    event: Parameters<EmitChatEvent>[0],
  ): Promise<Awaited<ReturnType<EmitChatEvent>>> {
    if (!this.emit) throw new Error('SlackAdapter not started');
    try {
      return await this.emit(event);
    } catch (err) {
      this.warn(`emit ${event.type} failed: ${String(err)}`);
      return undefined;
    }
  }

  private mustClient(): SlackWebClient {
    if (!this.client) throw new Error('SlackAdapter not started');
    return this.client;
  }

  /* ------------------------------------------------------------------ */
  /* Outbound: RenderCommand -> Slack                                    */
  /* ------------------------------------------------------------------ */

  async render(command: RenderCommand): Promise<MessageRef | void> {
    try {
      return await this.renderUnsafe(command);
    } catch (err) {
      // The render path never throws (m4-plan C): log and drop.
      this.warn(`render ${command.type} for ${command.conversationId} failed: ${String(err)}`);
    }
  }

  private async renderUnsafe(command: RenderCommand): Promise<MessageRef | void> {
    if (command.type === 'stream_append') {
      // Coalesced; the flush callback does the ref lookup + post/update.
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

    switch (command.type) {
      case 'post_message':
        return this.post(command.conversationId, ref, messageBlocks(command.text));
      case 'update_status': {
        const body = statusBlocks(command.state, command.text);
        const existing = this.status.get(command.conversationId);
        if (existing) {
          await this.mustClient().update({ channel: ref.channel, ts: existing, ...body });
          return { conversationId: command.conversationId, messageId: existing };
        }
        const posted = await this.post(command.conversationId, ref, body);
        this.status.set(command.conversationId, posted.messageId);
        return posted;
      }
      case 'post_actions':
        return this.post(command.conversationId, ref, actionsBlocks(command.text, command.actions));
    }
  }

  private async post(
    conversationId: string,
    ref: ThreadRef,
    body: SlackMessage,
  ): Promise<MessageRef> {
    const { ts } = await this.mustClient().postMessage({
      channel: ref.channel,
      thread_ts: ref.threadTs,
      ...body,
    });
    return { conversationId, messageId: ts };
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
    const body = streamBlocks(text);
    if (!stream.ts) {
      const { ts } = await this.mustClient().postMessage({
        channel: ref.channel,
        thread_ts: ref.threadTs,
        ...body,
      });
      stream.ts = ts;
      return;
    }
    await this.mustClient().update({ channel: ref.channel, ts: stream.ts, ...body });
  }
}
