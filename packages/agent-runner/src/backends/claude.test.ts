/**
 * Claude backend purity tests (M6-E) — launch/kill argv and env are exact,
 * mirroring the codex backend's contract. The runner's backend-agnosticism is
 * proven separately over the ACP loopback (runner.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { claudeBackend } from './claude.js';

describe('claudeBackend', () => {
  it('launches claude-code-acp from the runtime volume with key + model env', () => {
    const req = claudeBackend.launchCommand({
      workspacePath: '/workspace',
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-test',
    });
    expect(req.cmd).toEqual(['/opt/agent-runtime/bin/node', '/opt/agent-runtime/claude-code-acp']);
    expect(req.cwd).toBe('/workspace');
    expect(req.env).toEqual({
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(req.tty).toBe(false);
  });

  it('omits env vars that were not provided', () => {
    const req = claudeBackend.launchCommand({ workspacePath: '/w' });
    expect(req.env).toEqual({});
  });

  it('kill command SIGTERMs the adapter with the pgrep self-exclusion pattern', () => {
    const req = claudeBackend.killCommand();
    expect(req.cmd[0]).toBe('sh');
    expect(req.cmd[2]).toBe("pkill -TERM -f '[/]opt/agent-runtime/claude-code-acp' || true");
  });

  it('maps standard ACP session updates via the shared mapper', () => {
    expect(
      claudeBackend.mapEvent({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
    ).toEqual({ type: 'message', text: 'hello' });
    expect(claudeBackend.mapEvent({ sessionUpdate: 'never_heard_of_it' })).toBeNull();
  });
});
