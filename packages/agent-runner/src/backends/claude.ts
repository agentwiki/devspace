/**
 * Claude backend (second ACP target, M6-E) — proof that "a second agent is a
 * new backend, not a rewrite of the runner" (M2, top-risk #6).
 *
 * claude-code-acp (Claude Code's ACP adapter) speaks standard ACP, so
 * `mapEvent` delegates to the shared `mapSessionUpdate` exactly like codex.
 * Everything agent-specific is the launch/kill argv and the env var names.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { mapSessionUpdate } from '../acp/events.js';
import { AGENT_RUNTIME_PATH, type AgentBackend } from './codex.js';

export const claudeBackend: AgentBackend = {
  kind: 'claude',
  launchCommand({ workspacePath, model, apiKey }) {
    const env: Record<string, string> = {};
    if (model) env.ANTHROPIC_MODEL = model;
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    return {
      cmd: [`${AGENT_RUNTIME_PATH}/bin/node`, `${AGENT_RUNTIME_PATH}/claude-code-acp`],
      cwd: workspacePath,
      env,
      tty: false,
    };
  },
  killCommand() {
    // Same pgrep-self-exclusion trick as codex ('[/]' still matches the
    // agent's /opt/... argv but never the killer shell's own command line).
    const pattern = `[/]${AGENT_RUNTIME_PATH.slice(1)}/claude-code-acp`;
    return {
      cmd: ['sh', '-c', `pkill -TERM -f '${pattern}' || true`],
      tty: false,
    };
  },
  mapEvent(update) {
    return mapSessionUpdate(update as SessionUpdate);
  },
};
