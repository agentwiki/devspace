/**
 * @devspace/orchestrator
 *
 * The control plane and the ONLY component that knows all others. Owns the
 * work-unit FSM and routes events so the provider dependency graph stays a DAG:
 *   orchestrator -> chat-gateway (render), agent-runner (turn), sandbox-core (env)
 *   providers -> orchestrator (events, up)
 *   agent-runner -> sandbox-core (exec, the one allowed downward cross-edge)
 *
 * M3 makes this real: platform-agnostic `handleChatEvent` routing over the
 * landed `ChatEvent`/`RenderCommand` contracts, synchronous provisioning (the
 * orchestrator itself applies `envReady`/`error` — `SandboxCore` emits no
 * events), a host-side git/PR wrapper (no writable token in the container), and
 * an envelope-encrypted secret store with 100%-of-outbound redaction. The event
 * bus carries only genuinely out-of-process producers: the PR poll reconciler.
 */
import type {
  AgentEvent,
  ChatEvent,
  ChatPlatform,
  RenderCommand,
  SessionSummary,
  WorkEvent,
  WorkState,
  WorkUnit,
} from '@devspace/contracts';
import {
  CreateAgentSessionRequestSchema,
  CreateEnvironmentRequestSchema,
} from '@devspace/contracts';
import type { EventRecord, Repositories, WorkUnitRepo } from '@devspace/db';
import { IllegalTransitionError } from '@devspace/db';
import { SandboxError, type SandboxCore } from '@devspace/sandbox-core';
import type { AgentRunner } from '@devspace/agent-runner';
import { agentRuntimeMount } from '@devspace/agent-runner';
import { classifyAction, WorkUnitMachine } from './stateMachine.js';
import {
  buildHistoryPreamble,
  buildHistoryReplay,
  HISTORY_MAX_ENTRIES,
  REPLAY_MAX_ENTRIES,
} from './transcript.js';
import {
  approxDuration,
  IDLE_REAP_STATES,
  TERMINAL_REAP_STATES,
  type ReapPolicy,
} from './reaper.js';
import { SecretRegistry } from './secrets.js';
import type { SecretStore } from './secrets.js';
import { GitWrapper, prStateToEvent, type GitHubRestClient, type HostGitExec } from './git.js';
import { messageCommand, renderAgentEvent, statusCommand } from './render.js';
import { sameRepo, type MappedPrWebhook } from './webhooks.js';

export * from './stateMachine.js';
export * from './transcript.js';
export * from './secrets.js';
export * from './git.js';
export * from './render.js';
export * from './webhooks.js';
export * from './internal-http.js';
export * from './election.js';
export * from './reaper.js';
// boot.js imports Orchestrator from this module; the cycle is benign (the
// class is only referenced inside bootOrchestrator's body, after module init).
export * from './boot.js';

/** Well-known secret names. The push/PR token is host-only; clone token is the
 * only credential permitted inside a container (read-only). */
export const SECRET_LLM_KEY = 'LLM_KEY';
export const SECRET_GH_TOKEN = 'GITHUB_TOKEN'; // host-side push + PR create
export const SECRET_GH_CLONE = 'GITHUB_CLONE_TOKEN'; // optional, read-only, in-container

/** Bus topics for the out-of-process PR reconciler (webhook stand-in). */
export const TOPIC_PR_MERGED = 'pr.merged';
export const TOPIC_PR_CLOSED = 'pr.closed';

export class OrchestratorError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export interface OrchestratorDeps {
  repos: Repositories;
  sandbox: SandboxCore;
  agents: AgentRunner;
  secrets: SecretStore;
  /** Host-side git executor (never runs inside a container). */
  git: HostGitExec;
  /** Build a REST client bound to a freshly resolved host token. */
  githubRest: (token: string) => GitHubRestClient;
  /** Push a render command to whichever platform owns the conversation. */
  render: (command: RenderCommand) => Promise<void>;
  /** Host checkout dir a work unit's push runs from. */
  workdirFor?: (workUnitId: string) => string;
  /** Revoke a revocable OAuth/App token on teardown (best-effort). */
  revokeToken?: (token: string) => Promise<void>;
  /** Base branch for PRs (default 'main'). */
  baseBranch?: string;
}

// Linear rank so "already in or past the target state" is a single comparison.
// Both terminal PR states share a rank (past PR_OPEN); FAILED/TORN_DOWN sit
// above every forward target so a late event never resurrects a dead unit.
const STATE_RANK: Record<WorkState, number> = {
  CREATED: 0,
  PROVISIONING: 1,
  READY: 2,
  WORKING: 3,
  PRE_PR: 4,
  PR_OPEN: 5,
  PR_MERGED: 6,
  PR_CLOSED: 6,
  FAILED: 7,
  TORN_DOWN: 8,
};

