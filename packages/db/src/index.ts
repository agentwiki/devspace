/**
 * @devspace/db
 *
 * Repository interfaces for the persistence layer plus an in-memory reference
 * implementation used by tests and local boot before Postgres is wired.
 *
 * The Postgres-backed implementation (Drizzle over `pg`, schema in schema.ts)
 * lands in M3; it will implement these same interfaces. The interfaces stay
 * free of any driver import so every service compiles offline — Drizzle needs
 * no native engine or runtime download (unlike Prisma; see ADR-0004).
 */
import type { WorkEvent, WorkState, WorkUnit } from '@devspace/contracts';
import { nextWorkState } from '@devspace/contracts';

export * from './schema.js';
export * from './bus.js';
export * from './pg.js';
export * from './migrate.js';

export interface ConversationRecord {
  id: string;
  platform: string;
  externalChannelId: string;
  userId: string;
  createdAt: string;
}

export interface SecretRecord {
  id: string;
  userId: string;
  conversationId?: string;
  name: string;
  ciphertext: string;
  keyId: string;
}

export interface EventRecord {
  id: string;
  topic: string;
  workUnitId?: string;
  payload: Record<string, unknown>;
  emittedAt: string;
  /** Stamped when a bus subscriber has processed the row (at-least-once). */
  consumedAt?: string;
}

export interface ConversationRepo {
  create(input: Omit<ConversationRecord, 'id' | 'createdAt'>): Promise<ConversationRecord>;
  get(id: string): Promise<ConversationRecord | null>;
  /** Point read on the (platform, externalChannelId) unique index — the
   * gateway's post-restart inbound cold-miss resolution (M4). */
  getByExternalChannelId(
    platform: string,
    externalChannelId: string,
  ): Promise<ConversationRecord | null>;
  /** A user's conversations on one platform — the App Home session-list read
   * (M6, the M4 deferral). Newest first. */
  listByUser(platform: string, userId: string): Promise<ConversationRecord[]>;
}

export interface WorkUnitRepo {
  create(input: Pick<WorkUnit, 'conversationId'> & Partial<WorkUnit>): Promise<WorkUnit>;
  get(id: string): Promise<WorkUnit | null>;
  /** The (single) work unit for a conversation — units are 1:1 with conversations. */
  getByConversation(conversationId: string): Promise<WorkUnit | null>;
  /** Units currently in a given state (the poll reconciler enumerates PR_OPEN). */
  listByState(state: WorkState): Promise<WorkUnit[]>;
  /** Apply an FSM transition atomically; throws on an illegal transition. */
  transition(id: string, event: WorkEvent, patch?: Partial<WorkUnit>): Promise<WorkUnit>;
}

export interface SecretRepo {
  put(input: Omit<SecretRecord, 'id'>): Promise<SecretRecord>;
  get(userId: string, name: string, conversationId?: string): Promise<SecretRecord | null>;
  /** Resolve a secret by its record id (llmKeyRef and friends are record ids). */
  getById(id: string): Promise<SecretRecord | null>;
  /** Delete a secret record by id; idempotent (missing id is a no-op). */
  delete(id: string): Promise<void>;
}

export interface EventRepo {
  append(input: Omit<EventRecord, 'id' | 'emittedAt' | 'consumedAt'>): Promise<EventRecord>;
  list(topic?: string): Promise<EventRecord[]>;
  /** Rows appended but not yet processed by a bus subscriber. */
  listUnconsumed(): Promise<EventRecord[]>;
  /** Mark a row processed. Idempotent. */
  markConsumed(id: string): Promise<void>;
}

/** One privileged operation, as recorded in the append-only audit trail (M5). */
export interface AuditRecord {
  id: string;
  at: string;
  userId?: string;
  conversationId?: string;
  workUnitId?: string;
  /** e.g. secret.resolved | approval.decided | pr.opened | teardown | webhook.received */
  action: string;
  /** Ids/names/enums only — never secret plaintext. */
  detail: Record<string, unknown>;
}

export interface AuditRepo {
  append(input: Omit<AuditRecord, 'id' | 'at'>): Promise<AuditRecord>;
  listByConversation(conversationId: string): Promise<AuditRecord[]>;
}

