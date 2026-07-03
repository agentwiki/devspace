/**
 * The discord.js glue behind the `DiscordTransport` seam (m6-plan Decision 7).
 *
 * This is the documented-untested boundary — the same line M4 drew around
 * Bolt's WebSocket internals: everything above it (the whole DiscordAdapter)
 * is tested over a fake transport; this file only maps discord.js's gateway
 * events and REST calls onto the seam, as thinly as possible.
 *
 * Slash command: `/devspace [repo] [ref]` is (re)registered globally at start
 * — registration is idempotent (a full PUT of the application's commands).
 */
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalComponentData,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type { DiscordMessageBody } from './messages.js';
import { MODAL_BUTTON_IDS, type DiscordModal } from './modals.js';
import type { DiscordInboundHandlers, DiscordTransport } from '../adapters/discord.js';

export interface DiscordConfig {
  /** Bot token. */
  token: string;
  /** Application (client) id — needed to register the slash command. */
  applicationId: string;
}

const DEVSPACE_COMMAND = {
  name: 'devspace',
  description: 'Start a devspace session in a thread',
  options: [
    {
      type: 3, // STRING
      name: 'repo',
      description: 'Repository URL or owner/repo',
      required: false,
    },
    { type: 3, name: 'ref', description: 'Branch or ref', required: false },
  ],
};

/** A channel we can post/edit in (guild text or thread). */
type Postable = TextChannel | ThreadChannel;

export function discordJsTransport(config: DiscordConfig): DiscordTransport {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // Interactions kept addressable for `openModal` (Discord's trigger_id
  // equivalent, m7-plan Decision 3). Entries die with the interaction token.
  type ModalCapable = ChatInputCommandInteraction | ButtonInteraction;
  const pending = new Map<string, ModalCapable>();
  const track = (interaction: ModalCapable): void => {
    pending.set(interaction.id, interaction);
    setTimeout(() => pending.delete(interaction.id), 3 * 60_000).unref();
  };

  async function postable(channelId: string): Promise<Postable> {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`channel ${channelId} is not a text channel`);
    }
    return channel as Postable;
  }

  const toOptions = (body: DiscordMessageBody): { content: string; components: unknown[] } => ({
    content: body.content,
    components: body.components ?? [],
  });

  return {
    async start(handlers: DiscordInboundHandlers): Promise<void> {
      client.on(Events.InteractionCreate, (interaction: Interaction) => {
        void (async () => {
          if (interaction.isChatInputCommand() && interaction.commandName === 'devspace') {
            const repo = interaction.options.getString('repo') ?? '';
            const ref = interaction.options.getString('ref') ?? '';
            const bare = !repo && !ref;
            // Acknowledge fast (3s budget); the session root is its own
            // message. Bare command: the adapter's repo-picker modal IS the
            // response, so nothing may ack first (m7-plan Decision 4).
            if (bare) track(interaction);
            else {
              await interaction.reply({
                content: 'Starting a devspace session…',
                flags: MessageFlags.Ephemeral,
              });
            }
            if (!interaction.channelId) return;
            await handlers.slashCommand({
              channelId: interaction.channelId,
              userId: interaction.user.id,
              text: [repo, ref].filter(Boolean).join(' '),
              interactionId: interaction.id,
            });
            return;
          }
          if (interaction.isButton()) {
            // Modal openers must stay un-acked — showModal IS the ack; every
            // other button defers immediately (create-pr can exceed 3s).
            if (MODAL_BUTTON_IDS.has(interaction.customId)) track(interaction);
            else await interaction.deferUpdate();
            const channel = interaction.channel;
            const parentChannelId =
              channel && channel.isThread() ? (channel.parentId ?? undefined) : undefined;
            await handlers.button({
              channelId: interaction.channelId,
              parentChannelId,
              userId: interaction.user.id,
              customId: interaction.customId,
              interactionId: interaction.id,
            });
            return;
          }
          if (interaction.isModalSubmit()) {
            // Modal submissions need their own ack within the same 3s budget.
            await interaction.reply({ content: 'Received.', flags: MessageFlags.Ephemeral });
            const fields: Record<string, string> = {};
            for (const [id, component] of interaction.fields.fields) {
              if ('value' in component && typeof component.value === 'string') {
                fields[id] = component.value;
              }
            }
            await handlers.modalSubmit({
              customId: interaction.customId,
              userId: interaction.user.id,
              fields,
            });
          }
        })().catch((err) => console.warn(`[discord] interaction failed: ${String(err)}`));
      });

      client.on(Events.MessageCreate, (message: Message) => {
        void (async () => {
          const channel = message.channel;
          const parentChannelId = channel.isThread() ? (channel.parentId ?? undefined) : undefined;
          await handlers.message({
            channelId: message.channelId,
            parentChannelId,
            userId: message.author.id,
            content: message.content,
            mentionsBot: client.user ? message.mentions.has(client.user) : false,
            fromBot: message.author.bot,
          });
        })().catch((err) => console.warn(`[discord] message handling failed: ${String(err)}`));
      });

      // Register /devspace (idempotent full PUT), then connect the gateway.
      const rest = new REST().setToken(config.token);
      await rest.put(Routes.applicationCommands(config.applicationId), {
        body: [DEVSPACE_COMMAND],
      });
      await client.login(config.token);
    },

    async stop(): Promise<void> {
      await client.destroy();
    },

    async postMessage(channelId, body) {
      const channel = await postable(channelId);
      const message = await channel.send(toOptions(body) as MessageCreateOptions);
      return { messageId: message.id };
    },

    async createThread(channelId, rootMessageId, name) {
      const channel = await postable(channelId);
      if (channel.type !== ChannelType.GuildText) {
        throw new Error(`cannot thread from channel type ${channel.type}`);
      }
      const root = await channel.messages.fetch(rootMessageId);
      const thread = await root.startThread({ name });
      return { threadId: thread.id };
    },

    async editMessage(channelId, messageId, body) {
      const channel = await postable(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit(toOptions(body) as MessageEditOptions);
    },

    async openModal(interactionId, modal: DiscordModal) {
      const interaction = pending.get(interactionId);
      if (!interaction) throw new Error(`interaction ${interactionId} expired or unknown`);
      pending.delete(interactionId);
      // The builders emit the raw API (snake_case) modal shape directly.
      await interaction.showModal(modal as unknown as ModalComponentData);
    },
  };
}
