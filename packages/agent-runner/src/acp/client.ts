/**
 * The devspace ACP Client.
 *
 * agent-runner is the ACP CLIENT: it receives the agent's `session/update`
 * notifications and permission requests and translates them into the platform's
 * normalized surface. This class implements the SDK `Client` interface with two
 * jobs:
 *
 *  1. sessionUpdate  -> map to an AgentEvent (via the backend) and push it to the
 *     active turn's sink.
 *  2. requestPermission -> emit a `permission_request` event and PARK the ACP
 *     request until a human decision arrives through `decide()`. This is the
 *     approval gate; the agent's turn genuinely blocks here (the Promise is the
 *     JSON-RPC response the agent is awaiting), so nothing sensitive runs without
 *     an explicit allow.
 *
 * The agent runs inside the sandbox and edits files on its own workspace disk, so
 * the optional client fs/terminal methods are intentionally NOT implemented — we
 * advertise no such capabilities during `initialize`.
 */
import { randomUUID } from 'node:crypto';
import type {
  Client,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentEvent, PermissionDecision } from '@devspace/contracts';
import type { AgentBackend } from '../backends/codex.js';
import type { GuardrailPolicy, GuardrailVerdict } from '../guardrails.js';
import { checkCommand, checkFileWrite, DEFAULT_POLICY } from '../guardrails.js';
import { commandOf, opForToolKind, pathOf } from './events.js';

export type EventSink = (event: AgentEvent) => void;

interface PendingPermission {
  resolve: (res: RequestPermissionResponse) => void;
  options: PermissionOption[];
}

/** Pick the option whose kind matches the decision, preferring the once-scoped one. */
function selectOption(
  options: PermissionOption[],
  decision: PermissionDecision,
): PermissionOption | null {
  const wanted: PermissionOptionKind[] =
    decision.decision === 'allow'
      ? decision.scope === 'session'
        ? ['allow_always', 'allow_once']
        : ['allow_once', 'allow_always']
      : decision.scope === 'session'
        ? ['reject_always', 'reject_once']
        : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match;
  }
  return null;
}

export class DevspaceAcpClient implements Client {
  private sink: EventSink | null = null;
  private readonly pending = new Map<string, PendingPermission>();

  constructor(
    private readonly backend: AgentBackend,
    private readonly onLog: (line: string) => void = () => {},
    private readonly policy: GuardrailPolicy = DEFAULT_POLICY,
  ) {}

  /** Route this turn's events to `sink`; pass null between turns. */
  setSink(sink: EventSink | null): void {
    this.sink = sink;
  }

  /** True while a permission request is outstanding and awaiting a decision. */
  get hasPendingPermission(): boolean {
    return this.pending.size > 0;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const event = this.backend.mapEvent(params.update);
    if (event && this.sink) this.sink(event);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const op = opForToolKind(params.toolCall.kind);
    const details = params.toolCall.title ?? params.toolCall.toolCallId;

    // M5 auto-deny (m5-plan Decision 5): consult the guardrail policy BEFORE
    // parking. A policy-denied op is rejected immediately with a plain
    // `message` — no permission_request is emitted, so no approval buttons
    // appear for something no human is allowed to approve anyway.
    const verdict = this.policyVerdict(op, params);
    if (verdict && !verdict.allowed) {
      this.onLog(`guardrail auto-deny: ${verdict.reason}`);
      this.sink?.({ type: 'message', text: `⛔ Denied by guardrail policy: ${verdict.reason}` });
      const option = selectOption(params.options, {
        requestId: 'auto-deny',
        decision: 'deny',
        scope: 'once',
      });
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }

    const requestId = randomUUID();
    this.sink?.({ type: 'permission_request', requestId, op, details });
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pending.set(requestId, { resolve, options: params.options });
    });
  }

  /** Deterministic policy check for the ops we can evaluate; null = no opinion. */
  private policyVerdict(
    op: ReturnType<typeof opForToolKind>,
    params: RequestPermissionRequest,
  ): GuardrailVerdict | null {
    if (op === 'command_run' || op === 'network') {
      const cmdline = commandOf(params.toolCall);
      return cmdline ? checkCommand(cmdline, this.policy) : null;
    }
    if (op === 'file_write') {
      const path = pathOf(params.toolCall);
      return path ? checkFileWrite(path, this.policy) : null;
    }
    return null; // git_push / pr_create stay purely human-gated
  }

  /**
   * Resolve a parked permission request. Returns false if the id is unknown
   * (already decided, or never issued). A decision with no matching option kind
   * is treated as a cancellation so the agent turn can unwind cleanly.
   */
  decide(decision: PermissionDecision): boolean {
    const entry = this.pending.get(decision.requestId);
    if (!entry) return false;
    this.pending.delete(decision.requestId);
    const option = selectOption(entry.options, decision);
    entry.resolve(
      option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } },
    );
    return true;
  }

  /** Cancel every outstanding permission request (used on session close/abort). */
  cancelAllPending(): void {
    for (const [, entry] of this.pending) {
      entry.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.pending.clear();
  }

  /** Surface an agent stderr log line (diagnostics only, never protocol data). */
  log(line: string): void {
    this.onLog(line);
  }
}
