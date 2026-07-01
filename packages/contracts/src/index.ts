/**
 * @devspace/contracts
 *
 * Single source of truth for the cross-service contract surface:
 *  - Sandbox Core API (environment lifecycle, exec, fs, ports)
 *  - Agent Runner API (ACP-backed sessions) + normalized AgentEvent stream
 *  - Chat Gateway interfaces (inbound ChatEvent, outbound RenderCommand)
 *  - Orchestrator work-unit FSM (states + transitions)
 *  - Shared error envelope
 *
 * Everything is defined as a zod schema and the static type is inferred from it,
 * so the wire format and the TS type can never drift apart.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

export const EnvIdSchema = z.string().min(1).describe('Sandbox environment id');
export const ConversationIdSchema = z.string().min(1).describe('Chat conversation id');
export const WorkUnitIdSchema = z.string().min(1).describe('Work-unit id');
export const AgentSessionIdSchema = z.string().min(1).describe('Agent session id');
export const UserIdSchema = z.string().min(1).describe('Platform-agnostic user id');

export type EnvId = z.infer<typeof EnvIdSchema>;
export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type WorkUnitId = z.infer<typeof WorkUnitIdSchema>;
export type AgentSessionId = z.infer<typeof AgentSessionIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;

/* -------------------------------------------------------------------------- */
/* Shared error envelope                                                       */
/* -------------------------------------------------------------------------- */

export const ErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'PROVISION_FAILED',
  'EXEC_FAILED',
  'AGENT_FAILED',
  'GUARDRAIL_BLOCKED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* -------------------------------------------------------------------------- */
/* Sandbox Core: agent-agnostic primitives                                     */
/* -------------------------------------------------------------------------- */

export const ResourceLimitsSchema = z.object({
  cpu: z.number().positive().default(2),
  memMB: z.number().int().positive().default(4096),
  diskMB: z.number().int().positive().default(20480),
});
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

/** Generic mount — the core does not know an "agent runtime" from a cache volume. */
export const MountSpecSchema = z.object({
  source: z.string().min(1).describe('named volume or host path'),
  target: z.string().min(1).describe('absolute path inside the container'),
  ro: z.boolean().default(false),
});
export type MountSpec = z.infer<typeof MountSpecSchema>;

/** Generic secret injection — value resolved by the orchestrator, never logged. */
export const SecretSpecSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  target: z.enum(['env', 'file']).default('env'),
  /** required when target === 'file' */
  path: z.string().optional(),
});
export type SecretSpec = z.infer<typeof SecretSpecSchema>;

export const CreateEnvironmentRequestSchema = z.object({
  repoUrl: z.string().url().optional(),
  ref: z.string().optional(),
  /** inline devcontainer.json override merged over the repo's own */
  devcontainerOverride: z.record(z.unknown()).optional(),
  baseImage: z.string().optional(),
  resources: ResourceLimitsSchema.default({}),
  mounts: z.array(MountSpecSchema).default([]),
  secrets: z.array(SecretSpecSchema).default([]),
});
export type CreateEnvironmentRequest = z.infer<typeof CreateEnvironmentRequestSchema>;

export const EnvStatusSchema = z.enum(['provisioning', 'ready', 'stopping', 'stopped', 'failed']);
export type EnvStatus = z.infer<typeof EnvStatusSchema>;

export const PortMappingSchema = z.object({
  containerPort: z.number().int(),
  proxyUrl: z.string().url(),
  token: z.string(),
});
export type PortMapping = z.infer<typeof PortMappingSchema>;

