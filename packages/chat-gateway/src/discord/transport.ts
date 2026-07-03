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
  REST,
  Routes,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type { DiscordMessageBody } from './messages.js';
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
            // Acknowledge fast (3s budget); the session root is its own message.
            await interaction.reply({ content: 'Starting a devspace session…', ephemeral: true });
            if (!interaction.channelId) return;
            await handlers.slashCommand({
              channelId: interaction.channelId,
              userId: interaction.user.id,
              text: [repo, ref].filter(Boolean).join(' '),
            });
            return;
          }
          if (interaction.isButton()) {
            await interaction.deferUpdate();
            const channel = interaction.channel;
            const parentChannelId =
              channel && channel.isThread() ? (channel.parentId ?? undefined) : undefined;
            await handlers.button({
              channelId: interaction.channelId,
              parentChannelId,
              userId: interaction.user.id,
              customId: interaction.customId,
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
  };
}
