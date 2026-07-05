/**
 * History restore (M20): render a transcript tail into the prompt preamble a
 * fresh agent session on a RESUMED unit receives ahead of its first message.
 *
 * Pure — no I/O, no clock. The caller (the message handler's M19 resume
 * self-loop) reads the tail and prefixes the result onto the prompt; the
 * preamble itself is NEVER persisted, so repeated suspend/resume cycles
 * cannot compound it into the transcript (m20-plan Decision 5).
 *
 * Bounded, oldest-dropped (m20-plan Decision 6): entries are kept newest-
 * first until the char budget is spent, dropped-anything is marked, and a
 * single oversized entry is hard-truncated head-first. The bounds are
 * constants, not knobs — a wrong bound costs prompt quality, never
 * correctness.
 */
import type { TranscriptRecord } from '@devspace/db';

/** How many transcript entries the restore read pulls (`listTail` limit). */
export const HISTORY_MAX_ENTRIES = 120;
/** Char budget for the rendered entry lines (framing text not counted). */
export const HISTORY_MAX_CHARS = 6_000;

const HEADER =
  'Context: this session was resumed while its pull request is under review. ' +
  'The conversation below happened earlier in this session; the workspace has ' +
  'since been re-cloned from the PR branch, so treat the files as the source ' +
  'of truth and this transcript as background.';

const OMITTED_MARK = '[… earlier history omitted …]';
const FOOTER = '--- end of restored history; the current message follows ---';

/** One rendered transcript line, role-labelled. */
function line(entry: Pick<TranscriptRecord, 'role' | 'text'>): string {
  return `[${entry.role}] ${entry.text}`;
}

/**
 * Build the preamble, or '' when there is nothing to restore (the caller
 * then sends the prompt untouched — indistinguishable from a blind resume).
 */
export function buildHistoryPreamble(
  entries: ReadonlyArray<Pick<TranscriptRecord, 'role' | 'text'>>,
  maxChars: number = HISTORY_MAX_CHARS,
): string {
  if (entries.length === 0) return '';

  // Keep whole entries newest-first until the budget is spent.
  const kept: string[] = [];
  let used = 0;
  let dropped = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const rendered = line(entries[i]!);
    if (used + rendered.length > maxChars) {
      // The newest entry must survive even when it alone busts the budget:
      // an empty restore because one reply was huge helps nobody.
      if (kept.length === 0) {
        kept.push(`[${entries[i]!.role}] …${rendered.slice(rendered.length - maxChars)}`);
        used = maxChars;
      }
      dropped = true;
      break;
    }
    kept.push(rendered);
    used += rendered.length;
  }
  kept.reverse();
  if (dropped) kept.unshift(OMITTED_MARK);

  return `${HEADER}\n\n${kept.join('\n')}\n\n${FOOTER}`;
}