export const EnvironmentSchema = z.object({
  envId: EnvIdSchema,
  status: EnvStatusSchema,
  containerId: z.string().optional(),
  ports: z.array(PortMappingSchema).default([]),
  createdAt: z.string().datetime(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ExecRequestSchema = z.object({
  cmd: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  tty: z.boolean().default(false),
  user: z.string().optional(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

/**
 * Frames carried over the full-duplex exec stream. stdout/stderr are kept
 * SEPARATE on purpose: ACP uses stdout for protocol and stderr for logs.
 * `data` is base64 so arbitrary bytes survive JSON transport.
 */
export const ExecFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stdin'), data: z.string().describe('base64') }),
  z.object({ kind: z.literal('stdout'), data: z.string().describe('base64') }),
  z.object({ kind: z.literal('stderr'), data: z.string().describe('base64') }),
  z.object({ kind: z.literal('exit'), code: z.number().int() }),
]);
export type ExecFrame = z.infer<typeof ExecFrameSchema>;

export const FsReadRequestSchema = z.object({ path: z.string() });
export const FsWriteRequestSchema = z.object({
  path: z.string(),
  data: z.string().describe('base64'),
  mode: z.number().int().optional(),
});
export const FsListRequestSchema = z.object({ path: z.string() });
export const FsEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number().int().nonnegative(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

/* -------------------------------------------------------------------------- */
/* Agent Runner: ACP-backed sessions + normalized event stream                 */
/* -------------------------------------------------------------------------- */

export const AgentKindSchema = z.enum(['codex']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const CreateAgentSessionRequestSchema = z.object({
  envId: EnvIdSchema,
  agentKind: AgentKindSchema.default('codex'),
  workspacePath: z.string().default('/workspace'),
  model: z.string().optional(),
  /** opaque reference resolved to a real key by the orchestrator's secret store */
  llmKeyRef: z.string(),
});
export type CreateAgentSessionRequest = z.infer<typeof CreateAgentSessionRequestSchema>;

export const TurnRequestSchema = z.object({
  prompt: z.string(),
  attachments: z
    .array(z.object({ name: z.string(), mime: z.string(), data: z.string().describe('base64') }))
    .default([]),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

/** Operations that may require a human approval gate. */
export const GuardedOpSchema = z.enum([
  'command_run',
  'file_write',
  'git_push',
  'pr_create',
  'network',
]);
export type GuardedOp = z.infer<typeof GuardedOpSchema>;

/**
 * The normalized agent event stream. Raw ACP (session/update JSON-RPC) is mapped
 * into these by the agent-runner so nothing upstream sees protocol specifics.
 */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thought'), text: z.string() }),
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), name: z.string(), args: z.record(z.unknown()) }),
  z.object({
    type: z.literal('tool_result'),
    name: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  z.object({ type: z.literal('file_edit'), path: z.string(), diff: z.string() }),
  z.object({
    type: z.literal('command_run'),
    cmd: z.string(),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('permission_request'),
    requestId: z.string(),
    op: GuardedOpSchema,
    details: z.string(),
  }),
  z.object({ type: z.literal('turn_end'), reason: z.enum(['completed', 'aborted', 'error']) }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const PermissionDecisionSchema = z.object({
  requestId: z.string(),
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session']).default('once'),
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/* -------------------------------------------------------------------------- */
/* Chat Gateway: inbound events + outbound render commands                     */
/* -------------------------------------------------------------------------- */

export const ChatPlatformSchema = z.enum(['discord', 'slack', 'web']);
export type ChatPlatform = z.infer<typeof ChatPlatformSchema>;

export const RepoChoiceSchema = z.object({
  repoUrl: z.string().url().optional(),
  ref: z.string().optional(),
  empty: z.boolean().default(false),
});
export type RepoChoice = z.infer<typeof RepoChoiceSchema>;

/** Inbound: platform adapter -> orchestrator (normalized). */
export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation.created'),
    platform: ChatPlatformSchema,
    externalChannelId: z.string(),
    userId: UserIdSchema,
    repoChoice: RepoChoiceSchema.optional(),
  }),
  z.object({
    type: z.literal('message.posted'),
    conversationId: ConversationIdSchema,
    userId: UserIdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal('action.invoked'),
    conversationId: ConversationIdSchema,
    userId: UserIdSchema,
    actionId: z.string().describe('stable id, e.g. "create-pr" | "view-pr" | "approve:<reqId>"'),
    payload: z.record(z.unknown()).default({}),
  }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

export const ActionButtonSchema = z.object({
  actionId: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'secondary', 'danger']).default('secondary'),
});
export type ActionButton = z.infer<typeof ActionButtonSchema>;

/** Outbound: orchestrator -> platform adapter (normalized). */
export const RenderCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('post_message'),
    conversationId: ConversationIdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal('update_status'),
    conversationId: ConversationIdSchema,
    state: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('post_actions'),
    conversationId: ConversationIdSchema,
    text: z.string(),
    actions: z.array(ActionButtonSchema),
  }),
  z.object({
    type: z.literal('stream_append'),
    conversationId: ConversationIdSchema,
    streamId: z.string(),
    chunk: z.string(),
  }),
]);
export type RenderCommand = z.infer<typeof RenderCommandSchema>;

/* -------------------------------------------------------------------------- */
/* Orchestrator: work-unit finite state machine                                */
/* -------------------------------------------------------------------------- */

export const WorkStateSchema = z.enum([
  'CREATED',
  'PROVISIONING',
  'READY',
  'WORKING',
  'PRE_PR',
  'PR_OPEN',
  'PR_MERGED',
  'PR_CLOSED',
  'FAILED',
  'TORN_DOWN',
]);
export type WorkState = z.infer<typeof WorkStateSchema>;

export const WorkEventSchema = z.enum([
  'repoChoice',
  'envReady',
  'firstMessage',
  'committedAndPushed',
  'prCreated',
  'prMerged',
  'prClosed',
  'error',
  'end',
]);
export type WorkEvent = z.infer<typeof WorkEventSchema>;

/**
 * Declarative transition table. The orchestrator is the only writer of work
 * state; this map is the canonical definition of legal transitions.
 */
export const WORK_TRANSITIONS: Readonly<Record<WorkState, Partial<Record<WorkEvent, WorkState>>>> =
  {
    CREATED: { repoChoice: 'PROVISIONING', error: 'FAILED', end: 'TORN_DOWN' },
    PROVISIONING: { envReady: 'READY', error: 'FAILED', end: 'TORN_DOWN' },
    READY: { firstMessage: 'WORKING', error: 'FAILED', end: 'TORN_DOWN' },
    WORKING: { committedAndPushed: 'PRE_PR', error: 'FAILED', end: 'TORN_DOWN' },
    PRE_PR: {
      prCreated: 'PR_OPEN',
      committedAndPushed: 'PRE_PR',
      error: 'FAILED',
      end: 'TORN_DOWN',
    },
    PR_OPEN: { prMerged: 'PR_MERGED', prClosed: 'PR_CLOSED', error: 'FAILED', end: 'TORN_DOWN' },
    PR_MERGED: { end: 'TORN_DOWN' },
    PR_CLOSED: { end: 'TORN_DOWN' },
    FAILED: { end: 'TORN_DOWN' },
    TORN_DOWN: {},
  };

/** Pure transition function: returns the next state or null if illegal. */
export function nextWorkState(state: WorkState, event: WorkEvent): WorkState | null {
  return WORK_TRANSITIONS[state][event] ?? null;
}

export const WorkUnitSchema = z.object({
  id: WorkUnitIdSchema,
  conversationId: ConversationIdSchema,
  envId: EnvIdSchema.optional(),
  agentSessionId: AgentSessionIdSchema.optional(),
  state: WorkStateSchema,
  repoUrl: z.string().url().optional(),
  branch: z.string().optional(),
  prNumber: z.number().int().optional(),
  prUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkUnit = z.infer<typeof WorkUnitSchema>;

/* -------------------------------------------------------------------------- */
/* Internal event bus envelope (orchestrator <- providers)                     */
/* -------------------------------------------------------------------------- */

export const BusEventSchema = z.object({
  id: z.string(),
  topic: z.string(),
  workUnitId: WorkUnitIdSchema.optional(),
  payload: z.record(z.unknown()),
  emittedAt: z.string().datetime(),
});
export type BusEvent = z.infer<typeof BusEventSchema>;
