/**
 * @devspace/chat-gateway
 *
 * Adapter layer between chat platforms and the orchestrator. The platform-
 * agnostic core is just two interfaces; each platform implements them. The
 * gateway NEVER calls agent-runner or sandbox-core — it emits normalized
 * ChatEvents up to the orchestrator and renders RenderCommands coming down.
 */
import type { ChatEvent, ChatPlatform, RenderCommand } from '@devspace/contracts';

export interface MessageRef {
  conversationId: string;
  messageId: string;
}

export interface StreamHandle {
  streamId: string;
  append(chunk: string): Promise<void>;
  end(): Promise<void>;
}

/** `conversation.created` returns the created id so the adapter can bind its
 * platform thread to it (M4 Decision 1); other events resolve to void. */
export interface ChatEventResult {
  conversationId?: string;
}

export type EmitChatEvent = (event: ChatEvent) => Promise<ChatEventResult | void>;

/** Inbound: platform -> normalized events. */
export interface ChatAdapter {
  readonly platform: ChatPlatform;
  start(emit: EmitChatEvent): Promise<void>;
  stop(): Promise<void>;
}

/** Outbound: normalized render commands -> platform. */
export interface ChatRenderer {
  readonly platform: ChatPlatform;
  render(command: RenderCommand): Promise<MessageRef | void>;
  openStream(conversationId: string): Promise<StreamHandle>;
}

export * from './binding.js';
export * from './status.js';
export * from './slack/blocks.js';
export * from './adapters/slack.js';
export * from './adapters/discord.js';
