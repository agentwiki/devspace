/**
 * Work-unit lifecycle reclamation policy (M17, m17-plan workstream B).
 *
 * The reaper itself is `Orchestrator.reapExpired` — one sweep that gives the
 * long-dead-code `teardown()` its production caller. This module owns the
 * policy surface: which states each knob covers, and the parse-or-refuse env
 * reading both service entrypoints share. Off by default: with neither TTL
 * configured there is no reaper and behavior is byte-for-byte pre-M17.
 */
import type { WorkState } from '@devspace/contracts';

/**
 * States the idle TTL covers: everything whose env and secrets are the whole
 * point of keeping the unit around (rank below PR_OPEN — a wedged
 * PROVISIONING included; teardown's env destroy is best-effort and `end` is
 * legal there). PR_OPEN is deliberately absent (m17-plan Decision 4): its
 * lifecycle belongs to GitHub — tearing it down would delete the token the
 * poll reconciler needs and skip the unit past the merge/close it is waiting
 * for. The webhook/poll advances it to a terminal state; the grace collects
 * it there.
 */
export const IDLE_REAP_STATES: readonly WorkState[] = [
  'CREATED',
  'PROVISIONING',
  'READY',
  'WORKING',
  'PRE_PR',
];

/** States the terminal grace covers: the FSM is done, only cleanup remains. */
export const TERMINAL_REAP_STATES: readonly WorkState[] = ['PR_MERGED', 'PR_CLOSED', 'FAILED'];

export interface ReapPolicy {
  /** Tear down a pre-PR unit whose tenant has been silent this long. */
  idleTtlMs?: number;
  /** Tear down a terminal unit unchanged for this long. */
  terminalGraceMs?: number;
  /** Sweep cadence (also the election lease's renewal tick). */
  intervalMs: number;
}

const DEFAULT_REAP_INTERVAL_MS = 60_000;

/**
 * Read the reclamation knobs. Enabled by either TTL; unset ⇒ undefined (no
 * reaper). Garbage or non-positive values refuse loudly at boot, and an
 * interval without any TTL is a dead knob and refuses too — the boot.ts
 * discipline for silently-dead config (m17-plan Decision 6).
 */
export function reapPolicyFromEnv(env: Record<string, string | undefined>): ReapPolicy | undefined {
  const idleTtlMs = positiveIntFromEnv(env, 'DEVSPACE_IDLE_TTL_MS');
  const terminalGraceMs = positiveIntFromEnv(env, 'DEVSPACE_TERMINAL_GRACE_MS');
  const intervalMs = positiveIntFromEnv(env, 'DEVSPACE_REAP_INTERVAL_MS');
  if (idleTtlMs === undefined && terminalGraceMs === undefined) {
    if (intervalMs !== undefined) {
      throw new Error(
        'DEVSPACE_REAP_INTERVAL_MS is set but neither DEVSPACE_IDLE_TTL_MS nor ' +
          'DEVSPACE_TERMINAL_GRACE_MS is — the interval alone reaps nothing',
      );
    }
    return undefined;
  }
  return { idleTtlMs, terminalGraceMs, intervalMs: intervalMs ?? DEFAULT_REAP_INTERVAL_MS };
}

function positiveIntFromEnv(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (ms), got "${raw}"`);
  }
  return value;
}
