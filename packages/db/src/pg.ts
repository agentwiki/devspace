/**
 * Postgres-backed `Repositories`, Drizzle over `node-postgres`. Behaviourally
 * identical to `createInMemoryRepositories` — same method contracts, same
 * illegal-transition semantics — so unit tests (in-memory) and the Pg
 * integration tests exercise one shared behaviour.
 *
 * The load-bearing method is `workUnits.transition`: `SELECT … FOR UPDATE` then
 * recompute. The row is locked and re-read inside the transaction, so a
 * lost-update race is resolved by the loser recomputing against the committed
 * state — it can never be misreported as an illegal transition.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { WorkUnit } from '@devspace/contracts';
import { nextWorkState } from '@devspace/contracts';
import {
  IllegalTransitionError,
  type AuditRecord,
  type ConversationRecord,
  type EventRecord,
  type Repositories,
  type SecretRecord,
} from './index.js';
import { auditLog, conversations, events, secrets, workUnits } from './schema.js';
import type { AuditRow, ConversationRow, EventRow, SecretRow, WorkUnitRow } from './schema.js';

const iso = (d: Date): string => d.toISOString();
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function mapConversation(r: ConversationRow): ConversationRecord {
  return {
    id: r.id,
    platform: r.platform,
    externalChannelId: r.externalChannelId,
    userId: r.userId,
    createdAt: iso(r.createdAt),
  };
}

function mapWorkUnit(r: WorkUnitRow): WorkUnit {
  return {
    id: r.id,
    conversationId: r.conversationId,
    envId: opt(r.envId),
    agentSessionId: opt(r.agentSessionId),
    state: r.state as WorkUnit['state'],
    repoUrl: opt(r.repoUrl),
    branch: opt(r.branch),
    prNumber: opt(r.prNumber),
    prUrl: opt(r.prUrl),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function mapSecret(r: SecretRow): SecretRecord {
  return {
    id: r.id,
    userId: r.userId,
    conversationId: opt(r.conversationId),
    name: r.name,
    ciphertext: r.ciphertext,
    keyId: r.keyId,
  };
}

function mapAudit(r: AuditRow): AuditRecord {
  return {
    id: r.id,
    at: iso(r.at),
    userId: opt(r.userId),
    conversationId: opt(r.conversationId),
    workUnitId: opt(r.workUnitId),
    action: r.action,
    detail: r.detail as Record<string, unknown>,
  };
}

function mapEvent(r: EventRow): EventRecord {
  return {
    id: r.id,
    topic: r.topic,
    workUnitId: opt(r.workUnitId),
    payload: r.payload as Record<string, unknown>,
    emittedAt: iso(r.emittedAt),
    consumedAt: r.consumedAt ? iso(r.consumedAt) : undefined,
  };
}

/** Only the columns a transition/create is allowed to touch (never id/state). */
function workUnitPatchColumns(patch: Partial<WorkUnit>): Partial<typeof workUnits.$inferInsert> {
  const set: Partial<typeof workUnits.$inferInsert> = {};
  if (patch.conversationId !== undefined) set.conversationId = patch.conversationId;
  if (patch.envId !== undefined) set.envId = patch.envId;
  if (patch.agentSessionId !== undefined) set.agentSessionId = patch.agentSessionId;
  if (patch.repoUrl !== undefined) set.repoUrl = patch.repoUrl;
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (patch.prNumber !== undefined) set.prNumber = patch.prNumber;
  if (patch.prUrl !== undefined) set.prUrl = patch.prUrl;
  return set;
}

