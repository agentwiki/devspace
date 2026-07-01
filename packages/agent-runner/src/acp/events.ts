/**
 * ACP -> normalized event mapping.
 *
 * codex-acp (and any ACP agent) reports turn progress as `session/update`
 * notifications whose shapes are defined by the protocol, NOT by codex. So the
 * translation into our `AgentEvent` union is generic ACP logic, shared by every
 * backend; a backend only overrides it if its agent deviates from the spec.
 *
 * Everything here is pure and total: unknown/unsupported updates map to `null`
 * (surface nothing) rather than throwing, so a newer agent emitting an update
 * variant we don't model yet can never crash a turn.
 */
import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { AgentEvent, GuardedOp } from '@devspace/contracts';

/** Plain text out of a content block, or null for non-text (image/audio/resource). */
function textOf(block: ContentBlock): string | null {
  return block.type === 'text' ? block.text : null;
}

/** First diff among a tool call's content items, rendered as a minimal patch. */
function diffOf(
  content: ToolCallContent[] | null | undefined,
): { path: string; diff: string } | null {
  for (const item of content ?? []) {
    if (item.type === 'diff') {
      const { path, oldText, newText } = item;
      const header = `--- ${oldText == null ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n`;
      return { path, diff: header + newText };
    }
  }
  return null;
}

/** Map ACP tool kinds onto the guarded-operation vocabulary the platform gates. */
export function opForToolKind(kind: ToolKind | null | undefined): GuardedOp {
  switch (kind) {
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_write';
    case 'fetch':
      return 'network';
    case 'execute':
    default:
      return 'command_run';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Best-effort command line for an `execute` tool call, for the command_run event. */
function commandOf(tc: ToolCall | ToolCallUpdate): string {
  const raw = asRecord(tc.rawInput);
  const command = raw.command ?? raw.cmd;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return tc.title ?? '';
}

function mapToolCall(tc: ToolCall): AgentEvent | null {
  const diff = diffOf(tc.content);
  if (diff) return { type: 'file_edit', path: diff.path, diff: diff.diff };
  if (tc.kind === 'execute') return { type: 'command_run', cmd: commandOf(tc) };
  return { type: 'tool_call', name: tc.title, args: asRecord(tc.rawInput) };
}

function mapToolCallUpdate(tc: ToolCallUpdate): AgentEvent | null {
  const diff = diffOf(tc.content);
  if (diff) return { type: 'file_edit', path: diff.path, diff: diff.diff };
  if (tc.status === 'completed' || tc.status === 'failed') {
    return {
      type: 'tool_result',
      name: tc.title ?? tc.toolCallId,
      ok: tc.status === 'completed',
      summary: tc.title ?? tc.toolCallId,
    };
  }
  return null;
}

/**
 * Translate a single ACP session update into a normalized AgentEvent, or null if
 * it carries nothing the platform surfaces (user-message echoes, plans, mode and
 * usage updates, empty chunks).
 */
export function mapSessionUpdate(update: SessionUpdate): AgentEvent | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textOf(update.content);
      return text == null || text === '' ? null : { type: 'message', text };
    }
    case 'agent_thought_chunk': {
      const text = textOf(update.content);
      return text == null || text === '' ? null : { type: 'thought', text };
    }
    case 'tool_call':
      return mapToolCall(update);
    case 'tool_call_update':
      return mapToolCallUpdate(update);
    default:
      // user_message_chunk, plan, available_commands_update, current_mode_update,
      // config_option_update, session_info_update, usage_update — not surfaced.
      return null;
  }
}

/** Map an ACP prompt stop reason onto the terminal turn_end reason. */
export function stopReasonToTurnEnd(reason: StopReason): 'completed' | 'aborted' | 'error' {
  return reason === 'cancelled' ? 'aborted' : 'completed';
}
