/**
 * Pure Discord message builders (m6-plan C): `RenderCommand → DiscordMessageBody[]`.
 * The Discord counterpart of slack/blocks.ts — no I/O, total functions, and
 * nothing here may introduce text from any source but the (already-redacted)
 * command. Discord messages are plain markdown `content` (2000-char hard cap)
 * plus button components; there is no Block Kit equivalent.
 */
import type { ActionButton } from '@devspace/contracts';
import { chunkText } from '../slack/blocks.js';

/** Discord hard limits the builders enforce. */
export const CONTENT_MAX = 2000;
const BUTTON_LABEL_MAX = 80;
const BUTTONS_PER_ROW = 5;
const ROWS_PER_MESSAGE = 5;

/** discord.js ButtonStyle values — inlined so the builders stay dependency-free. */
const BUTTON_STYLE = { primary: 1, secondary: 2, danger: 4 } as const;

export interface DiscordButton {
  type: 2; // MessageComponentType.Button
  style: (typeof BUTTON_STYLE)[keyof typeof BUTTON_STYLE];
  label: string;
  custom_id: string;
}

export interface DiscordActionRow {
  type: 1; // MessageComponentType.ActionRow
  components: DiscordButton[];
}

/** What the transport passes to channel.send / message.edit. */
export interface DiscordMessageBody {
  content: string;
  components?: DiscordActionRow[];
}

/** `post_message` → one body per 2000-char chunk (newline-preferring split). */
export function messageBodies(text: string): DiscordMessageBody[] {
  return chunkText(text, CONTENT_MAX).map((content) => ({ content }));
}

/** `update_status` → one compact line, edited in place by the adapter. */
export function statusBody(state: string, text: string): DiscordMessageBody {
  return { content: `**${state}** · ${text}`.slice(0, CONTENT_MAX) };
}

/** `post_actions` → chunked text; the LAST body carries the button rows. */
export function actionsBodies(text: string, actions: ActionButton[]): DiscordMessageBody[] {
  const bodies = messageBodies(text);
  const rows: DiscordActionRow[] = [];
  for (let i = 0; i < actions.length && rows.length < ROWS_PER_MESSAGE; i += BUTTONS_PER_ROW) {
    rows.push({
      type: 1,
      components: actions.slice(i, i + BUTTONS_PER_ROW).map((action) => ({
        type: 2,
        style: BUTTON_STYLE[action.style],
        label: action.label.slice(0, BUTTON_LABEL_MAX),
        custom_id: action.actionId,
      })),
    });
  }
  const last = bodies.at(-1)!;
  bodies[bodies.length - 1] = rows.length ? { ...last, components: rows } : last;
  return bodies;
}

/**
 * The body of a streamed message. A coalesced stream EDITS one message with
 * the full accumulated text, and Discord caps content at 2000 chars — so a
 * long stream shows its TAIL (the live end), marked with a leading ellipsis.
 * Slack gets the full text in chunked blocks; parity is tracked in
 * docs/analysis/chat-platform-ui-parity.md.
 */
export function streamBody(text: string): DiscordMessageBody {
  if (text.length <= CONTENT_MAX) return { content: text };
  return { content: `…${text.slice(-(CONTENT_MAX - 1))}` };
}
