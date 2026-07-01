/**
 * Discord adapter (first target). M0 skeleton: implements the ChatAdapter /
 * ChatRenderer surface with typed no-ops. The M4 implementation will use
 * discord.js (gateway client + interaction/button handlers) and translate:
 *   - slash command / new thread     -> conversation.created
 *   - message in thread              -> message.posted
 *   - button click                   -> action.invoked
 * and render post_message / update_status / post_actions / stream_append.
 */
import type { ChatEvent, ChatPlatform, RenderCommand } from '@devspace/contracts';
import type { ChatAdapter, ChatRenderer, MessageRef, StreamHandle } from '../index.js';

export interface DiscordConfig {
  token: string;
  applicationId: string;
}

export class DiscordAdapter implements ChatAdapter, ChatRenderer {
  readonly platform: ChatPlatform = 'discord';

  constructor(private readonly config: DiscordConfig) {}

  async start(_emit: (event: ChatEvent) => Promise<void>): Promise<void> {
    void this.config;
    // M4: new Client({intents}).login(this.config.token); wire event handlers.
    throw new Error('DiscordAdapter.start not implemented yet (lands in M4)');
  }

  async stop(): Promise<void> {
    // M4: client.destroy()
  }

  async render(_command: RenderCommand): Promise<MessageRef | void> {
    throw new Error('DiscordAdapter.render not implemented yet (lands in M4)');
  }

  async openStream(_conversationId: string): Promise<StreamHandle> {
    throw new Error('DiscordAdapter.openStream not implemented yet (lands in M4)');
  }
}
