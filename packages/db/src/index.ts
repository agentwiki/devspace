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
}

export interface ConversationRepo {
  create(input: Omit<ConversationRecord, 'id' | 'createdAt'>): Promise<ConversationRecord>;
  get(id: string): Promise<ConversationRecord | null>;
}

export interface WorkUnitRepo {
  create(input: Pick<WorkUnit, 'conversationId'> & Partial<WorkUnit>): Promise<WorkUnit>;
  get(id: string): Promise<WorkUnit | null>;
  /** Apply an FSM transition atomically; throws on an illegal transition. */
  transition(id: string, event: WorkEvent, patch?: Partial<WorkUnit>): Promise<WorkUnit>;
}

export interface SecretRepo {
  put(input: Omit<SecretRecord, 'id'>): Promise<SecretRecord>;
  get(userId: string, name: string, conversationId?: string): Promise<SecretRecord | null>;
}

export interface EventRepo {
  append(input: Omit<EventRecord, 'id' | 'emittedAt'>): Promise<EventRecord>;
  list(topic?: string): Promise<EventRecord[]>;
}

export interface Repositories {
  conversations: ConversationRepo;
  workUnits: WorkUnitRepo;
  secrets: SecretRepo;
  events: EventRepo;
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
export function createInMemoryRepositories(now: () => string = () => new Date(0).toISOString()): Repositories {
  const conversations = new Map<string, ConversationRecord>();
  const workUnits = new Map<string, WorkUnit>();
  const secrets = new Map<string, SecretRecord>();
  const events: EventRecord[] = [];

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
        const rec: SecretRecord = { id: id('sec'), ...input };
        secrets.set(`${input.userId}:${input.conversationId ?? ''}:${input.name}`, rec);
        return rec;
      },
      async get(userId, name, conversationId) {
        return secrets.get(`${userId}:${conversationId ?? ''}:${name}`) ?? null;
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
    },
  };
}
