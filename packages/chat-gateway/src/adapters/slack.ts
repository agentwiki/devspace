/**
 * Slack adapter (primary target). M0 skeleton: implements the ChatAdapter /
 * ChatRenderer surface with typed no-ops. The M4 implementation will use
 * Slack Bolt (@slack/bolt, Socket Mode) + Block Kit and translate:
 *   - slash command / new thread     -> conversation.created
 *   - message in thread              -> message.posted
 *   - Block Kit button / App Home     -> action.invoked
 * and render post_message / update_status (chat.update) / post_actions
 * (actions block) / stream_append (coalesced chat.update).
 *
 * The session list is rendered in the App Home tab (views.publish), which is
 * Slack's native equivalent of a sidebar. See
 * docs/analysis/chat-platform-ui-parity.md.
 */
import type { ChatEvent, ChatPlatform, RenderCommand } from '@devspace/contracts';
import type { ChatAdapter, ChatRenderer, MessageRef, StreamHandle } from '../index.js';

export interface SlackConfig {
  /** Bot User OAuth token (xoxb-…). */
  botToken: string;
  /** App-level token (xapp-…) for Socket Mode. */
  appToken: string;
  /** Signing secret; used when running over HTTP events instead of Socket Mode. */
  signingSecret?: string;
}

export class SlackAdapter implements ChatAdapter, ChatRenderer {
  readonly platform: ChatPlatform = 'slack';

  constructor(private readonly config: SlackConfig) {}

  async start(_emit: (event: ChatEvent) => Promise<void>): Promise<void> {
    void this.config;
    // M4: new App({token: botToken, appToken, socketMode: true}); wire
    // app.command / app.message / app.action / app.event('app_home_opened').
    throw new Error('SlackAdapter.start not implemented yet (lands in M4)');
  }

  async stop(): Promise<void> {
    // M4: app.stop()
  }

  async render(_command: RenderCommand): Promise<MessageRef | void> {
    throw new Error('SlackAdapter.render not implemented yet (lands in M4)');
  }

  async openStream(_conversationId: string): Promise<StreamHandle> {
    throw new Error('SlackAdapter.openStream not implemented yet (lands in M4)');
  }
}
