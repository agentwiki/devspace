import { describe, expect, it } from 'vitest';
import { checkCommand, checkFileWrite, redactSecrets, requiresApproval } from './guardrails.js';

describe('command guardrails', () => {
  it('denies destructive commands and patterns', () => {
    expect(checkCommand('rm -rf / --no-preserve-root').allowed).toBe(false);
    expect(checkCommand('git push --force origin main').allowed).toBe(false);
    expect(checkCommand('shutdown now').allowed).toBe(false);
  });
  it('allows ordinary commands', () => {
    const v = checkCommand('npm test');
    expect(v.allowed).toBe(true);
  });
});

describe('file-write guardrails', () => {
  it('confines writes to the workspace', () => {
    expect(checkFileWrite('/workspace/src/a.ts').allowed).toBe(true);
    expect(checkFileWrite('src/a.ts').allowed).toBe(true);
    expect(checkFileWrite('/etc/passwd').allowed).toBe(false);
    expect(checkFileWrite('/workspace/../etc/passwd').allowed).toBe(false);
  });
  it('protects the agent runtime and git hooks', () => {
    expect(checkFileWrite('/opt/agent-runtime/codex-acp').allowed).toBe(false);
  });
});

describe('approval + redaction', () => {
  it('flags push/PR/network for approval', () => {
    expect(requiresApproval('git_push')).toBe(true);
    expect(requiresApproval('pr_create')).toBe(true);
    expect(requiresApproval('file_write')).toBe(false);
  });
  it('redacts secret values from streamed text', () => {
    expect(redactSecrets('token=ghp_secret123', ['ghp_secret123'])).toBe('token=«redacted»');
  });
});
