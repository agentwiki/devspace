/**
 * Pure Block Kit builders (m4-plan workstream B): `RenderCommand → SlackMessage`.
 * No I/O — the adapter (workstream C) ships the payloads. Every builder is a
 * total function of its input; all outbound text was already redacted by the
 * orchestrator's render.ts, and nothing here may introduce text from any other
 * source.
 */
import type { ActionButton, RenderCommand } from '@devspace/contracts';

/* Slack hard limits the builders enforce. */
const SECTION_TEXT_MAX = 3000; // section/context mrkdwn text object
const BUTTON_LABEL_MAX = 75; // button plain_text label
const BLOCKS_MAX = 50; // blocks per message

/* Minimal local Block Kit types — just the shapes these builders emit. */
export interface MrkdwnText {
  type: 'mrkdwn';
  text: string;
}

export interface PlainText {
  type: 'plain_text';
  text: string;
  emoji?: boolean;
}

export interface SectionBlock {
  type: 'section';
  text: MrkdwnText;
}

export interface ContextBlock {
  type: 'context';
  elements: MrkdwnText[];
}

export interface ButtonElement {
  type: 'button';
  action_id: string;
  text: PlainText;
  style?: 'primary' | 'danger';
}

export interface ActionsBlock {
  type: 'actions';
  elements: ButtonElement[];
}

export type SlackBlock = SectionBlock | ContextBlock | ActionsBlock;

/** What the adapter passes to chat.postMessage / chat.update. */
export interface SlackMessage {
  /** Notification/accessibility fallback (Slack truncates it itself). */
  text: string;
  blocks: SlackBlock[];
}

/**
 * Split text to fit Slack's per-block limit, preferring newline boundaries so
 * code/log lines stay intact. Total, never drops content.
 */
export function chunkText(text: string, max = SECTION_TEXT_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const nl = window.lastIndexOf('\n');
    const cut = nl > 0 ? nl + 1 : max; // keep the newline with the left chunk
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function sections(text: string): SectionBlock[] {
  // Leave headroom under BLOCKS_MAX for sibling blocks (actions/context).
  return chunkText(text)
    .slice(0, BLOCKS_MAX - 2)
    .map((chunk) => ({ type: 'section', text: { type: 'mrkdwn', text: chunk } }));
}

function button(action: ActionButton): ButtonElement {
  const el: ButtonElement = {
    type: 'button',
    action_id: action.actionId,
    text: { type: 'plain_text', text: action.label.slice(0, BUTTON_LABEL_MAX), emoji: true },
  };
  // Slack's default (unstyled) IS "secondary" — only primary/danger are set.
  if (action.style === 'primary' || action.style === 'danger') el.style = action.style;
  return el;
}

/** `post_message` → one or more mrkdwn sections. */
export function messageBlocks(text: string): SlackMessage {
  return { text, blocks: sections(text) };
}

/** `update_status` → one compact context line, edited in place by the adapter. */
export function statusBlocks(state: string, text: string): SlackMessage {
  const line = `*${state}* · ${text}`.slice(0, SECTION_TEXT_MAX);
  return {
    text: `${state}: ${text}`,
    blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: line }] }],
  };
}

/** `post_actions` → section(s) + one actions block with stable action_ids. */
export function actionsBlocks(text: string, actions: ActionButton[]): SlackMessage {
  return {
    text,
    blocks: [...sections(text), { type: 'actions', elements: actions.map(button) }],
  };
}

/** The body of a streamed message — the coalescer's accumulated text. */
export function streamBlocks(text: string): SlackMessage {
  return messageBlocks(text);
}

/** Map any RenderCommand to its Slack message body (stream: full text so far). */
export function renderCommandBlocks(command: RenderCommand, streamText?: string): SlackMessage {
  switch (command.type) {
    case 'post_message':
      return messageBlocks(command.text);
    case 'update_status':
      return statusBlocks(command.state, command.text);
    case 'post_actions':
      return actionsBlocks(command.text, command.actions);
    case 'stream_append':
      return streamBlocks(streamText ?? command.chunk);
  }
}

/* -------------------------------------------------------------------------- */
/* App Home (views.publish) — the session-list "sidebar"                       */
/* -------------------------------------------------------------------------- */

export interface HomeSession {
  conversationId: string;
  state: string;
  repoUrl?: string;
  prUrl?: string;
}

export interface HomeView {
  type: 'home';
  blocks: SlackBlock[];
}

export function homeView(sessions: HomeSession[]): HomeView {
  if (sessions.length === 0) {
    return {
      type: 'home',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'No active sessions. Run `/devspace <repoUrl>` in a channel to start one.',
          },
        },
      ],
    };
  }
  const rows: SlackBlock[] = sessions.slice(0, BLOCKS_MAX - 1).map((s) => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*${s.state}*`,
        s.repoUrl ? `<${s.repoUrl}>` : '(no repository)',
        s.prUrl ? `<${s.prUrl}|PR>` : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
        .slice(0, SECTION_TEXT_MAX),
    },
  }));
  return {
    type: 'home',
    blocks: [
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*Sessions* (${sessions.length})` }] },
      ...rows,
    ],
  };
}
