import { describe, expect, it } from 'vitest';
import type { RenderCommand } from '@devspace/contracts';
import {
  REPO_PICKER_CALLBACK_ID,
  SECRETS_CALLBACK_ID,
  actionsBlocks,
  chunkText,
  homeView,
  messageBlocks,
  parseRepoPickerSubmission,
  parseSecretsSubmission,
  renderCommandBlocks,
  repoPickerModal,
  secretsModal,
  statusBlocks,
  streamBlocks,
} from './blocks.js';

describe('chunkText', () => {
  it('passes short text through as a single chunk', () => {
    expect(chunkText('hello')).toEqual(['hello']);
  });

  it('splits long text at newline boundaries and loses nothing', () => {
    const line = 'x'.repeat(100);
    const text = Array.from({ length: 50 }, () => line).join('\n'); // 5049 chars
    const chunks = chunkText(text, 3000);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3000);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]!.endsWith('\n')).toBe(true); // cut on a line boundary
  });

  it('hard-splits a single line longer than the limit', () => {
    const text = 'y'.repeat(7000);
    const chunks = chunkText(text, 3000);
    expect(chunks.map((c) => c.length)).toEqual([3000, 3000, 1000]);
    expect(chunks.join('')).toBe(text);
  });
});

describe('messageBlocks', () => {
  it('renders one mrkdwn section with the text as fallback', () => {
    expect(messageBlocks('hi *there*')).toEqual({
      text: 'hi *there*',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi *there*' } }],
    });
  });

  it('spreads long text over multiple sections, each under the block limit', () => {
    const { blocks } = messageBlocks('z'.repeat(7000));
    expect(blocks.length).toBe(3);
    for (const block of blocks) {
      expect(block.type).toBe('section');
      if (block.type === 'section') expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

describe('statusBlocks', () => {
  it('renders a single compact context line carrying state + text', () => {
    expect(statusBlocks('READY', 'Environment ready.')).toEqual({
      text: 'READY: Environment ready.',
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '*READY* · Environment ready.' }],
        },
      ],
    });
  });
});

describe('actionsBlocks', () => {
  it('keeps the stable action_ids and maps styles (secondary → Slack default)', () => {
    const msg = actionsBlocks('Approve shell command?', [
      { actionId: 'approve:req-1', label: 'Approve', style: 'primary' },
      { actionId: 'deny:req-1', label: 'Deny', style: 'danger' },
      { actionId: 'view-pr', label: 'View PR', style: 'secondary' },
    ]);
    const actions = msg.blocks.at(-1);
    expect(actions?.type).toBe('actions');
    if (actions?.type !== 'actions') throw new Error('expected actions block');
    expect(actions.elements).toEqual([
      {
        type: 'button',
        action_id: 'approve:req-1',
        text: { type: 'plain_text', text: 'Approve', emoji: true },
        style: 'primary',
      },
      {
        type: 'button',
        action_id: 'deny:req-1',
        text: { type: 'plain_text', text: 'Deny', emoji: true },
        style: 'danger',
      },
      {
        type: 'button',
        action_id: 'view-pr',
        text: { type: 'plain_text', text: 'View PR', emoji: true },
        // no style key: Slack's unstyled default IS secondary
      },
    ]);
  });

  it('truncates a button label to Slack limit but never the action_id', () => {
    const msg = actionsBlocks('t', [
      { actionId: 'approve:very-long-id', label: 'L'.repeat(100), style: 'secondary' },
    ]);
    const actions = msg.blocks.at(-1);
    if (actions?.type !== 'actions') throw new Error('expected actions block');
    expect(actions.elements[0]!.text.text.length).toBe(75);
    expect(actions.elements[0]!.action_id).toBe('approve:very-long-id');
  });
});

describe('renderCommandBlocks', () => {
  const conversationId = '018f6f2e-0000-7000-8000-000000000000';

  it('covers every RenderCommand variant', () => {
    const cases: RenderCommand[] = [
      { type: 'post_message', conversationId, text: 'm' },
      { type: 'update_status', conversationId, state: 'WORKING', text: 's' },
      {
        type: 'post_actions',
        conversationId,
        text: 'a',
        actions: [{ actionId: 'create-pr', label: 'Create PR', style: 'primary' }],
      },
      { type: 'stream_append', conversationId, streamId: 'st', chunk: 'c' },
    ];
    for (const command of cases) {
      const msg = renderCommandBlocks(command);
      expect(msg.text.length).toBeGreaterThan(0);
      expect(msg.blocks.length).toBeGreaterThan(0);
    }
  });

  it('stream_append renders the accumulated text when provided, else the chunk', () => {
    const cmd: RenderCommand = { type: 'stream_append', conversationId, streamId: 's', chunk: 'b' };
    expect(renderCommandBlocks(cmd, 'ab')).toEqual(streamBlocks('ab'));
    expect(renderCommandBlocks(cmd)).toEqual(streamBlocks('b'));
  });
});

describe('homeView', () => {
  it('renders an empty state with the /devspace hint', () => {
    const view = homeView([]);
    expect(view.type).toBe('home');
    expect(JSON.stringify(view.blocks)).toContain('/devspace');
  });

  it('renders one row per session with state, repo, and PR link', () => {
    const view = homeView([
      { conversationId: 'c1', state: 'WORKING', repoUrl: 'https://github.com/o/r' },
      { conversationId: 'c2', state: 'PR_OPEN', prUrl: 'https://github.com/o/r/pull/7' },
      { conversationId: 'c3', state: 'CREATED' },
    ]);
    expect(view.blocks.length).toBe(4); // header + 3 rows
    const rendered = JSON.stringify(view.blocks);
    expect(rendered).toContain('*WORKING*');
    expect(rendered).toContain('<https://github.com/o/r>');
    expect(rendered).toContain('<https://github.com/o/r/pull/7|PR>');
    expect(rendered).toContain('(no repository)');
  });
});

describe('modals (M6-D)', () => {
  it('secretsModal carries the thread ref and one optional input per storable name', () => {
    const view = secretsModal('C1:1712.0002');
    expect(view.callback_id).toBe(SECRETS_CALLBACK_ID);
    expect(view.private_metadata).toBe('C1:1712.0002');
    const inputs = view.blocks.filter((b) => b.type === 'input');
    expect(inputs.map((b) => (b as { block_id: string }).block_id)).toEqual([
      'llm_key',
      'github_token',
      'github_clone_token',
    ]);
    expect(inputs.every((b) => (b as { optional: boolean }).optional)).toBe(true);
  });

  it('repoPickerModal requires the repo and keeps ref and network optional', () => {
    const view = repoPickerModal('C1');
    expect(view.callback_id).toBe(REPO_PICKER_CALLBACK_ID);
    const byId = new Map(view.blocks.map((b) => [(b as { block_id?: string }).block_id, b]));
    expect((byId.get('repo') as { optional: boolean }).optional).toBe(false);
    expect((byId.get('ref') as { optional: boolean }).optional).toBe(true);
    expect((byId.get('network') as { optional: boolean }).optional).toBe(true);
  });

  it('parseSecretsSubmission keeps only filled fields, trimmed', () => {
    expect(
      parseSecretsSubmission({
        llm_key: { value: { value: '  sk-1  ' } },
        github_token: { value: { value: '' } },
        github_clone_token: { value: { value: null } },
      }),
    ).toEqual([{ name: 'LLM_KEY', value: 'sk-1' }]);
    expect(parseSecretsSubmission({})).toEqual([]);
  });

  it('parseRepoPickerSubmission joins repo and optional ref', () => {
    expect(
      parseRepoPickerSubmission({
        repo: { value: { value: 'acme/widgets' } },
        ref: { value: { value: 'main' } },
      }),
    ).toBe('acme/widgets main');
    expect(parseRepoPickerSubmission({ repo: { value: { value: 'acme/widgets' } } })).toBe(
      'acme/widgets',
    );
    expect(parseRepoPickerSubmission({})).toBe('');
  });

  it('parseRepoPickerSubmission composes the network field as a net= token (M23)', () => {
    expect(
      parseRepoPickerSubmission({
        repo: { value: { value: 'acme/widgets' } },
        ref: { value: { value: 'main' } },
        network: { value: { value: 'none' } },
      }),
    ).toBe('acme/widgets main net=none');
    // Whitespace inside the value is stripped; one leading `net=` forgiven.
    expect(
      parseRepoPickerSubmission({
        repo: { value: { value: 'acme/widgets' } },
        network: { value: { value: ' +mirror.corp.example, +cdn.corp.example ' } },
      }),
    ).toBe('acme/widgets net=+mirror.corp.example,+cdn.corp.example');
    expect(
      parseRepoPickerSubmission({
        repo: { value: { value: 'acme/widgets' } },
        network: { value: { value: 'net=none' } },
      }),
    ).toBe('acme/widgets net=none');
    // A blank field is UNUSED (default egress) — no empty net= token, which
    // would empty the whole choice.
    expect(
      parseRepoPickerSubmission({
        repo: { value: { value: 'acme/widgets' } },
        network: { value: { value: '   ' } },
      }),
    ).toBe('acme/widgets');
  });
});
