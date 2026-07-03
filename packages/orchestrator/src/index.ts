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
import type { SandboxCore } from '@devspace/sandbox-core';
import type { AgentRunner } from '@devspace/agent-runner';
import { agentRuntimeMount } from '@devspace/agent-runner';
import { classifyAction, WorkUnitMachine } from './stateMachine.js';
import { SecretRegistry } from './secrets.js';
import type { SecretStore } from './secrets.js';
import { GitWrapper, prStateToEvent, type GitHubRestClient, type HostGitExec } from './git.js';
import { messageCommand, renderAgentEvent, statusCommand } from './render.js';
import { sameRepo, type MappedPrWebhook } from './webhooks.js';

export * from './stateMachine.js';
export * from './secrets.js';
export * from './git.js';
export * from './render.js';
export * from './webhooks.js';
export * from './internal-http.js';
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
      return created;
    }

    const branch = `devspace/${wu.id}`;
    try {
      const provisioning = await this.advance(wu, 'repoChoice', 'PROVISIONING', {
        repoUrl: choice.repoUrl,
        branch,
      });
      await this.emit(
        statusCommand(conv.id, 'PROVISIONING', 'Provisioning environment…', registry),
      );

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
  /* message.posted                                                          */
  /* ---------------------------------------------------------------------- */

  private async onMessagePosted(
    event: Extract<ChatEvent, { type: 'message.posted' }>,
  ): Promise<void> {
    await this.assertOwnership(event.conversationId, event.userId);
    const registry = this.registryFor(event.conversationId);
    const wu = await this.requireWorkUnit(event.conversationId);

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
      unit = await this.advance(unit, 'firstMessage', 'WORKING', { agentSessionId });
    }

    for await (const agentEvent of this.deps.agents.runTurn(agentSessionId, {
      prompt: event.text,
      attachments: [],
    })) {
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

  /* ---------------------------------------------------------------------- */
  /* Out-of-process bus events (PR poll reconciler) + reconciler driver       */
  /* ---------------------------------------------------------------------- */

  /** Handle a durable bus event. Idempotent against redelivery. */
  async handleBusEvent(evt: EventRecord): Promise<void> {
    if (evt.topic !== TOPIC_PR_MERGED && evt.topic !== TOPIC_PR_CLOSED) return;
    if (!evt.workUnitId) return;
    const wu = await this.workUnits.get(evt.workUnitId);
    if (!wu) return;
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
   */
  async teardown(conversationId: string): Promise<void> {
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
      detail: { envId: wu.envId ?? null },
    });
    await this.advance(wu, 'end', 'TORN_DOWN');
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
