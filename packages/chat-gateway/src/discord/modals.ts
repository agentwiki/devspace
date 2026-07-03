/**
 * Pure Discord modal builders + submission parsers (m7-plan B) — the Discord
 * counterpart of the Slack modals in slack/blocks.ts. No I/O, total functions.
 *
 * Discord has no private_metadata: the modal's `custom_id` (100-char cap)
 * carries the context instead — `devspace-secrets:<channel>:<thread>` for the
 * secret modal (the binding's own ref codec) and
 * `devspace-repo-picker:<channel>` for the bare-command repo picker
 * (m7-plan Decision 5). Malformed ids decode to null, never throw.
 *
 * Discord modals support text inputs only (type 4) — which is all either
 * modal needs; the semantics mirror the Slack modals field for field
 * (Decision 6): every secret field optional, one `secret.submitted` per
 * filled field, repo required + ref optional.
 */
import { SECRET_INPUTS, type SecretName } from '../slack/blocks.js';

/** Discord's hard cap on custom_id (components and modals alike). */
export const CUSTOM_ID_MAX = 100;

/** discord.js TextInputStyle values — inlined so the builders stay dependency-free. */
const TEXT_INPUT_STYLE = { short: 1, paragraph: 2 } as const;

export interface DiscordTextInput {
  type: 4; // ComponentType.TextInput
  custom_id: string;
  style: (typeof TEXT_INPUT_STYLE)[keyof typeof TEXT_INPUT_STYLE];
  label: string;
  required: boolean;
  placeholder?: string;
}

export interface DiscordModalRow {
  type: 1; // ComponentType.ActionRow
  components: [DiscordTextInput];
}

/** What the transport passes to interaction.showModal. */
export interface DiscordModal {
  custom_id: string;
  title: string;
  components: DiscordModalRow[];
}

export const SECRETS_MODAL_PREFIX = 'devspace-secrets';
export const REPO_PICKER_MODAL_PREFIX = 'devspace-repo-picker';

/** Buttons whose interaction response IS the modal — the glue must not
 * deferUpdate these (m7-plan Decision 4). */
export const MODAL_BUTTON_IDS: ReadonlySet<string> = new Set(['set-secrets']);

const row = (input: Omit<DiscordTextInput, 'type'>): DiscordModalRow => ({
  type: 1,
  components: [{ type: 4, ...input }],
});

/** Compose `<prefix>:<context>` asserting Discord's custom_id bound — an id
 * shape that outgrows the cap must fail loudly in tests, not in production. */
export function encodeModalId(prefix: string, context: string): string {
  const id = `${prefix}:${context}`;
  if (id.length > CUSTOM_ID_MAX) {
    throw new Error(`modal custom_id exceeds ${CUSTOM_ID_MAX} chars: ${id.length}`);
  }
  return id;
}

/** Split a modal custom_id back into prefix + context; null when malformed. */
export function decodeModalId(customId: string): { prefix: string; context: string } | null {
  const sep = customId.indexOf(':');
  if (sep <= 0 || sep === customId.length - 1) return null;
  return { prefix: customId.slice(0, sep), context: customId.slice(sep + 1) };
}

/** The `set-secrets` modal — same three optional fields as Slack's
 * (`SECRET_INPUTS` is the shared whitelist mirror). `ref` is the encoded
 * thread ref the submission routes back through. */
export function secretsModal(ref: string): DiscordModal {
  return {
    custom_id: encodeModalId(SECRETS_MODAL_PREFIX, ref),
    title: 'devspace secrets',
    components: SECRET_INPUTS.map((s) =>
      row({
        custom_id: s.blockId,
        style: TEXT_INPUT_STYLE.short,
        label: s.label.slice(0, 45), // Discord caps text-input labels at 45
        required: false,
        placeholder: 'Leave empty to keep the current value',
      }),
    ),
  };
}

/** The bare-`/devspace` repo picker (m6-plan Decision 9, Discord edition). */
export function repoPickerModal(channelId: string): DiscordModal {
  return {
    custom_id: encodeModalId(REPO_PICKER_MODAL_PREFIX, channelId),
    title: 'New devspace session',
    components: [
      row({
        custom_id: 'repo',
        style: TEXT_INPUT_STYLE.short,
        label: 'Repository',
        required: true,
        placeholder: 'https://github.com/owner/repo or owner/repo',
      }),
      row({
        custom_id: 'ref',
        style: TEXT_INPUT_STYLE.short,
        label: 'Branch or ref (optional)',
        required: false,
        placeholder: 'main',
      }),
    ],
  };
}

/** The flat field map the transport lifts off a ModalSubmit interaction. */
export type ModalFields = Record<string, string | undefined>;

/** Extract the filled secret fields from a secrets-modal submission. */
export function parseSecretsSubmission(
  fields: ModalFields,
): Array<{ name: SecretName; value: string }> {
  const out: Array<{ name: SecretName; value: string }> = [];
  for (const s of SECRET_INPUTS) {
    const value = fields[s.blockId]?.trim();
    if (value) out.push({ name: s.name, value });
  }
  return out;
}

/** Extract the "<repo> [ref]" text from a repo-picker submission. */
export function parseRepoPickerSubmission(fields: ModalFields): string {
  const repo = fields.repo?.trim() ?? '';
  const ref = fields.ref?.trim() ?? '';
  return [repo, ref].filter(Boolean).join(' ');
}