export interface Repositories {
  conversations: ConversationRepo;
  workUnits: WorkUnitRepo;
  secrets: SecretRepo;
  events: EventRepo;
  audit: AuditRepo;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly state: WorkState,
    public readonly event: WorkEvent,
  ) {
    super(`Illegal work-unit transition: ${state} --${event}-->`);
    this.name = 'IllegalTransitionError';
  }
}

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}

/** In-memory repositories. Deterministic ids; no clock dependency in ids. */
export function createInMemoryRepositories(
  now: () => string = () => new Date(0).toISOString(),
): Repositories {
  const conversations = new Map<string, ConversationRecord>();
  const workUnits = new Map<string, WorkUnit>();
  const secretsById = new Map<string, SecretRecord>();
  const secretIdByKey = new Map<string, string>();
  const events: EventRecord[] = [];
  const auditEntries: AuditRecord[] = [];

  const secretKey = (userId: string, conversationId: string | undefined, name: string): string =>
    `${userId}:${conversationId ?? ''}:${name}`;

  return {
    conversations: {
      async create(input) {
        const rec: ConversationRecord = { id: id('conv'), createdAt: now(), ...input };
        conversations.set(rec.id, rec);
        return rec;
      },
      async get(cid) {
        return conversations.get(cid) ?? null;
      },
      async getByExternalChannelId(platform, externalChannelId) {
        for (const rec of conversations.values()) {
          if (rec.platform === platform && rec.externalChannelId === externalChannelId) return rec;
        }
        return null;
      },
      async listByUser(platform, userId) {
        return [...conversations.values()]
          .filter((rec) => rec.platform === platform && rec.userId === userId)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      },
    },
    workUnits: {
      async create(input) {
        const ts = now();
        const wu: WorkUnit = {
          id: id('wu'),
          state: 'CREATED',
          createdAt: ts,
          updatedAt: ts,
          ...input,
        };
        workUnits.set(wu.id, wu);
        return wu;
      },
      async get(wid) {
        return workUnits.get(wid) ?? null;
      },
      async getByConversation(cid) {
        for (const wu of workUnits.values()) if (wu.conversationId === cid) return wu;
        return null;
      },
      async listByState(state) {
        return [...workUnits.values()].filter((wu) => wu.state === state);
      },
      async transition(wid, event, patch) {
        const wu = workUnits.get(wid);
        if (!wu) throw new Error(`work unit not found: ${wid}`);
        const next = nextWorkState(wu.state, event);
        if (next === null) throw new IllegalTransitionError(wu.state, event);
        const updated: WorkUnit = { ...wu, ...patch, state: next, updatedAt: now() };
        workUnits.set(wid, updated);
        return updated;
      },
    },
    secrets: {
      async put(input) {
        // Upsert on (userId, conversationId, name) — mirrors the Pg unique index
        // so a re-put rotates the ciphertext in place instead of orphaning a row.
        const key = secretKey(input.userId, input.conversationId, input.name);
        const existingId = secretIdByKey.get(key);
        const rec: SecretRecord = { id: existingId ?? id('sec'), ...input };
        secretsById.set(rec.id, rec);
        secretIdByKey.set(key, rec.id);
        return rec;
      },
      async get(userId, name, conversationId) {
        const sid = secretIdByKey.get(secretKey(userId, conversationId, name));
        return (sid && secretsById.get(sid)) || null;
      },
      async getById(sid) {
        return secretsById.get(sid) ?? null;
      },
      async delete(sid) {
        const rec = secretsById.get(sid);
        if (!rec) return;
        secretsById.delete(sid);
        secretIdByKey.delete(secretKey(rec.userId, rec.conversationId, rec.name));
      },
    },
    events: {
      async append(input) {
        const rec: EventRecord = { id: id('evt'), emittedAt: now(), ...input };
        events.push(rec);
        return rec;
      },
      async list(topic) {
        return topic ? events.filter((e) => e.topic === topic) : [...events];
      },
      async listUnconsumed() {
        return events.filter((e) => e.consumedAt === undefined);
      },
      async markConsumed(eid) {
        const rec = events.find((e) => e.id === eid);
        if (rec) rec.consumedAt = now();
      },
    },
    audit: {
      async append(input) {
        const rec: AuditRecord = { id: id('aud'), at: now(), ...input };
        auditEntries.push(rec);
        return rec;
      },
      async listByConversation(conversationId) {
        return auditEntries.filter((a) => a.conversationId === conversationId);
      },
    },
  };
}
