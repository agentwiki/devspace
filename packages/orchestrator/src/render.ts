/**
 * Pure `AgentEvent → RenderCommand[]` mapping. No I/O — the caller ships the
 * commands. This is the ENTIRETY of M3's chat rendering; M4 adds only the Slack
 * transport that consumes `RenderCommand`s (no orchestrator logic moves to M4).
 *
 * Every outbound text field is passed through `redactSecrets` against the
 * conversation's live registry — 100% coverage is the invariant (defense in
 * depth; see secrets.ts).
 */
import type { AgentEvent, RenderCommand } from '@devspace/contracts';
import { redactSecrets } from './secrets.js';
import type { SecretRegistry } from './secrets.js';

/** Map one normalized agent event to zero or more render commands. */
export function renderAgentEvent(
  conversationId: string,
  evt: AgentEvent,
  registry: SecretRegistry,
): RenderCommand[] {
  const scrub = (t: string): string => redactSecrets(t, registry);
  const msg = (text: string): RenderCommand => ({
    type: 'post_message',
    conversationId,
    text: scrub(text),
  });

  switch (evt.type) {
    case 'thought':
      // Internal reasoning — not surfaced to chat.
      return [];
    case 'message':
      return [msg(evt.text)];
    case 'tool_call':
      return [
        { type: 'update_status', conversationId, state: 'tool', text: scrub(`⚙️ ${evt.name}`) },
      ];
    case 'tool_result':
      return [msg(`${evt.ok ? '✅' : '❌'} ${evt.name}: ${evt.summary}`)];
    case 'file_edit':
      return [msg(`✏️ edited \`${evt.path}\``)];
    case 'command_run':
      return [msg(`$ ${evt.cmd}${evt.exitCode === undefined ? '' : ` (exit ${evt.exitCode})`}`)];
    case 'permission_request':
      return [
        {
          type: 'post_actions',
          conversationId,
          text: scrub(`Approve ${evt.op}? ${evt.details}`),
          actions: [
            { actionId: `approve:${evt.requestId}`, label: 'Approve', style: 'primary' },
            { actionId: `deny:${evt.requestId}`, label: 'Deny', style: 'danger' },
          ],
        },
      ];
    case 'turn_end':
      return [
        {
          type: 'update_status',
          conversationId,
          state: evt.reason,
          text: scrub(turnEndText(evt.reason)),
        },
      ];
  }
}

function turnEndText(reason: 'completed' | 'aborted' | 'error'): string {
  switch (reason) {
    case 'completed':
      return 'Turn complete.';
    case 'aborted':
      return 'Turn aborted.';
    case 'error':
      return 'Turn ended with an error.';
  }
}

/** Render a plain status line (used by handlers for FSM milestones). */
export function statusCommand(
  conversationId: string,
  state: string,
  text: string,
  registry: SecretRegistry,
): RenderCommand {
  return { type: 'update_status', conversationId, state, text: redactSecrets(text, registry) };
}

/** Render a plain message (redacted). */
export function messageCommand(
  conversationId: string,
  text: string,
  registry: SecretRegistry,
): RenderCommand {
  return { type: 'post_message', conversationId, text: redactSecrets(text, registry) };
}
