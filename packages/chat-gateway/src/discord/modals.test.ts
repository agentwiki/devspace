/**
 * Discord modal builders + parsers (M7-B): pure functions, exhaustively
 * testable — the discord.js showModal call is the glue's job.
 */
import { describe, expect, it } from 'vitest';
import { SECRET_INPUTS } from '../slack/blocks.js';
import {
  CUSTOM_ID_MAX,
  MODAL_BUTTON_IDS,
  REPO_PICKER_MODAL_PREFIX,
  SECRETS_MODAL_PREFIX,
  decodeModalId,
  encodeModalId,
  parseRepoPickerSubmission,
  parseSecretsSubmission,
  repoPickerModal,
  secretsModal,
} from './modals.js';

describe('modal id codec', () => {
  it('round-trips prefix + context', () => {
    const id = encodeModalId(SECRETS_MODAL_PREFIX, 'C1:T1');
    expect(decodeModalId(id)).toEqual({ prefix: SECRETS_MODAL_PREFIX, context: 'C1:T1' });
  });

  it('decode returns null on malformed ids instead of throwing', () => {
    expect(decodeModalId('noseparator')).toBeNull();
    expect(decodeModalId(':leading')).toBeNull();
    expect(decodeModalId('trailing:')).toBeNull();
    expect(decodeModalId('')).toBeNull();
  });

  it('encode asserts the 100-char custom_id cap loudly', () => {
    expect(() => encodeModalId('p', 'x'.repeat(CUSTOM_ID_MAX))).toThrow(/custom_id/);
  });

  it('two max-length Discord snowflakes fit with comfortable headroom', () => {
    const snowflake = '9'.repeat(20);
    const id = encodeModalId(SECRETS_MODAL_PREFIX, `${snowflake}:${snowflake}`);
    expect(id.length).toBeLessThan(CUSTOM_ID_MAX - 20);
  });
});

describe('secretsModal', () => {
  it('mirrors the Slack modal: one optional text input per whitelisted secret', () => {
    const modal = secretsModal('C1:T1');
    expect(modal.custom_id).toBe(`${SECRETS_MODAL_PREFIX}:C1:T1`);
    expect(modal.components).toHaveLength(SECRET_INPUTS.length);
    for (const [i, row] of modal.components.entries()) {
      const input = row.components[0];
      expect(row.type).toBe(1);
      expect(input.type).toBe(4);
      expect(input.custom_id).toBe(SECRET_INPUTS[i]!.blockId);
      expect(input.required).toBe(false);
      expect(input.label.length).toBeLessThanOrEqual(45); // Discord label cap
    }
  });
});

describe('repoPickerModal', () => {
  it('requires the repo, keeps ref and network optional, and carries the channel', () => {
    const modal = repoPickerModal('C42');
    expect(modal.custom_id).toBe(`${REPO_PICKER_MODAL_PREFIX}:C42`);
    const [repo, ref, network] = modal.components.map((r) => r.components[0]);
    expect(repo).toMatchObject({ custom_id: 'repo', required: true });
    expect(ref).toMatchObject({ custom_id: 'ref', required: false });
    expect(network).toMatchObject({ custom_id: 'network', required: false });
  });
});

describe('submission parsers', () => {
  it('parseSecretsSubmission keeps only filled fields, trimmed, in whitelist order', () => {
    expect(
      parseSecretsSubmission({
        github_clone_token: ' ghp_ro ',
        llm_key: 'sk-1',
        github_token: '   ',
        unrelated: 'ignored',
      }),
    ).toEqual([
      { name: 'LLM_KEY', value: 'sk-1' },
      { name: 'GITHUB_CLONE_TOKEN', value: 'ghp_ro' },
    ]);
    expect(parseSecretsSubmission({})).toEqual([]);
  });

  it('parseRepoPickerSubmission joins "<repo> [ref]"', () => {
    expect(parseRepoPickerSubmission({ repo: ' acme/widgets ', ref: 'main' })).toBe(
      'acme/widgets main',
    );
    expect(parseRepoPickerSubmission({ repo: 'acme/widgets' })).toBe('acme/widgets');
    expect(parseRepoPickerSubmission({})).toBe('');
  });

  it('parseRepoPickerSubmission composes the network field as a net= token (M23)', () => {
    expect(parseRepoPickerSubmission({ repo: 'acme/widgets', network: 'none' })).toBe(
      'acme/widgets net=none',
    );
    // Shared normalization with Slack: whitespace stripped, `net=` forgiven.
    expect(
      parseRepoPickerSubmission({ repo: 'acme/widgets', ref: 'main', network: ' net=+mirror.corp.example ' }),
    ).toBe('acme/widgets main net=+mirror.corp.example');
    // A blank field is unused — default egress, never an empty net= token.
    expect(parseRepoPickerSubmission({ repo: 'acme/widgets', network: '  ' })).toBe('acme/widgets');
  });
});

describe('MODAL_BUTTON_IDS', () => {
  it('lists exactly the buttons whose ack IS a modal (the glue contract)', () => {
    expect([...MODAL_BUTTON_IDS]).toEqual(['set-secrets']);
  });
});
