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
 * it there. Since M18 the exemption's env COST is covered separately:
 * `prOpenEnvTtlMs` releases just the environment while the unit lives on.
 * Since M19 a RESUMED unit in these states (WORKING/PRE_PR with a prNumber)
 * is SUSPENDED back to PR_OPEN at the idle TTL instead of torn down — the
 * unit still holds the PR fields and token the reconciler needs.
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
  /**
   * Warn the thread this long before the idle TTL reaps it (M18). With this
   * set, no idle reap ever happens unwarned: a warning posted after the
   * tenant's last sign of life must have stood for the full window first
   * (m18-plan Decision 1). Requires idleTtlMs and must be smaller.
   */
  idleWarnMs?: number;
  /** Tear down a terminal unit unchanged for this long. */
  terminalGraceMs?: number;
  /**
   * Release the ENVIRONMENT of a PR_OPEN unit idle this long (M18): the
   * container, per-env network, and preview routes go; the unit, its
   * secrets, and the merge/close announcement stay. The partial-destroy
   * path the M17 PR_OPEN exemption priced (m18-plan Decisions 4–6).
   */
  prOpenEnvTtlMs?: number;
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
  const idleWarnMs = positiveIntFromEnv(env, 'DEVSPACE_IDLE_WARN_MS');
  const terminalGraceMs = positiveIntFromEnv(env, 'DEVSPACE_TERMINAL_GRACE_MS');
  const prOpenEnvTtlMs = positiveIntFromEnv(env, 'DEVSPACE_PR_OPEN_ENV_TTL_MS');
  const intervalMs = positiveIntFromEnv(env, 'DEVSPACE_REAP_INTERVAL_MS');
  if (idleWarnMs !== undefined && idleTtlMs === undefined) {
    throw new Error(
      'DEVSPACE_IDLE_WARN_MS is set but DEVSPACE_IDLE_TTL_MS is not — there is no TTL to warn ahead of',
    );
  }
  if (idleWarnMs !== undefined && idleTtlMs !== undefined && idleWarnMs >= idleTtlMs) {
    throw new Error(
      `DEVSPACE_IDLE_WARN_MS (${idleWarnMs}) must be smaller than DEVSPACE_IDLE_TTL_MS ` +
        `(${idleTtlMs}) — the warning window opens before the TTL, not around it`,
    );
  }
  if (idleTtlMs === undefined && terminalGraceMs === undefined && prOpenEnvTtlMs === undefined) {
    if (intervalMs !== undefined) {
      throw new Error(
        'DEVSPACE_REAP_INTERVAL_MS is set but none of DEVSPACE_IDLE_TTL_MS, ' +
          'DEVSPACE_TERMINAL_GRACE_MS, or DEVSPACE_PR_OPEN_ENV_TTL_MS is — the ' +
          'interval alone reaps nothing',
      );
    }
    return undefined;
  }
  return {
    idleTtlMs,
    idleWarnMs,
    terminalGraceMs,
    prOpenEnvTtlMs,
    intervalMs: intervalMs ?? DEFAULT_REAP_INTERVAL_MS,
  };
}

/** "90s" / "45m" / "1.5h" — chat-grade precision for the warning text. */
export function approxDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 360_000) / 10}h`;
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
