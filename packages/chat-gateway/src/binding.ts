/**
 * conversationId ↔ Slack-thread binding (m4-plan Decision 1, workstream A).
 *
 * `RenderCommand`s carry only the internal `conversationId`; Slack needs
 * `channel` + `thread_ts`. The join key is the reversible
 * `externalChannelId = "<channel>:<threadTs>"` that already backs the
 * `(platform, external_channel_id)` unique index.
 *
 * The cache is warm-on-inbound: every inbound event binds its thread before
 * any render it triggers, so the outbound lookup (`refFor`) never needs a
 * reverse DB read. The only DB read is the post-restart inbound cold miss,
 * resolved once through the injected `resolveMiss` hook and then memoized.
 */

/** A Slack thread address: channel id + the root message's thread_ts. */
export interface ThreadRef {
  channel: string;
  threadTs: string;
}

export class BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingError';
  }
}

/**
 * `ThreadRef → externalChannelId`. Total and round-trippable: a Slack channel
 * id never contains `:` (enforced here so decode stays unambiguous), while
 * `threadTs` contains a `.` — which is why `:` is the separator.
 */
export function encodeRef(ref: ThreadRef): string {
  if (!ref.channel || ref.channel.includes(':')) {
    throw new BindingError(`invalid channel: ${JSON.stringify(ref.channel)}`);
  }
  if (!ref.threadTs) throw new BindingError('empty threadTs');
  return `${ref.channel}:${ref.threadTs}`;
}

/** `externalChannelId → ThreadRef`. Splits on the FIRST `:` only. */
export function decodeRef(externalChannelId: string): ThreadRef {
  const sep = externalChannelId.indexOf(':');
  if (sep <= 0 || sep === externalChannelId.length - 1) {
    throw new BindingError(`not a <channel>:<threadTs> ref: ${JSON.stringify(externalChannelId)}`);
  }
  return { channel: externalChannelId.slice(0, sep), threadTs: externalChannelId.slice(sep + 1) };
}

/** Resolve an inbound cold miss (post-restart): externalChannelId → conversationId. */
export type ResolveMiss = (externalChannelId: string) => Promise<string | null>;

/** Post-restart cold-miss resolvers, both directions. Inbound covers new
 * messages in a pre-restart thread; outbound covers renders that arrive with
 * no prior inbound event (the PR poll reconciler's status updates). */
export interface BindingResolvers {
  /** externalChannelId → conversationId */
  conversation?: ResolveMiss;
  /** conversationId → externalChannelId */
  ref?: (conversationId: string) => Promise<string | null>;
}

/**
 * Bidirectional in-memory cache. `bind` is called on every inbound event
 * (idempotent), `refFor`/`refForAsync` serve the render path, and
 * `conversationFor` resolves inbound lookups — consulting the resolver
 * exactly once per key on a cache miss (concurrent misses are de-duplicated;
 * a successful resolution is memoized, a `null` is not, so a thread that
 * becomes a conversation later is not masked by a stale negative).
 */
export class ConversationBinding {
  private readonly refByConversation = new Map<string, ThreadRef>();
  private readonly conversationByRef = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly resolvers: BindingResolvers = {}) {}

  bind(conversationId: string, ref: ThreadRef): void {
    const key = encodeRef(ref);
    this.refByConversation.set(conversationId, { ...ref });
    this.conversationByRef.set(key, conversationId);
  }

  /** Outbound: conversationId → thread address. Sync — cache only. */
  refFor(conversationId: string): ThreadRef | undefined {
    return this.refByConversation.get(conversationId);
  }

  /** Outbound with cold-miss resolution (reconciler renders after a restart). */
  async refForAsync(conversationId: string): Promise<ThreadRef | undefined> {
    const hit = this.refByConversation.get(conversationId);
    if (hit) return hit;
    const resolve = this.resolvers.ref;
    if (!resolve) return undefined;

    const key = `ref:${conversationId}`;
    const lookup =
      this.inFlight.get(key) ??
      resolve(conversationId)
        .then((externalChannelId) => {
          if (externalChannelId !== null) this.bind(conversationId, decodeRef(externalChannelId));
          return externalChannelId;
        })
        .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    await lookup;
    return this.refByConversation.get(conversationId);
  }

  /** Inbound: thread address → conversationId, with memoized cold-miss resolution. */
  async conversationFor(ref: ThreadRef): Promise<string | null> {
    const key = encodeRef(ref);
    const hit = this.conversationByRef.get(key);
    if (hit !== undefined) return hit;
    const resolve = this.resolvers.conversation;
    if (!resolve) return null;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const lookup = resolve(key)
      .then((conversationId) => {
        if (conversationId !== null) this.bind(conversationId, ref);
        return conversationId;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    return lookup;
  }
}
