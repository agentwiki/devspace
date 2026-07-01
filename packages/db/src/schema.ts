/**
 * Drizzle schema — pure TypeScript, no native engine or runtime download.
 * This is the source of truth for the database; drizzle-kit generates SQL
 * migrations from it locally (offline-friendly, air-gap-friendly), which is
 * why we use Drizzle over Prisma for an on-prem product. See ADR-0004.
 */
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
  },
  (t) => [index('events_topic_idx').on(t.topic), index('events_work_unit_idx').on(t.workUnitId)],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type WorkUnitRow = typeof workUnits.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
export type EventRow = typeof events.$inferSelect;