export function createPostgresRepositories(pool: Pool): Repositories {
  const db = drizzle(pool);

  return {
    conversations: {
      async create(input) {
        const [row] = await db
          .insert(conversations)
          .values({
            id: `conv_${randomUUID()}`,
            platform: input.platform,
            externalChannelId: input.externalChannelId,
            userId: input.userId,
          })
          .returning();
        return mapConversation(row!);
      },
      async get(id) {
        const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
        return row ? mapConversation(row) : null;
      },
      async getByExternalChannelId(platform, externalChannelId) {
        const [row] = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.platform, platform),
              eq(conversations.externalChannelId, externalChannelId),
            ),
          );
        return row ? mapConversation(row) : null;
      },
    },

    workUnits: {
      async create(input) {
        const [row] = await db
          .insert(workUnits)
          .values({
            id: `wu_${randomUUID()}`,
            state: input.state ?? 'CREATED',
            ...workUnitPatchColumns(input),
            conversationId: input.conversationId,
          })
          .returning();
        return mapWorkUnit(row!);
      },
      async get(id) {
        const [row] = await db.select().from(workUnits).where(eq(workUnits.id, id));
        return row ? mapWorkUnit(row) : null;
      },
      async getByConversation(conversationId) {
        const [row] = await db
          .select()
          .from(workUnits)
          .where(eq(workUnits.conversationId, conversationId));
        return row ? mapWorkUnit(row) : null;
      },
      async listByState(state) {
        const rows = await db.select().from(workUnits).where(eq(workUnits.state, state));
        return rows.map(mapWorkUnit);
      },
      async transition(id, event, patch) {
        return db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(workUnits)
            .where(eq(workUnits.id, id))
            .for('update');
          if (!current) throw new Error(`work unit not found: ${id}`);
          const next = nextWorkState(current.state as WorkUnit['state'], event);
          if (next === null) {
            throw new IllegalTransitionError(current.state as WorkUnit['state'], event);
          }
          const [row] = await tx
            .update(workUnits)
            .set({ ...workUnitPatchColumns(patch ?? {}), state: next, updatedAt: new Date() })
            .where(eq(workUnits.id, id))
            .returning();
          return mapWorkUnit(row!);
        });
      },
    },

    secrets: {
      async put(input) {
        const [row] = await db
          .insert(secrets)
          .values({
            id: `sec_${randomUUID()}`,
            userId: input.userId,
            conversationId: input.conversationId,
            name: input.name,
            ciphertext: input.ciphertext,
            keyId: input.keyId,
          })
          .onConflictDoUpdate({
            target: [secrets.userId, secrets.conversationId, secrets.name],
            set: { ciphertext: input.ciphertext, keyId: input.keyId },
          })
          .returning();
        return mapSecret(row!);
      },
      async get(userId, name, conversationId) {
        const [row] = await db
          .select()
          .from(secrets)
          .where(
            and(
              eq(secrets.userId, userId),
              eq(secrets.name, name),
              conversationId === undefined
                ? isNull(secrets.conversationId)
                : eq(secrets.conversationId, conversationId),
            ),
          );
        return row ? mapSecret(row) : null;
      },
      async getById(id) {
        const [row] = await db.select().from(secrets).where(eq(secrets.id, id));
        return row ? mapSecret(row) : null;
      },
      async delete(id) {
        await db.delete(secrets).where(eq(secrets.id, id));
      },
    },

    events: {
      async append(input) {
        const [row] = await db
          .insert(events)
          .values({
            id: `evt_${randomUUID()}`,
            topic: input.topic,
            workUnitId: input.workUnitId,
            payload: input.payload,
          })
          .returning();
        return mapEvent(row!);
      },
      async list(topic) {
        const rows = topic
          ? await db.select().from(events).where(eq(events.topic, topic))
          : await db.select().from(events);
        return rows.map(mapEvent);
      },
      async listUnconsumed() {
        const rows = await db.select().from(events).where(isNull(events.consumedAt));
        return rows.map(mapEvent);
      },
      async markConsumed(id) {
        await db
          .update(events)
          .set({ consumedAt: new Date() })
          .where(and(eq(events.id, id), isNull(events.consumedAt)));
      },
    },

    audit: {
      async append(input) {
        const [row] = await db
          .insert(auditLog)
          .values({
            id: `aud_${randomUUID()}`,
            userId: input.userId,
            conversationId: input.conversationId,
            workUnitId: input.workUnitId,
            action: input.action,
            detail: input.detail,
          })
          .returning();
        return mapAudit(row!);
      },
      async listByConversation(conversationId) {
        const rows = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.conversationId, conversationId))
          .orderBy(auditLog.at);
        return rows.map(mapAudit);
      },
    },
  };
}
