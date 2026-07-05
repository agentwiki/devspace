import { describe, expect, it } from 'vitest';
import {
  buildHistoryPreamble,
  buildHistoryReplay,
  HISTORY_MAX_CHARS,
  REPLAY_MAX_CHARS,
} from './transcript.js';

const entry = (role: 'user' | 'agent', text: string) => ({ role, text });

describe('buildHistoryPreamble (M20)', () => {
  it('returns empty for an empty transcript — indistinguishable from a blind resume', () => {
    expect(buildHistoryPreamble([])).toBe('');
  });

  it('renders role-labelled lines in order, framed as history', () => {
    const out = buildHistoryPreamble([
      entry('user', 'add a retry to the fetcher'),
      entry('agent', 'done — three attempts with backoff'),
      entry('user', 'make it five'),
    ]);
    expect(out).toContain('this session was resumed');
    expect(out).toContain(
      '[user] add a retry to the fetcher\n' +
        '[agent] done — three attempts with backoff\n' +
        '[user] make it five',
    );
    expect(out.endsWith('--- end of restored history; the current message follows ---')).toBe(true);
    expect(out).not.toContain('omitted');
  });

  it('drops oldest whole entries past the budget and marks the cut', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry('user', `msg-${i} ${'x'.repeat(40)}`),
    );
    const out = buildHistoryPreamble(entries, 120);
    expect(out).toContain('[… earlier history omitted …]');
    expect(out).toContain('msg-9'); // newest survives
    expect(out).not.toContain('msg-0'); // oldest dropped
    // Whole entries only: whatever made it in is intact.
    expect(out).toContain(`msg-9 ${'x'.repeat(40)}`);
  });

  it('hard-truncates head-first when the newest single entry busts the budget alone', () => {
    const huge = `START ${'y'.repeat(500)} END`;
    const out = buildHistoryPreamble([entry('user', 'earlier'), entry('agent', huge)], 100);
    expect(out).toContain('[agent] …');
    expect(out).toContain('END'); // the tail (most recent words) survives
    expect(out).not.toContain('START');
    expect(out).not.toContain('[user] earlier');
    expect(out).toContain('[… earlier history omitted …]');
  });

  it('default budget bounds the rendered lines', () => {
    const entries = Array.from({ length: 200 }, (_, i) => entry('agent', `${i} ${'z'.repeat(99)}`));
    const out = buildHistoryPreamble(entries);
    // Framing text is small; the whole preamble stays within budget + framing.
    expect(out.length).toBeLessThan(HISTORY_MAX_CHARS + 500);
  });
});

describe('buildHistoryReplay (M21)', () => {
  it('returns empty for an empty transcript — the caller answers "nothing recorded"', () => {
    expect(buildHistoryReplay([], false)).toBe('');
  });

  it('renders role-labelled lines in order under a chat-shaped header', () => {
    const out = buildHistoryReplay(
      [entry('user', 'add a retry'), entry('agent', 'done — three attempts')],
      false,
    );
    expect(out).toContain('Conversation history');
    expect(out).toContain('[user] add a retry\n[agent] done — three attempts');
    expect(out).not.toContain('omitted');
    expect(out).not.toContain('resumed'); // never the preamble framing
  });

  it('marks the cut when the caller probed more entries above the window', () => {
    const out = buildHistoryReplay([entry('user', 'latest')], true);
    expect(out).toContain('[… earlier history omitted …]');
    expect(out).toContain('[user] latest');
  });

  it('drops oldest whole entries past the char budget and marks the cut', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry('agent', `msg-${i} ${'x'.repeat(40)}`),
    );
    const out = buildHistoryReplay(entries, false, 120);
    expect(out).toContain('[… earlier history omitted …]');
    expect(out).toContain('msg-9');
    expect(out).not.toContain('msg-0');
  });

  it('default budget keeps the replay inside both platforms’ chunked paths', () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry('user', `${i} ${'z'.repeat(99)}`));
    const out = buildHistoryReplay(entries, false);
    expect(out.length).toBeLessThan(REPLAY_MAX_CHARS + 200);
  });
});
