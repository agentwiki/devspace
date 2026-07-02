import { describe, expect, it, vi } from 'vitest';
import { BindingError, ConversationBinding, decodeRef, encodeRef } from './binding.js';

describe('encodeRef / decodeRef', () => {
  it('round-trips a ref whose threadTs contains a dot', () => {
    const ref = { channel: 'C0123ABC', threadTs: '1712345678.000200' };
    expect(decodeRef(encodeRef(ref))).toEqual(ref);
    expect(encodeRef(ref)).toBe('C0123ABC:1712345678.000200');
  });

  it('splits on the first colon only', () => {
    // threadTs may never legitimately contain ':', but decode must still be
    // deterministic if one sneaks in — everything after the first ':' is ts.
    expect(decodeRef('C1:1.2:3')).toEqual({ channel: 'C1', threadTs: '1.2:3' });
  });

  it('rejects a channel containing the separator (keeps decode unambiguous)', () => {
    expect(() => encodeRef({ channel: 'C:1', threadTs: '1.2' })).toThrow(BindingError);
  });

  it('rejects empty parts on both encode and decode', () => {
    expect(() => encodeRef({ channel: '', threadTs: '1.2' })).toThrow(BindingError);
    expect(() => encodeRef({ channel: 'C1', threadTs: '' })).toThrow(BindingError);
    expect(() => decodeRef('no-separator')).toThrow(BindingError);
    expect(() => decodeRef(':1.2')).toThrow(BindingError);
    expect(() => decodeRef('C1:')).toThrow(BindingError);
  });
});

describe('ConversationBinding', () => {
  const ref = { channel: 'C1', threadTs: '1.000100' };

  it('serves both directions after bind', async () => {
    const binding = new ConversationBinding();
    binding.bind('conv-1', ref);
    expect(binding.refFor('conv-1')).toEqual(ref);
    await expect(binding.conversationFor(ref)).resolves.toBe('conv-1');
  });

  it('outbound lookup is cache-only: unbound conversation → undefined', () => {
    expect(new ConversationBinding().refFor('conv-x')).toBeUndefined();
  });

  it('inbound miss without a resolver → null', async () => {
    await expect(new ConversationBinding().conversationFor(ref)).resolves.toBeNull();
  });

  it('cold miss invokes resolveMiss once, then serves from cache (both directions)', async () => {
    const resolveMiss = vi.fn(async () => 'conv-cold');
    const binding = new ConversationBinding({ conversation: resolveMiss });

    await expect(binding.conversationFor(ref)).resolves.toBe('conv-cold');
    await expect(binding.conversationFor(ref)).resolves.toBe('conv-cold');
    expect(resolveMiss).toHaveBeenCalledTimes(1);
    expect(resolveMiss).toHaveBeenCalledWith('C1:1.000100');
    // A successful inbound resolution also warms the outbound direction.
    expect(binding.refFor('conv-cold')).toEqual(ref);
  });

  it('concurrent cold misses are de-duplicated to one resolver call', async () => {
    let release!: (v: string | null) => void;
    const resolveMiss = vi.fn(() => new Promise<string | null>((r) => (release = r)));
    const binding = new ConversationBinding({ conversation: resolveMiss });

    const [a, b] = [binding.conversationFor(ref), binding.conversationFor(ref)];
    release('conv-dedup');
    await expect(Promise.all([a, b])).resolves.toEqual(['conv-dedup', 'conv-dedup']);
    expect(resolveMiss).toHaveBeenCalledTimes(1);
  });

  it('refForAsync resolves an outbound cold miss once and warms both directions', async () => {
    const resolveRef = vi.fn(async () => 'C1:1.000100');
    const binding = new ConversationBinding({ ref: resolveRef });

    await expect(binding.refForAsync('conv-out')).resolves.toEqual(ref);
    await expect(binding.refForAsync('conv-out')).resolves.toEqual(ref);
    expect(resolveRef).toHaveBeenCalledTimes(1);
    expect(resolveRef).toHaveBeenCalledWith('conv-out');
    await expect(binding.conversationFor(ref)).resolves.toBe('conv-out');
  });

  it('refForAsync without a resolver (or on a negative) → undefined', async () => {
    await expect(new ConversationBinding().refForAsync('conv-x')).resolves.toBeUndefined();
    const binding = new ConversationBinding({ ref: async () => null });
    await expect(binding.refForAsync('conv-x')).resolves.toBeUndefined();
  });

  it('does not memoize a negative resolution (a later bind is not masked)', async () => {
    const resolveMiss = vi.fn(async () => null);
    const binding = new ConversationBinding({ conversation: resolveMiss });

    await expect(binding.conversationFor(ref)).resolves.toBeNull();
    await expect(binding.conversationFor(ref)).resolves.toBeNull();
    expect(resolveMiss).toHaveBeenCalledTimes(2);

    binding.bind('conv-late', ref);
    await expect(binding.conversationFor(ref)).resolves.toBe('conv-late');
    expect(resolveMiss).toHaveBeenCalledTimes(2); // cache hit, no third call
  });
});
