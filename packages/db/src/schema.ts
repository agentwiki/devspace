/**
 * Drizzle schema — pure TypeScript, no native engine or runtime download.
 * This is the source of truth for the database; drizzle-kit generates SQL
 * migrations from it locally (offline-friendly, air-gap-friendly), which is
 * why we use Drizzle over Prisma for an on-prem product. See ADR-0004.
 */
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey().notNull(),
    platform: text('platform').notNull(), // slack | discord
    externalChannelId: text('external_channel_id').notNull(),
    userId: text('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('conversations_platform_channel_uq').on(t.platform, t.externalChannelId)],
);

// One unit of work per conversation, tracked through the GitHub work cycle.
// The orchestrator is the only writer of `state`.
export const workUnits = pgTable(
  'work_units',
  {
    id: text('id').primaryKey().notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    envId: text('env_id'),
    agentSessionId: text('agent_session_id'),
    // WorkState from @devspace/contracts, stored as text for forward-compat.
    state: text('state').notNull().default('CREATED'),
    repoUrl: text('repo_url'),
    branch: text('branch'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Last tenant-driven chat event (M17). Nullable: pre-M17 rows never
    // touched; the idle clock falls back to updatedAt. Written only by
    // WorkUnitRepo.touch — transitions keep owning updatedAt.
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    // Last idle-reap warning (M18). Written only by WorkUnitRepo.markIdleWarned
    // and never cleared — stale iff it predates max(lastActivityAt, updatedAt).
    idleWarnedAt: timestamp('idle_warned_at', { withTimezone: true }),
    // The tenant's egress policy (M22), written at repo choice so the M19
    // resume re-provision carries it — a resume must never silently widen
    // egress. Nullable: pre-M22 rows and host-default units carry nothing.
    networkAccess: text('network_access'),
    allowedHosts: jsonb('allowed_hosts'),
    // The tenant's env vars + setup script (M24), written at repo choice like
    // the egress policy above — the resume re-provision must rebuild the SAME
    // environment, env and setup included. Non-secret by contract (m24-plan
    // Decision 2: values are visible in the container config anyway; anything
    // sensitive belongs in the envelope-encrypted secrets table). Nullable.
    tenantEnv: jsonb('tenant_env'),
    setupScript: text('setup_script'),
  },
  (t) => [
    index('work_units_conversation_idx').on(t.conversationId),
    index('work_units_state_idx').on(t.state),
  ],
);

// Per-user / per-conversation secrets (GitHub token, LLM key). Ciphertext only.
export const secrets = pgTable(
  'secrets',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id').notNull(),
    conversationId: text('conversation_id'),
    name: text('name').notNull(), // e.g. GITHUB_TOKEN, LLM_KEY
    ciphertext: text('ciphertext').notNull(), // envelope-encrypted; plaintext never stored/logged
    keyId: text('key_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('secrets_user_conv_name_uq').on(t.userId, t.conversationId, t.name)],
);

// Durable event log + LISTEN/NOTIFY backing table (MVP event bus).
export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey().notNull(),
    topic: text('topic').notNull(),
    workUnitId: text('work_unit_id'),
    payload: jsonb('payload').notNull(),
    emittedAt: timestamp('emitted_at', { withTimezone: true }).defaultNow().notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    // Claim lease (M14): which controller instance is processing this row.
    // Diagnostics + race arbitration only — the TTL, not the name, decides
    // reclaimability (m14-plan Decision 3).
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
  },
  (t) => [index('events_topic_idx').on(t.topic), index('events_work_unit_idx').on(t.workUnitId)],
);

// Advisory role leases (M15): one row per named singleton role (e.g. the PR
// poll reconciler). `acquire` is a single upsert arbitrated in database time;
// a lease renewed longer ago than the caller's TTL is expired and re-grantable.
// Advisory only — correctness never depends on holding one (m15-plan
// Decision 2).
export const leases = pgTable('leases', {
  name: text('name').primaryKey().notNull(),
  holder: text('holder').notNull(),
  // When the current holder first took the role (tenure, for diagnostics).
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).defaultNow().notNull(),
  // Last renewal; older than the TTL = expired.
  renewedAt: timestamp('renewed_at', { withTimezone: true }).defaultNow().notNull(),
});

// Append-only audit trail of privileged operations (M5). One writer (the
// orchestrator); detail payloads are built from ids/names/enums only — never
// secret plaintext — so the log needs no redaction pass.
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey().notNull(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    userId: text('user_id'),
    conversationId: text('conversation_id'),
    workUnitId: text('work_unit_id'),
    action: text('action').notNull(), // e.g. secret.resolved, pr.opened
    detail: jsonb('detail').notNull(),
  },
  (t) => [
    index('audit_log_conversation_idx').on(t.conversationId),
    index('audit_log_action_idx').on(t.action),
  ],
);

// Durable per-conversation transcript (M20): the conversation-visible turns —
// tenant prompts and coalesced agent replies — REDACTED at write time (the
// orchestrator passes text through the conversation's registry before it
// lands, m20-plan Decision 3). Append-only like audit_log; rows survive
// teardown. `seq` owns the total order — created_at collides inside a burst.
export const transcripts = pgTable(
  'transcripts',
  {
    id: text('id').primaryKey().notNull(),
    conversationId: text('conversation_id').notNull(),
    workUnitId: text('work_unit_id'),
    role: text('role').notNull(), // user | agent
    text: text('text').notNull(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('transcripts_conversation_seq_idx').on(t.conversationId, t.seq)],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type WorkUnitRow = typeof workUnits.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type LeaseRow = typeof leases.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