export class Orchestrator {
  readonly machine: WorkUnitMachine;
  private readonly workUnits: WorkUnitRepo;
  private readonly registries = new Map<string, SecretRegistry>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.machine = new WorkUnitMachine(deps.repos.workUnits);
    this.workUnits = deps.repos.workUnits;
  }

  /**
   * Record a privileged operation in the append-only audit trail (M5,
   * m5-plan Decision 6). `detail` is built from ids/names/enums only — never
   * secret plaintext — so the log needs no redaction pass. Awaited normally:
   * an audit of a privileged effect must not silently vanish.
   */
  private audit(
    action: string,
    ctx: {
      userId?: string;
      conversationId?: string;
      workUnitId?: string;
      detail?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    return this.deps.repos.audit.append({
      action,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      workUnitId: ctx.workUnitId,
      detail: ctx.detail ?? {},
    });
  }

  /** Per-conversation redaction registry (accumulates resolved plaintext). */
  private registryFor(conversationId: string): SecretRegistry {
    let reg = this.registries.get(conversationId);
    if (!reg) {
      reg = new SecretRegistry();
      this.registries.set(conversationId, reg);
    }
    return reg;
  }

  private emit(command: RenderCommand): Promise<void> {
    return this.deps.render(command);
  }

  /**
   * Stamp tenant activity (M17): the idle clock the lifecycle reaper reads.
   * Best-effort — activity bookkeeping must never fail the event it rode in on.
   */
  private async touchActivity(workUnitId: string): Promise<void> {
    try {
      await this.workUnits.touch(workUnitId);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Persist one transcript entry (M20), redacted through the conversation's
   * registry BEFORE storage — the 100%-of-outbound invariant extends to the
   * table at rest (m20-plan Decision 3; the registry is warm because the
   * message path re-registers the LLM key every turn). Best-effort:
   * transcript bookkeeping never fails the turn it rode in on (the M17
   * `touch` discipline). Empty text (a turn with no message chunks) is
   * skipped — no row, no noise.
   */
  private async appendTranscript(
    conversationId: string,
    workUnitId: string,
    role: 'user' | 'agent',
    text: string,
    registry: SecretRegistry,
  ): Promise<void> {
    if (!text) return;
    try {
      await this.deps.repos.transcripts.append({
        conversationId,
        workUnitId,
        role,
        text: registry.redact(text),
      });
    } catch {
      /* best-effort */
    }
  }

  /** The in-chat entry point for secret setup (M6-D) — a single stable action
   * id the platform adapter turns into its own UI (Slack: a modal). */
  private emitSecretsPrompt(conversationId: string): Promise<void> {
    return this.emit({
      type: 'post_actions',
      conversationId,
      text: 'Configure credentials for this session — stored encrypted, never echoed.',
      actions: [{ actionId: 'set-secrets', label: 'Set secrets', style: 'primary' }],
    });
  }

  /**
   * Apply a forward transition idempotently: if the unit is already in or past
   * the target state, no-op (redelivery), never call `transition` (which would
   * throw on the now-illegal transition). Distinct from the transition
   * primitive's atomicity — this is handler-level redelivery safety.
   */
  private async advance(
    unit: WorkUnit,
    event: WorkEvent,
    targetState: WorkState,
    patch?: Partial<WorkUnit>,
  ): Promise<WorkUnit> {
    if (STATE_RANK[unit.state] >= STATE_RANK[targetState]) return unit;
    return this.machine.apply(unit.id, event, patch);
  }

  /** Assert the event's user owns the conversation before any secret/state work. */
  private async assertOwnership(conversationId: string, userId: string): Promise<void> {
    const conv = await this.deps.repos.conversations.get(conversationId);
    if (!conv) throw new OrchestratorError('NOT_FOUND', `conversation ${conversationId}`);
    if (conv.userId !== userId) {
      throw new OrchestratorError('FORBIDDEN', `user ${userId} does not own ${conversationId}`);
    }
  }

  /**
   * Route a chat event. `conversation.created` returns the freshly created
   * `conversationId` so the gateway can bind it to its platform thread (M4,
   * Decision 1) — a return value exposing already-created state, not new
   * control logic. Other events return void.
   */
  async handleChatEvent(event: ChatEvent): Promise<{ conversationId: string } | void> {
    switch (event.type) {
      case 'conversation.created':
        return this.onConversationCreated(event);
      case 'message.posted':
        return this.onMessagePosted(event);
      case 'secret.submitted':
        return this.onSecretSubmitted(event);
      case 'action.invoked':
        return this.onActionInvoked(event);
    }
  }

  /** Gateway cold-miss resolution (post-restart): platform thread → conversation. */
  async resolveConversationId(platform: string, externalChannelId: string): Promise<string | null> {
    const conv = await this.deps.repos.conversations.getByExternalChannelId(
      platform,
      externalChannelId,
    );
    return conv?.id ?? null;
  }

  /**
   * A user's sessions on one platform, each joined with its work unit's state —
   * the App Home / `GET /sessions` read (M6, the M4 App-Home deferral).
   */
  async listSessions(platform: ChatPlatform, userId: string): Promise<SessionSummary[]> {
    const convs = await this.deps.repos.conversations.listByUser(platform, userId);
    const sessions: SessionSummary[] = [];
    for (const conv of convs) {
      const wu = await this.deps.repos.workUnits.getByConversation(conv.id);
      if (!wu) continue;
      sessions.push({
        conversationId: conv.id,
        platform,
        externalChannelId: conv.externalChannelId,
        state: wu.state,
        repoUrl: wu.repoUrl,
        prUrl: wu.prUrl,
        updatedAt: wu.updatedAt,
      });
    }
    return sessions;
  }

  /* ---------------------------------------------------------------------- */
  /* conversation.created                                                    */
  /* ---------------------------------------------------------------------- */

  private async onConversationCreated(
    event: Extract<ChatEvent, { type: 'conversation.created' }>,
  ): Promise<{ conversationId: string }> {
    const conv = await this.deps.repos.conversations.create({
      platform: event.platform,
      externalChannelId: event.externalChannelId,
      userId: event.userId,
    });
    const wu = await this.deps.repos.workUnits.create({ conversationId: conv.id });
    const registry = this.registryFor(conv.id);
    const created = { conversationId: conv.id };

    const choice = event.repoChoice;
    if (!choice || choice.empty || !choice.repoUrl) {
      await this.emit(statusCommand(conv.id, 'CREATED', 'Conversation ready.', registry));
      await this.emitSecretsPrompt(conv.id);
      return created;
    }

    const branch = `devspace/${wu.id}`;
    // The tenant's egress narrowing (M22) and env-vars/setup-script shape
    // (M24) ride the choice onto the env request AND the unit row — resume
    // must re-provision the SAME environment, never a silently wider or
    // differently-shaped one (m22-plan Decision 6; m24-plan).
    const envShape = {
      ...(choice.networkAccess !== undefined
        ? {
            networkAccess: choice.networkAccess,
            ...(choice.allowedHosts !== undefined ? { allowedHosts: choice.allowedHosts } : {}),
          }
        : {}),
      ...(choice.env !== undefined ? { env: choice.env } : {}),
      ...(choice.setupScript !== undefined ? { setupScript: choice.setupScript } : {}),
    };
    try {
      const provisioning = await this.advance(wu, 'repoChoice', 'PROVISIONING', {
        repoUrl: choice.repoUrl,
        branch,
        ...envShape,
      });
      await this.emit(
        statusCommand(conv.id, 'PROVISIONING', 'Provisioning environment…', registry),
      );
      await this.emitSecretsPrompt(conv.id);

      // Only the read-only clone token (if any) enters the container.
      const cloneToken = await this.deps.secrets.resolve(
        event.userId,
        SECRET_GH_CLONE,
        conv.id,
        registry,
      );
      if (cloneToken) {
        await this.audit('secret.resolved', {
          userId: event.userId,
          conversationId: conv.id,
          workUnitId: wu.id,
          detail: { name: SECRET_GH_CLONE, purpose: 'env.provision' },
        });
      }
      const env = await this.deps.sandbox.createEnvironment(
        CreateEnvironmentRequestSchema.parse({
          repoUrl: choice.repoUrl,
          ref: choice.ref,
          mounts: [agentRuntimeMount()],
          secrets: cloneToken ? [{ name: SECRET_GH_CLONE, value: cloneToken, target: 'env' }] : [],
          ...envShape,
        }),
      );

      await this.advance(provisioning, 'envReady', 'READY', { envId: env.envId });
      await this.emit(
        statusCommand(conv.id, 'READY', 'Environment ready. Send a message to start.', registry),
      );
    } catch (err) {
      await this.failWorkUnit(wu.id, conv.id, err, registry);
    }
    return created;
  }

  /* ---------------------------------------------------------------------- */
  /* secret.submitted (M6, m6-plan Decision 8)                               */
  /* ---------------------------------------------------------------------- */

  private async onSecretSubmitted(
    event: Extract<ChatEvent, { type: 'secret.submitted' }>,
  ): Promise<void> {
    await this.assertOwnership(event.conversationId, event.userId);
    const registry = this.registryFor(event.conversationId);
    const wu = await this.deps.repos.workUnits.getByConversation(event.conversationId);
    if (wu) await this.touchActivity(wu.id);
    // Register the plaintext BEFORE anything else can render: an agent (or
    // user) echoing the value is redacted from the moment it exists here.
    registry.register(event.value);
    await this.deps.secrets.put(event.userId, event.conversationId, event.name, event.value);
    // Name only — never the value (the M5 audit-hygiene invariant).
    await this.audit('secret.stored', {
      userId: event.userId,
      conversationId: event.conversationId,
      detail: { name: event.name },
    });
    await this.emit(
      messageCommand(
        event.conversationId,
        `Stored ${event.name} for this conversation (encrypted at rest, never echoed).`,
        registry,
      ),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* message.posted                                                          */
  /* ---------------------------------------------------------------------- */

  private async onMessagePosted(
    event: Extract<ChatEvent, { type: 'message.posted' }>,
  ): Promise<void> {
    await this.assertOwnership(event.conversationId, event.userId);
    const registry = this.registryFor(event.conversationId);
    const wu = await this.requireWorkUnit(event.conversationId);
    await this.touchActivity(wu.id);

    if (STATE_RANK[wu.state] < STATE_RANK['READY']) {
      await this.emit(
        messageCommand(
          event.conversationId,
          'The environment is still provisioning — one moment.',
          registry,
        ),
      );
      return;
    }
    if (STATE_RANK[wu.state] > STATE_RANK['WORKING']) {
      // PR_OPEN is no longer a dead end (M19): offer the explicit resume
      // action instead of booting a container on a stray "thanks!".
      if (wu.state === 'PR_OPEN') {
        await this.emit({
          type: 'post_actions',
          conversationId: event.conversationId,
          text:
            'This session is paused while its PR is under review — resume to keep ' +
            'working on the same branch, or start a new conversation.',
          actions: [{ actionId: 'resume-work', label: 'Resume work', style: 'primary' }],
        });
        return;
      }
      await this.emit(
        messageCommand(
          event.conversationId,
          'This work unit has moved on to its PR — start a new conversation for more changes.',
          registry,
        ),
      );
      return;
    }

    // The agent runner resolves the LLM key itself (by record id, for
    // injection), which bypasses this conversation's redaction registry — so
    // register the plaintext here, EVERY turn, or an agent echoing its key
    // would reach chat unredacted (B's 100%-of-outbound invariant). Every
    // turn, not just the first: registries are in-memory, and a restart
    // mid-conversation must not reopen the hole.
    const llm = await this.deps.repos.secrets.get(
      event.userId,
      SECRET_LLM_KEY,
      event.conversationId,
    );
    if (llm) {
      await this.deps.secrets.resolveRef(llm.id, registry);
      await this.audit('secret.resolved', {
        userId: event.userId,
        conversationId: event.conversationId,
        workUnitId: wu.id,
        detail: { name: SECRET_LLM_KEY, purpose: 'agent.turn' },
      });
    }

    // Ensure an agent session, transitioning READY --firstMessage--> WORKING on
    // the first message. Subsequent messages find WORKING and skip the transition.
    let unit = wu;
    let prompt = event.text;
    let agentSessionId = wu.agentSessionId;
    if (!agentSessionId) {
      if (!llm) {
        await this.emit(
          messageCommand(
            event.conversationId,
            'No LLM key configured for this conversation.',
            registry,
          ),
        );
        return;
      }
      if (!unit.envId) throw new OrchestratorError('BAD_REQUEST', 'work unit has no environment');
      const session = await this.deps.agents.createSession(
        CreateAgentSessionRequestSchema.parse({ envId: unit.envId, llmKeyRef: llm.id }),
      );
      agentSessionId = session.agentSessionId;
      // READY takes the firstMessage edge; a resumed unit is ALREADY WORKING,
      // where `advance` would no-op and silently drop the patch — one orphan
      // ACP session per message. The M19 self-loop persists it instead.
      const resumed = unit.state !== 'READY';
      if (resumed) {
        // History restore (M20): a fresh session on a resumed unit starts
        // blind — carry the prior conversation into its first prompt. Only
        // this prompt: the preamble is never persisted, so suspend/resume
        // cycles cannot compound it (m20-plan Decision 5).
        const history = await this.restoredHistory(event.conversationId);
        if (history) prompt = `${history}\n\n${event.text}`;
      }
      unit = await this.machine.apply(unit.id, resumed ? 'resume' : 'firstMessage', {
        agentSessionId,
      });
    }

    // The turn is going to run: the tenant's prompt joins the durable
    // transcript (M20, m20-plan Decision 1 — guard-path replies above never
    // ran a turn and never persist). Always the tenant's OWN text, never a
    // restored-history preamble.
    await this.appendTranscript(event.conversationId, unit.id, 'user', event.text, registry);

    let agentReply = '';
    try {
      for await (const agentEvent of this.deps.agents.runTurn(agentSessionId, {
        prompt,
        attachments: [],
      })) {
        // `message` events are stream CHUNKS — coalesce into one row per turn.
        if (agentEvent.type === 'message') agentReply += agentEvent.text;
        // A budget-aborted turn is a privileged intervention worth an audit row.
        if (agentEvent.type === 'turn_end' && agentEvent.reason === 'aborted') {
          await this.audit('turn.aborted', {
            userId: event.userId,
            conversationId: event.conversationId,
            workUnitId: unit.id,
            detail: { agentSessionId },
          });
        }
        await this.renderMany(event.conversationId, agentEvent, registry);
      }
    } finally {
      // Flushed in a finally (m20-plan Decision 2): a turn that dies
      // mid-stream still records what it said before dying.
      await this.appendTranscript(event.conversationId, unit.id, 'agent', agentReply, registry);
    }
  }

  /**
   * The restored-history preamble for a fresh session on a resumed unit
   * (M20): read the transcript tail and render it. A failed read degrades to
   * the M19 blind resume — never a failed turn (m20-plan Decision 4).
   */
  private async restoredHistory(conversationId: string): Promise<string> {
    try {
      const tail = await this.deps.repos.transcripts.listTail(conversationId, HISTORY_MAX_ENTRIES);
      return buildHistoryPreamble(tail);
    } catch {
      return '';
    }
  }

  private async renderMany(
    conversationId: string,
    agentEvent: AgentEvent,
    registry: SecretRegistry,
  ): Promise<void> {
    for (const cmd of renderAgentEvent(conversationId, agentEvent, registry)) {
      await this.emit(cmd);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* action.invoked                                                          */
  /* ---------------------------------------------------------------------- */

  private async onActionInvoked(
    event: Extract<ChatEvent, { type: 'action.invoked' }>,
  ): Promise<void> {
    await this.assertOwnership(event.conversationId, event.userId);
    const registry = this.registryFor(event.conversationId);
    const wu = await this.requireWorkUnit(event.conversationId);
    await this.touchActivity(wu.id);
    const action = classifyAction(event.actionId);

    switch (action.kind) {
      case 'approval': {
        if (!wu.agentSessionId) return;
        await this.deps.agents.decidePermission(wu.agentSessionId, {
          requestId: action.requestId,
          decision: action.decision,
          scope: 'once',
        });
        await this.audit('approval.decided', {
          userId: event.userId,
          conversationId: event.conversationId,
          workUnitId: wu.id,
          detail: { requestId: action.requestId, decision: action.decision },
        });
        return;
      }
      case 'hybrid': // create-pr — agent finalizes commits, host-side wrapper pushes + opens PR
        return this.onCreatePr(event.conversationId, event.userId, wu, registry);
      case 'resume': // resume-work — re-open work on a PR_OPEN unit (M19)
        return this.onResumeWork(event.conversationId, event.userId, wu, registry);
      case 'history': // view-history — replay the durable transcript (M21)
        return this.onViewHistory(event.conversationId, registry);
      case 'expose-port':
        return this.onExposePort(event.conversationId, event.userId, wu, action.port, registry);
      case 'deterministic': // view-pr
        await this.emit(
          messageCommand(
            event.conversationId,
            wu.prUrl ? `PR: ${wu.prUrl}` : 'No PR has been opened yet.',
            registry,
          ),
        );
        return;
      case 'unknown':
        await this.emit(
          messageCommand(event.conversationId, `Unknown action: ${action.actionId}`, registry),
        );
        return;
    }
  }

  /**
   * Replay the durable transcript tail into the thread (M21) — the first
   * product surface of the M20 table. Deliberately state-blind: the rows
   * survive suspension, env release, and teardown, so the replay answers in
   * every state (the "rows survive teardown … readable for product surfaces"
   * promise, cashed). Rows are redacted at rest AND the reply flows through
   * `messageCommand`'s redaction like every outbound string (m21-plan
   * Decision 4); a failed read answers message-only — a read surface never
   * throws into the action path.
   */
  private async onViewHistory(conversationId: string, registry: SecretRegistry): Promise<void> {
    let entries;
    try {
      // Probe one entry past the window so the omitted marker appears iff
      // something actually exists above it (m21-plan Decision 3).
      entries = await this.deps.repos.transcripts.listTail(conversationId, REPLAY_MAX_ENTRIES + 1);
    } catch {
      await this.emit(
        messageCommand(
          conversationId,
          'Could not read the conversation history — try again later.',
          registry,
        ),
      );
      return;
    }
    if (entries.length === 0) {
      await this.emit(
        messageCommand(conversationId, 'No conversation history recorded yet.', registry),
      );
      return;
    }
    const hasMore = entries.length > REPLAY_MAX_ENTRIES;
    const window = hasMore ? entries.slice(1) : entries;
    await this.emit(messageCommand(conversationId, buildHistoryReplay(window, hasMore), registry));
  }

  /**
   * Expose a container port through the preview proxy (M6). State-gated to a
   * live environment (READY…PR_OPEN); the returned URL is a capability URL
   * shown only in the owner's thread, and it dies with the env.
   */
  private async onExposePort(
    conversationId: string,
    userId: string,
    wu: WorkUnit,
    port: number,
    registry: SecretRegistry,
  ): Promise<void> {
    if (!wu.envId || STATE_RANK[wu.state] < STATE_RANK['READY']) {
      await this.emit(
        messageCommand(conversationId, 'No running environment to expose a port from.', registry),
      );
      return;
    }
    if (STATE_RANK[wu.state] > STATE_RANK['PR_OPEN']) {
      await this.emit(
        messageCommand(
          conversationId,
          'This work unit is finished — its environment is gone.',
          registry,
        ),
      );
      return;
    }
    try {
      const { proxyUrl } = await this.deps.sandbox.forwardPort(wu.envId, port);
      await this.audit('port.exposed', {
        userId,
        conversationId,
        workUnitId: wu.id,
        detail: { envId: wu.envId, port },
      });
      await this.emit(
        messageCommand(conversationId, `Port ${port} exposed: ${proxyUrl}`, registry),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emit(
        messageCommand(conversationId, `Could not expose port ${port}: ${message}`, registry),
      );
    }
  }

  private async onCreatePr(
    conversationId: string,
    userId: string,
    wu: WorkUnit,
    registry: SecretRegistry,
  ): Promise<void> {
    // Guarded on state: create-pr is only meaningful from WORKING/PRE_PR.
    if (wu.state === 'PR_OPEN' || wu.state === 'PR_MERGED' || wu.state === 'PR_CLOSED') {
      await this.emit(
        messageCommand(
          conversationId,
          wu.prUrl ? `PR already open: ${wu.prUrl}` : 'A PR already exists.',
          registry,
        ),
      );
      return;
    }
    if (wu.state !== 'WORKING' && wu.state !== 'PRE_PR') {
      await this.emit(
        messageCommand(
          conversationId,
          'Nothing to open a PR for yet — start working first.',
          registry,
        ),
      );
      return;
    }
    if (!wu.repoUrl || !wu.branch) {
      await this.emit(
        messageCommand(conversationId, 'This work unit has no repository.', registry),
      );
      return;
    }

    // Host-side push/PR token — resolved for its lifetime, registered so any
    // echo of it in output is redacted. Never injected into a container.
    const token = await this.deps.secrets.resolve(
      userId,
      SECRET_GH_TOKEN,
      conversationId,
      registry,
    );
    if (!token) {
      await this.emit(messageCommand(conversationId, 'No GitHub token configured.', registry));
      return;
    }
    await this.audit('secret.resolved', {
      userId,
      conversationId,
      workUnitId: wu.id,
      detail: { name: SECRET_GH_TOKEN, purpose: 'pr.create' },
    });

    const wrapper = new GitWrapper(this.deps.git, this.deps.githubRest(token));
    const result = await wrapper.pushAndOpenPr({
      repoUrl: wu.repoUrl,
      branch: wu.branch,
      base: this.deps.baseBranch ?? 'main',
      title: `devspace: ${wu.branch}`,
      body: 'Opened by the devspace agent.',
      token,
      workdir: this.deps.workdirFor?.(wu.id) ?? '/workspace',
    });
    await this.audit('pr.pushed', {
      userId,
      conversationId,
      workUnitId: wu.id,
      detail: { branch: wu.branch },
    });
    await this.audit('pr.opened', {
      userId,
      conversationId,
      workUnitId: wu.id,
      detail: { prNumber: result.prNumber, prUrl: result.prUrl, adopted: result.adopted },
    });

    let unit = await this.advance(wu, 'committedAndPushed', 'PRE_PR', { branch: wu.branch });
    unit = await this.advance(unit, 'prCreated', 'PR_OPEN', {
      prNumber: result.prNumber,
      prUrl: result.prUrl,
    });
    void unit;
    await this.emit(
      messageCommand(
        conversationId,
        `${result.adopted ? 'Adopted existing PR' : 'Opened PR'}: ${result.prUrl}`,
        registry,
      ),
    );
  }

  /**
   * Resume work on a PR_OPEN unit (M19, m19-plan Decisions 1–4): re-provision
   * the environment from the PR branch when it is gone, then apply
   * PR_OPEN --resume--> WORKING with the envId in the same transition. The
   * agent session is NOT created here — the next message creates it through
   * the ordinary lazy path, exactly like a fresh READY unit. A failed resume
   * leaves the unit PR_OPEN (never FAILED — GitHub owns that lifecycle, the
   * M17 exemption argument) and the button retries.
   */
  private async onResumeWork(
    conversationId: string,
    userId: string,
    wu: WorkUnit,
    registry: SecretRegistry,
  ): Promise<void> {
    if (wu.state === 'WORKING' || wu.state === 'PRE_PR') {
      await this.emit(
        messageCommand(
          conversationId,
          'This session is already active — just send a message.',
          registry,
        ),
      );
      return;
    }
    if (wu.state !== 'PR_OPEN') {
      await this.emit(
        messageCommand(
          conversationId,
          'This work unit is finished — start a new conversation for more changes.',
          registry,
        ),
      );
      return;
    }
    if (!wu.repoUrl || !wu.branch) {
      await this.emit(
        messageCommand(conversationId, 'This work unit has no repository.', registry),
      );
      return;
    }

    let envId = wu.envId;
    let reprovisioned = false;
    try {
      // Trust the host, not the row (the M11 discipline, one hop up): a
      // stale envId — the host lost the container, or a sibling released it
      // between the read and the click — re-provisions instead of resuming
      // onto a corpse. Any other probe failure fails the resume message-only.
      if (envId) {
        try {
          await this.deps.sandbox.getEnvironment(envId);
        } catch (err) {
          if (!(err instanceof SandboxError && err.code === 'NOT_FOUND')) throw err;
          envId = undefined;
        }
      }
      if (!envId) {
        // Same provisioning posture as conversation.created: only the
        // read-only clone token enters the container — but the ref is the PR
        // BRANCH, so the agent continues from what the reviewer sees.
        const cloneToken = await this.deps.secrets.resolve(
          userId,
          SECRET_GH_CLONE,
          conversationId,
          registry,
        );
        if (cloneToken) {
          await this.audit('secret.resolved', {
            userId,
            conversationId,
            workUnitId: wu.id,
            detail: { name: SECRET_GH_CLONE, purpose: 'env.resume' },
          });
        }
        const env = await this.deps.sandbox.createEnvironment(
          CreateEnvironmentRequestSchema.parse({
            repoUrl: wu.repoUrl,
            ref: wu.branch,
            mounts: [agentRuntimeMount()],
            secrets: cloneToken
              ? [{ name: SECRET_GH_CLONE, value: cloneToken, target: 'env' }]
              : [],
            // The unit's persisted egress policy (M22) and env/setup shape
            // (M24): a resume re-provision must rebuild the SAME environment
            // — never silently wider, never differently shaped.
            ...(wu.networkAccess !== undefined
              ? {
                  networkAccess: wu.networkAccess,
                  ...(wu.allowedHosts !== undefined ? { allowedHosts: wu.allowedHosts } : {}),
                }
              : {}),
            ...(wu.env !== undefined ? { env: wu.env } : {}),
            ...(wu.setupScript !== undefined ? { setupScript: wu.setupScript } : {}),
          }),
        );
        envId = env.envId;
        reprovisioned = true;
      }
      // envId lands in the SAME transition that makes the unit WORKING — no
      // window where the row owns a container it doesn't know about. Backward
      // move, so machine.apply directly: `advance` stays forward-only.
      await this.machine.apply(wu.id, 'resume', { envId });
      await this.audit('session.resumed', {
        userId,
        conversationId,
        workUnitId: wu.id,
        detail: { envId, reprovisioned },
      });
      await this.emit(
        statusCommand(
          conversationId,
          'WORKING',
          `Session resumed on \`${wu.branch}\` — send a message to continue.`,
          registry,
        ),
      );
    } catch (err) {
      // A container provisioned by THIS failing attempt was never persisted —
      // destroy it best-effort or it leaks with no pointer (m19-plan
      // Decision 3; the window is this one call).
      if (reprovisioned && envId) {
        try {
          await this.deps.sandbox.destroyEnvironment(envId);
        } catch {
          /* best-effort */
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.emit(
        messageCommand(conversationId, `Could not resume this session: ${message}`, registry),
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Out-of-process bus events (PR poll reconciler) + reconciler driver       */
  /* ---------------------------------------------------------------------- */

  /** Handle a durable bus event. Idempotent against redelivery. */
  async handleBusEvent(evt: EventRecord): Promise<void> {
    if (evt.topic !== TOPIC_PR_MERGED && evt.topic !== TOPIC_PR_CLOSED) return;
    if (!evt.workUnitId) return;
    const wu = await this.workUnits.get(evt.workUnitId);
    if (!wu) return;
    // A resumed unit (M19) sits below PR_OPEN while its PR truth is paused —
    // DROP the event rather than throw (`advance` would attempt the illegal
    // transition, and a throwing bus handler redelivers forever). The poll
    // backstop re-detects the PR state once the unit is back in PR_OPEN.
    if (STATE_RANK[wu.state] < STATE_RANK['PR_OPEN']) return;
    const registry = this.registryFor(wu.conversationId);
    if (evt.topic === TOPIC_PR_MERGED) {
      await this.advance(wu, 'prMerged', 'PR_MERGED');
      await this.emit(statusCommand(wu.conversationId, 'PR_MERGED', 'PR merged. 🎉', registry));
    } else {
      await this.advance(wu, 'prClosed', 'PR_CLOSED');
      await this.emit(statusCommand(wu.conversationId, 'PR_CLOSED', 'PR closed.', registry));
    }
  }

  /**
   * Apply a verified+mapped GitHub `pull_request` webhook (M5): find the
   * matching PR_OPEN unit(s) by repo + PR number and publish the SAME
   * idempotent bus topics the poll reconciler uses — webhook↔poll
   * double-delivery is a no-op by construction (`handleBusEvent` → `advance`).
   * Unmatched deliveries (foreign repos, already-advanced units) are ignored.
   */
  async handleGitHubWebhook(
    mapped: MappedPrWebhook,
    publish: (evt: { topic: string; workUnitId: string }) => Promise<void>,
  ): Promise<{ matched: number }> {
    const open = await this.workUnits.listByState('PR_OPEN');
    let matched = 0;
    for (const wu of open) {
      if (wu.prNumber !== mapped.prNumber) continue;
      if (!wu.repoUrl || !sameRepo(wu.repoUrl, mapped.repoUrl)) continue;
      matched += 1;
      await this.audit('webhook.received', {
        conversationId: wu.conversationId,
        workUnitId: wu.id,
        detail: { event: 'pull_request', outcome: mapped.outcome, prNumber: mapped.prNumber },
      });
      await publish({
        topic: mapped.outcome === 'merged' ? TOPIC_PR_MERGED : TOPIC_PR_CLOSED,
        workUnitId: wu.id,
      });
    }
    return { matched };
  }

  /**
   * Poll every PR_OPEN unit and publish idempotent prMerged/prClosed bus events.
   * Since M5 this is the RECONCILIATION BACKSTOP for webhook gaps (missed
   * deliveries, downtime) — webhooks are the source of truth; run this on a
   * long interval. The bus is genuinely out-of-process here (a scheduled
   * driver), unlike provisioning. The svc owns the schedule.
   */
  async reconcileOpenPrs(
    publish: (evt: { topic: string; workUnitId: string }) => Promise<void>,
  ): Promise<void> {
    const open = await this.workUnits.listByState('PR_OPEN');
    for (const wu of open) {
      if (!wu.repoUrl || wu.prNumber === undefined) continue;
      const owner = await this.deps.repos.conversations.get(wu.conversationId);
      if (!owner) continue;
      const token = await this.deps.secrets.resolve(
        owner.userId,
        SECRET_GH_TOKEN,
        wu.conversationId,
      );
      if (!token) continue;
      const wrapper = new GitWrapper(this.deps.git, this.deps.githubRest(token));
      const state = await wrapper.pollPrState({ repoUrl: wu.repoUrl, prNumber: wu.prNumber });
      const event = prStateToEvent(state);
      if (event === 'prMerged') await publish({ topic: TOPIC_PR_MERGED, workUnitId: wu.id });
      else if (event === 'prClosed') await publish({ topic: TOPIC_PR_CLOSED, workUnitId: wu.id });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Tear a work unit down: destroy the env, revoke + delete secrets, and apply
   * `end` → TORN_DOWN. Idempotent — a replayed teardown is a safe no-op.
   * `reason` lands in the audit detail (M17): `requested` for a user/operator
   * end, `idle` / `expired` for the lifecycle reaper's two policies.
   */
  async teardown(
    conversationId: string,
    reason: 'requested' | 'idle' | 'expired' = 'requested',
  ): Promise<void> {
    const wu = await this.deps.repos.workUnits.getByConversation(conversationId);
    if (!wu || wu.state === 'TORN_DOWN') return;
    const conv = await this.deps.repos.conversations.get(conversationId);

    if (wu.envId) {
      try {
        await this.deps.sandbox.destroyEnvironment(wu.envId);
      } catch {
        /* best-effort: env may already be gone */
      }
    }

    if (conv) {
      for (const name of [SECRET_GH_TOKEN, SECRET_GH_CLONE, SECRET_LLM_KEY]) {
        const rec = await this.deps.repos.secrets.get(conv.userId, name, conversationId);
        if (!rec) continue;
        if (name === SECRET_GH_TOKEN && this.deps.revokeToken) {
          try {
            const token = await this.deps.secrets.resolveRef(rec.id);
            await this.deps.revokeToken(token);
            await this.audit('token.revoked', {
              userId: conv.userId,
              conversationId,
              workUnitId: wu.id,
              detail: { name },
            });
          } catch {
            /* best-effort revoke */
          }
        }
        await this.deps.repos.secrets.delete(rec.id);
      }
    }

    this.registries.delete(conversationId);
    await this.audit('teardown', {
      userId: conv?.userId,
      conversationId,
      workUnitId: wu.id,
      detail: { envId: wu.envId ?? null, reason },
    });
    await this.advance(wu, 'end', 'TORN_DOWN');
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle reclamation (M17) — the elected reaper's sweep                 */
  /* ---------------------------------------------------------------------- */

  /**
   * One reclamation sweep (m17-plan Decisions 3–6): pre-PR units whose tenant
   * has been silent past `idleTtlMs` are torn down with a status notice in
   * their thread; terminal units unchanged past `terminalGraceMs` are torn
   * down silently (the thread already ended with its PR status — the audit
   * row is the record). PR_OPEN is exempt: GitHub owns that lifecycle.
   * Idleness reads max(lastActivityAt, updatedAt), so a fresh transition
   * counts as life and pre-M17 rows degrade to updatedAt. Per-unit failures
   * are counted and never stop the sweep; teardown's idempotency makes a
   * double-run (an elected sibling resuming past its lease TTL) harmless.
   *
   * With `idleWarnMs` set (M18), the idle phase warns before it reaps and no
   * idle reap ever happens unwarned: the reap fires only once a warning
   * posted after the tenant's last sign of life has stood for the full
   * window — a unit discovered already past the TTL (fresh election, knob
   * just tightened) is warned first and reaped `idleWarnMs` later, never on
   * the spot (m18-plan Decision 1). A warning is stale iff it predates the
   * idle clock's last-alive instant, so tenant activity invalidates it
   * without anything ever clearing the column (Decision 2).
   *
   * With `prOpenEnvTtlMs` set (M18), PR_OPEN units idle past the TTL lose
   * their ENVIRONMENT only — the partial-destroy path the M17 exemption
   * priced (m18-plan Decisions 4–6): destroy tolerating only NOT_FOUND
   * (`envId` is the control plane's sole pointer to the container — a
   * swallowed transient failure would leak it with no retry), then clear
   * `envId` + `agentSessionId`, audit `env.released`, and post one notice
   * AFTER the fact. The unit keeps its state, secrets, and PR fields, so
   * the reconciler, webhook, merge/close announcement, and terminal grace
   * all proceed unchanged.
   *
   * A RESUMED unit — one in WORKING/PRE_PR carrying a `prNumber`; only the
   * M19 resume puts a unit there — is SUSPENDED at the idle TTL, never torn
   * down (m19-plan Decision 5): the unit holds the PR fields and the token
   * the reconciler needs, the exact M17 Decision-4 argument. Destroy
   * tolerating only NOT_FOUND, `releaseEnv`, apply `suspend` (back to
   * PR_OPEN), audit `session.suspended`, one notice carrying the
   * resume-work button. Each step is retryable by the next sweep; the M18
   * warning discipline covers suspension too, with "paused" wording.
   *
   * With a retention horizon set (M21), a prune phase deletes transcript /
   * audit rows older than `now − retentionMs` and reports the counts —
   * bulk deletion is never silent (m21-plan Decision 7). Age predicates
   * are idempotent, so an elected sibling double-running past its lease
   * TTL double-deletes nothing; a prune failure counts as `failed` and
   * the rest of the sweep still runs.
   */
  async reapExpired(
    policy: Pick<
      ReapPolicy,
      | 'idleTtlMs'
      | 'idleWarnMs'
      | 'terminalGraceMs'
      | 'prOpenEnvTtlMs'
      | 'transcriptRetentionMs'
      | 'auditRetentionMs'
    >,
    nowMs: number = Date.now(),
  ): Promise<{
    reaped: number;
    warned: number;
    suspended: number;
    released: number;
    prunedTranscripts: number;
    prunedAudit: number;
    failed: number;
  }> {
    let reaped = 0;
    let warned = 0;
    let suspended = 0;
    let released = 0;
    let prunedTranscripts = 0;
    let prunedAudit = 0;
    let failed = 0;

    // The idle clock (M17): a fresh transition counts as life; pre-M17 rows
    // (null lastActivityAt) degrade to updatedAt.
    const lastAliveMs = (wu: WorkUnit): number =>
      Math.max(Date.parse(wu.updatedAt), wu.lastActivityAt ? Date.parse(wu.lastActivityAt) : 0);

    const reapIdle = async (wu: WorkUnit): Promise<void> => {
      // Announce BEFORE the env dies — through the render path that never
      // throws, so a dead gateway cannot block reclamation.
      await this.emit(
        statusCommand(
          wu.conversationId,
          'TORN_DOWN',
          'Session reclaimed after inactivity — start a new conversation to continue.',
          this.registryFor(wu.conversationId),
        ),
      );
      await this.teardown(wu.conversationId, 'idle');
    };

    // Suspend an idle resumed unit back to PR_OPEN (m19-plan Decision 5).
    // Destroy strictly, tolerating only "already gone" — the unit lives on
    // and its envId is the only pointer (the M18 Decision-4 discipline); a
    // crash between the writes is retried by the next sweep, which skips the
    // destroy when the env is already gone.
    const suspendResumed = async (wu: WorkUnit): Promise<void> => {
      if (wu.envId) {
        try {
          await this.deps.sandbox.destroyEnvironment(wu.envId);
        } catch (err) {
          if (!(err instanceof SandboxError && err.code === 'NOT_FOUND')) throw err;
        }
      }
      await this.workUnits.releaseEnv(wu.id);
      await this.machine.apply(wu.id, 'suspend');
      const conv = await this.deps.repos.conversations.get(wu.conversationId);
      await this.audit('session.suspended', {
        userId: conv?.userId,
        conversationId: wu.conversationId,
        workUnitId: wu.id,
        detail: { envId: wu.envId ?? null, reason: 'idle' },
      });
      // The notice states an accomplished fact, AFTER the suspension — a
      // destroy retried next sweep must not re-announce.
      await this.emit({
        type: 'post_actions',
        conversationId: wu.conversationId,
        text:
          'Work paused after inactivity — the environment was released; the PR stays ' +
          'open and merge/close updates continue.',
        actions: [{ actionId: 'resume-work', label: 'Resume work', style: 'primary' }],
      });
    };

    // The idle TTL reclaims the expensive part: for a resumed unit (the only
    // way a pre-PR state carries a prNumber) that is the environment, and the
    // unit itself is suspended back to waiting on its PR.
    const reapOrSuspend = async (wu: WorkUnit): Promise<void> => {
      if (wu.prNumber !== undefined) {
        await suspendResumed(wu);
        suspended += 1;
      } else {
        await reapIdle(wu);
        reaped += 1;
      }
    };

    if (policy.idleTtlMs !== undefined) {
      const ttl = policy.idleTtlMs;
      const warnMs = policy.idleWarnMs;
      for (const state of IDLE_REAP_STATES) {
        for (const wu of await this.workUnits.listByState(state)) {
          const alive = lastAliveMs(wu);
          const idleMs = nowMs - alive;
          try {
            if (warnMs === undefined) {
              if (idleMs < ttl) continue;
              await reapOrSuspend(wu);
              continue;
            }
            const warnedAtMs = wu.idleWarnedAt ? Date.parse(wu.idleWarnedAt) : undefined;
            const warnedThisPeriod = warnedAtMs !== undefined && warnedAtMs > alive;
            if (idleMs >= ttl && warnedThisPeriod && nowMs - warnedAtMs >= warnMs) {
              await reapOrSuspend(wu);
            } else if (idleMs >= ttl - warnMs && !warnedThisPeriod) {
              // Post first, mark second (m18-plan Decision 3): a failed post
              // retries next sweep unmarked; a failed mark re-warns once.
              await this.emit(
                messageCommand(
                  wu.conversationId,
                  wu.prNumber !== undefined
                    ? `This session has been idle and will be paused in about ` +
                        `${approxDuration(warnMs)} — its PR stays open; send a message ` +
                        `to keep working.`
                    : `This session has been idle and will be reclaimed in about ` +
                        `${approxDuration(warnMs)} — send a message to keep it.`,
                  this.registryFor(wu.conversationId),
                ),
              );
              await this.workUnits.markIdleWarned(wu.id);
              warned += 1;
            }
          } catch {
            failed += 1; // one bad unit never stops the sweep
          }
        }
      }
    }

    if (policy.prOpenEnvTtlMs !== undefined) {
      const ttl = policy.prOpenEnvTtlMs;
      for (const wu of await this.workUnits.listByState('PR_OPEN')) {
        if (!wu.envId) continue; // already released (or never provisioned)
        if (nowMs - lastAliveMs(wu) < ttl) continue;
        try {
          // Destroy strictly, tolerating only "already gone" (m18-plan
          // Decision 4): unlike teardown's best-effort swallow, a released
          // unit lives on and its envId is the only pointer the control
          // plane holds — clearing it past a swallowed transient failure
          // would leak the container with no retry.
          try {
            await this.deps.sandbox.destroyEnvironment(wu.envId);
          } catch (err) {
            if (!(err instanceof SandboxError && err.code === 'NOT_FOUND')) throw err;
          }
          await this.workUnits.releaseEnv(wu.id);
          const conv = await this.deps.repos.conversations.get(wu.conversationId);
          await this.audit('env.released', {
            userId: conv?.userId,
            conversationId: wu.conversationId,
            workUnitId: wu.id,
            detail: { envId: wu.envId, reason: 'idle' },
          });
          // The notice states an accomplished fact, AFTER the release — a
          // destroy retried next sweep must not re-announce. Since M19 it
          // carries the way back: the moment the env dies is the moment the
          // resume button becomes relevant.
          await this.emit({
            type: 'post_actions',
            conversationId: wu.conversationId,
            text:
              'Environment released while the PR is under review — merge/close updates ' +
              'continue; resume to keep working on it.',
            actions: [{ actionId: 'resume-work', label: 'Resume work', style: 'primary' }],
          });
          released += 1;
        } catch {
          failed += 1; // envId intact — the next sweep retries the destroy
        }
      }
    }

    if (policy.terminalGraceMs !== undefined) {
      const grace = policy.terminalGraceMs;
      for (const state of TERMINAL_REAP_STATES) {
        for (const wu of await this.workUnits.listByState(state)) {
          if (nowMs - lastAliveMs(wu) < grace) continue;
          try {
            await this.teardown(wu.conversationId, 'expired');
            reaped += 1;
          } catch {
            failed += 1;
          }
        }
      }
    }

    // Retention (M21): one uniform age horizon per table, enforced where the
    // elected sweep already runs. Strictly-older-than, so a row exactly at
    // the horizon survives one more sweep — the cheap side of the fence.
    if (policy.transcriptRetentionMs !== undefined) {
      try {
        prunedTranscripts += await this.deps.repos.transcripts.deleteBefore(
          new Date(nowMs - policy.transcriptRetentionMs).toISOString(),
        );
      } catch {
        failed += 1;
      }
    }
    if (policy.auditRetentionMs !== undefined) {
      try {
        prunedAudit += await this.deps.repos.audit.deleteBefore(
          new Date(nowMs - policy.auditRetentionMs).toISOString(),
        );
      } catch {
        failed += 1;
      }
    }
    return { reaped, warned, suspended, released, prunedTranscripts, prunedAudit, failed };
  }

  /* ---------------------------------------------------------------------- */

  private async requireWorkUnit(conversationId: string): Promise<WorkUnit> {
    const wu = await this.deps.repos.workUnits.getByConversation(conversationId);
    if (!wu) throw new OrchestratorError('NOT_FOUND', `no work unit for ${conversationId}`);
    return wu;
  }

  private async failWorkUnit(
    workUnitId: string,
    conversationId: string,
    err: unknown,
    registry: SecretRegistry,
  ): Promise<void> {
    try {
      const wu = await this.deps.repos.workUnits.get(workUnitId);
      if (wu && wu.state !== 'FAILED' && wu.state !== 'TORN_DOWN') {
        await this.machine.apply(workUnitId, 'error');
      }
    } catch (e) {
      if (!(e instanceof IllegalTransitionError)) throw e;
    }
    const message = err instanceof Error ? err.message : String(err);
    await this.emit(statusCommand(conversationId, 'FAILED', `Failed: ${message}`, registry));
  }
}
