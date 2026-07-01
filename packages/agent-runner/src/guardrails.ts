/**
 * Deterministic guardrails — the core safety layer.
 *
 * The agent never gets raw access to sandbox-core. Every operation it requests
 * passes through these checks BEFORE reaching exec/fs. Checks are pure and
 * unit-testable; policy is data, not code paths.
 */
import type { GuardedOp } from '@devspace/contracts';

export interface GuardrailPolicy {
  /** Commands (argv[0] basename) that are always denied. */
  deniedCommands: string[];
  /** Substrings that, if present in the full command line, deny it. */
  deniedCommandPatterns: string[];
  /** Absolute path prefixes the agent may never write to. */
  protectedWritePaths: string[];
  /** Root the agent's writes are confined to. */
  workspaceRoot: string;
  /** Ops that require an explicit human approval gate. */
  approvalRequired: GuardedOp[];
  /** Per-turn budgets. */
  maxToolCallsPerTurn: number;
  turnWallClockMs: number;
}

export const DEFAULT_POLICY: GuardrailPolicy = {
  deniedCommands: ['shutdown', 'reboot', 'mkfs'],
  deniedCommandPatterns: ['rm -rf /', 'git push --force', 'git push -f', ':(){', 'curl | sh', 'wget | sh'],
  protectedWritePaths: ['/opt/agent-runtime', '/.git/hooks', '/etc'],
  workspaceRoot: '/workspace',
  approvalRequired: ['git_push', 'pr_create', 'network'],
  maxToolCallsPerTurn: 100,
  turnWallClockMs: 10 * 60 * 1000,
};

export type GuardrailVerdict =
  | { allowed: true; requiresApproval: boolean }
  | { allowed: false; reason: string };

function basename(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  const parts = first.split('/');
  return parts[parts.length - 1] ?? first;
}

export function checkCommand(cmdline: string, policy: GuardrailPolicy = DEFAULT_POLICY): GuardrailVerdict {
  const base = basename(cmdline);
  if (policy.deniedCommands.includes(base)) {
    return { allowed: false, reason: `command "${base}" is denied` };
  }
  for (const pattern of policy.deniedCommandPatterns) {
    if (cmdline.includes(pattern)) {
      return { allowed: false, reason: `command matches denied pattern "${pattern}"` };
    }
  }
  return { allowed: true, requiresApproval: policy.approvalRequired.includes('command_run') };
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

export function checkFileWrite(path: string, policy: GuardrailPolicy = DEFAULT_POLICY): GuardrailVerdict {
  const abs = path.startsWith('/') ? normalize(path) : normalize(`${policy.workspaceRoot}/${path}`);
  for (const protectedPrefix of policy.protectedWritePaths) {
    if (abs === protectedPrefix || abs.startsWith(`${protectedPrefix}/`) || abs.includes(protectedPrefix)) {
      return { allowed: false, reason: `write to protected path "${abs}" is denied` };
    }
  }
  const root = normalize(policy.workspaceRoot);
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    return { allowed: false, reason: `write outside workspace "${abs}" is denied` };
  }
  return { allowed: true, requiresApproval: policy.approvalRequired.includes('file_write') };
}

export function requiresApproval(op: GuardedOp, policy: GuardrailPolicy = DEFAULT_POLICY): boolean {
  return policy.approvalRequired.includes(op);
}

/** Redact known secret values from any text streamed back to chat. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('«redacted»');
  }
  return out;
}
