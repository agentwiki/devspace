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

/* -------------------------------------------------------------------------- */
/* Modals (M6-D): in-chat secret entry + the bare-command repo picker          */
/* -------------------------------------------------------------------------- */

export const SECRETS_CALLBACK_ID = 'devspace-secrets';
export const REPO_PICKER_CALLBACK_ID = 'devspace-repo-picker';

/** The storable names — mirrors the `secret.submitted` contract whitelist. */
export const SECRET_INPUTS = [
  { blockId: 'llm_key', name: 'LLM_KEY', label: 'LLM API key' },
  { blockId: 'github_token', name: 'GITHUB_TOKEN', label: 'GitHub token (push + PR)' },
  {
    blockId: 'github_clone_token',
    name: 'GITHUB_CLONE_TOKEN',
    label: 'GitHub clone token (read-only, in-container)',
  },
] as const;

export type SecretName = (typeof SECRET_INPUTS)[number]['name'];

interface InputBlock {
  type: 'input';
  block_id: string;
  optional: boolean;
  label: PlainText;
  element: {
    type: 'plain_text_input';
    action_id: 'value';
    placeholder?: PlainText;
    multiline?: boolean;
  };
}

export interface SlackModalView {
  type: 'modal';
  callback_id: string;
  /** Carries the thread/channel context through the modal round trip. */
  private_metadata: string;
  title: PlainText;
  submit: PlainText;
  close: PlainText;
  blocks: (InputBlock | SectionBlock)[];
}

const plain = (text: string): PlainText => ({ type: 'plain_text', text });

const input = (
  blockId: string,
  label: string,
  optional: boolean,
  placeholder?: string,
  multiline?: boolean,
): InputBlock => ({
  type: 'input',
  block_id: blockId,
  optional,
  label: plain(label),
  element: {
    type: 'plain_text_input',
    action_id: 'value',
    ...(placeholder ? { placeholder: plain(placeholder) } : {}),
    ...(multiline ? { multiline: true } : {}),
  },
});

/** The `set-secrets` modal: every field optional; values go straight to the
 * envelope store as `secret.submitted` events and are never echoed. */
export function secretsModal(privateMetadata: string): SlackModalView {
  return {
    type: 'modal',
    callback_id: SECRETS_CALLBACK_ID,
    private_metadata: privateMetadata,
    title: plain('devspace secrets'),
    submit: plain('Save'),
    close: plain('Cancel'),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Values are envelope-encrypted at rest and redacted from all output. Leave a field empty to keep its current value.',
        },
      },
      ...SECRET_INPUTS.map((s) => input(s.blockId, s.label, true)),
    ],
  };
}

/** The bare-`/devspace` repo picker (m6-plan Decision 9). */
export function repoPickerModal(privateMetadata: string): SlackModalView {
  return {
    type: 'modal',
    callback_id: REPO_PICKER_CALLBACK_ID,
    private_metadata: privateMetadata,
    title: plain('New devspace session'),
    submit: plain('Start'),
    close: plain('Cancel'),
    blocks: [
      input('repo', 'Repository', false, 'https://github.com/owner/repo or owner/repo'),
      input('ref', 'Branch or ref (optional)', true, 'main'),
      input('network', 'Network (optional)', true, 'none | host1,host2 | +extra.example.com'),
      input('env_vars', 'Env vars (optional, non-secret)', true, 'KEY=value; OTHER=value'),
      input('setup', 'Setup script (optional)', true, 'corepack enable && pnpm install', true),
    ],
  };
}

/** Bolt's view_submission state shape: values[blockId][actionId].value. */
export type ViewStateValues = Record<string, Record<string, { value?: string | null }>>;

/** Extract the filled secret fields from a secrets-modal submission. */
export function parseSecretsSubmission(
  values: ViewStateValues,
): Array<{ name: SecretName; value: string }> {
  const out: Array<{ name: SecretName; value: string }> = [];
  for (const s of SECRET_INPUTS) {
    const value = values[s.blockId]?.value?.value?.trim();
    if (value) out.push({ name: s.name, value });
  }
  return out;
}

/**
 * Normalize the modal's free-text network field into a `net=` VALUE (M23):
 * whitespace stripped (a spaced comma list is unambiguous), one leading
 * `net=` forgiven (users who know the command form will type it). Empty →
 * '' (field unused — default egress). The value is composed as `net=<value>`
 * onto the picker text so `parseRepoChoice` stays the single interpreter of
 * `net` syntax — a malformed value can only ever yield an EMPTY choice,
 * never a differently-shaped env (m23-plan Decision 6).
 */
export function normalizeNetworkField(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, '').replace(/^net=/i, '');
}

/**
 * Parse env-var assignments (M24): `K=V` pairs separated by `;` (the `env=`
 * command token) or newlines (the modal field), whitespace around pairs,
 * names, and values forgiven. Values may be empty and may contain `=`; names
 * must be POSIX. Returns null when the input is blank or ANY pair is
 * malformed — the
 * caller empties the WHOLE choice (the M22 Decision-8 posture: a typo costs
 * a retype, never a differently-shaped env). One shared interpreter for the
 * command token and both modal fields (m24-plan Decision 7).
 */
export function parseEnvAssignments(raw: string): Record<string, string> | null {
  const pairs = raw
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (pairs.length === 0) return null;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    const name = pair.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    out[name] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** A parsed repo-picker submission (M24): the composed text for
 * `parseRepoChoice` plus the fields that cannot ride a space-tokenized
 * command — env assignments (null = filled but malformed) and the verbatim
 * multi-line setup script. */
export interface RepoPickerSubmission {
  text: string;
  env?: Record<string, string> | null;
  setupScript?: string;
}

/** Extract the "<repo> [ref] [net=…]" text + env/setup fields from a
 * repo-picker submission. */
export function parseRepoPickerSubmission(values: ViewStateValues): RepoPickerSubmission {
  const repo = values.repo?.value?.value?.trim() ?? '';
  const ref = values.ref?.value?.value?.trim() ?? '';
  const net = normalizeNetworkField(values.network?.value?.value);
  const envRaw = values.env_vars?.value?.value?.trim() ?? '';
  const setup = values.setup?.value?.value ?? '';
  return {
    text: [repo, ref, net ? `net=${net}` : ''].filter(Boolean).join(' '),
    ...(envRaw ? { env: parseEnvAssignments(envRaw) } : {}),
    ...(setup.trim() ? { setupScript: setup } : {}),
  };
}
