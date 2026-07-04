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
  /** Which controller instance holds (or last held) the claim lease (M14). */
  claimedBy?: string;
  /** When the lease was taken; older than the TTL = reclaimable. */
  claimedAt?: string;
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
  /**
   * Record tenant activity (M17): bump `lastActivityAt` and nothing else —
   * `updatedAt` stays owned by `transition`. A missing id is a no-op; the
   * lifecycle reaper measures idleness against max(lastActivityAt, updatedAt).
   */
  touch(id: string): Promise<void>;
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
  /**
   * Take the claim lease on an unconsumed row (M14, m14-plan Decision 2):
   * atomically stamp `claimedBy`/`claimedAt` and return the row — or null
   * when the row is consumed, missing, or held by a lease younger than
   * `ttlMs`. One winner per lease window across any number of processes.
   */
  claim(id: string, owner: string, ttlMs: number): Promise<EventRecord | null>;
  /** Mark a row processed. Idempotent. */
  markConsumed(id: string): Promise<void>;
}

/** One named advisory role lease (M15) — e.g. the PR poll reconciler. */
export interface LeaseRecord {
  name: string;
  holder: string;
  /** When the current holder first took the role (tenure — diagnostics). */
  acquiredAt: string;
  /** Last renewal; older than the caller's TTL = expired, re-grantable. */
  renewedAt: string;
}

export interface LeaseRepo {
  /**
   * Take (or renew) the named lease: granted iff it is free, expired
   * (renewed longer ago than `ttlMs`), or already held by `owner` — a
   * re-acquire renews without resetting tenure. One atomic statement
   * decides every case (m15-plan Decision 1); arbitration happens in
   * database time, like the M14 event claim.
   */
  acquire(name: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Give the lease up iff currently held by `owner`. Idempotent. */
  release(name: string, owner: string): Promise<void>;
  /** Read the lease row — who holds/held the role (diagnostics/tests). */
  get(name: string): Promise<LeaseRecord | null>;
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
  leases: LeaseRepo;
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
  const leaseRows = new Map<string, LeaseRecord>();
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
      async touch(wid) {
        const wu = workUnits.get(wid);
        if (wu) workUnits.set(wid, { ...wu, lastActivityAt: now() });
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
      async claim(eid, owner, ttlMs) {
        const rec = events.find((e) => e.id === eid);
        if (!rec || rec.consumedAt !== undefined) return null;
        const ts = now();
        // Same arbitration as Pg: a live lease (younger than the TTL) loses.
        if (rec.claimedAt !== undefined && !(Date.parse(rec.claimedAt) < Date.parse(ts) - ttlMs)) {
          return null;
        }
        rec.claimedBy = owner;
        rec.claimedAt = ts;
        return rec;
      },
      async markConsumed(eid) {
        const rec = events.find((e) => e.id === eid);
        if (rec) rec.consumedAt = now();
      },
    },
    leases: {
      async acquire(name, owner, ttlMs) {
        const rec = leaseRows.get(name);
        const ts = now();
        if (rec && rec.holder === owner) {
          rec.renewedAt = ts; // renewal preserves tenure (acquiredAt)
          return true;
        }
        // Same expiry arbitration as events.claim: a live foreign lease wins.
        if (rec && !(Date.parse(rec.renewedAt) < Date.parse(ts) - ttlMs)) {
          return false;
        }
        leaseRows.set(name, { name, holder: owner, acquiredAt: ts, renewedAt: ts });
        return true;
      },
      async release(name, owner) {
        if (leaseRows.get(name)?.holder === owner) leaseRows.delete(name);
      },
      async get(name) {
        return leaseRows.get(name) ?? null;
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
