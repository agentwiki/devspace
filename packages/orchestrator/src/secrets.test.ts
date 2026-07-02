import { describe, expect, it } from 'vitest';
import { createInMemoryRepositories } from '@devspace/db';
import {
  generateKeyEntry,
  parseKeyring,
  redactSecrets,
  SecretError,
  SecretRegistry,
  SecretStore,
} from './secrets.js';

const K1 = generateKeyEntry('k1');
const K2 = generateKeyEntry('k2');

describe('SecretStore', () => {
  it('round-trips encrypt → decrypt by ref', async () => {
    const repos = createInMemoryRepositories();
    const store = new SecretStore(repos.secrets, parseKeyring(K1));
    const rec = await store.put('u1', 'c1', 'LLM_KEY', 'sk-super-secret');
    // Ciphertext at rest is never the plaintext.
    expect(rec.ciphertext).not.toContain('sk-super-secret');
    expect(await store.resolveRef(rec.id)).toBe('sk-super-secret');
    expect(await store.resolve('u1', 'LLM_KEY', 'c1')).toBe('sk-super-secret');
  });

  it('decrypts across two active key versions and rotates to current', async () => {
    const repos = createInMemoryRepositories();
    // Sealed under k1 (now retired); current write key is k2.
    const legacy = new SecretStore(repos.secrets, parseKeyring(K1));
    const rec = await legacy.put('u1', 'c1', 'GH_TOKEN', 'ghp_oldkey');

    const store = new SecretStore(repos.secrets, parseKeyring(K2, [K1]));
    // Still decryptable via the retired key recorded in the envelope.
    expect(await store.resolveRef(rec.id)).toBe('ghp_oldkey');

    const rotated = await store.rotate(rec.id);
    expect(rotated.keyId).toBe('k2');
    expect(await store.resolveRef(rotated.id)).toBe('ghp_oldkey');

    // After rotation the value survives even if k1 is dropped entirely.
    const currentOnly = new SecretStore(repos.secrets, parseKeyring(K2));
    expect(await currentOnly.resolveRef(rotated.id)).toBe('ghp_oldkey');
  });

  it('rejects tampered ciphertext', async () => {
    const repos = createInMemoryRepositories();
    const store = new SecretStore(repos.secrets, parseKeyring(K1));
    const rec = await store.put('u1', 'c1', 'X', 'plaintext-value');
    // Flip a byte in the ciphertext segment.
    const parts = rec.ciphertext.split('.');
    const ctBuf = Buffer.from(parts[2]!, 'base64');
    ctBuf[0] ^= 0xff;
    parts[2] = ctBuf.toString('base64');
    await repos.secrets.put({ ...rec, ciphertext: parts.join('.') });
    await expect(store.resolveRef(rec.id)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('rejects decrypt under a mismatched owner (AAD binding)', async () => {
    const repos = createInMemoryRepositories();
    const store = new SecretStore(repos.secrets, parseKeyring(K1));
    const rec = await store.put('u1', 'c1', 'X', 'plaintext-value');
    // Same ciphertext, but the record now claims a different owner → AAD fails.
    await repos.secrets.put({ ...rec, userId: 'attacker' });
    await expect(store.resolveRef(rec.id)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('throws NOT_FOUND for an unknown ref and UNKNOWN_KEY for a missing keyId', async () => {
    const repos = createInMemoryRepositories();
    const store = new SecretStore(repos.secrets, parseKeyring(K2));
    await expect(store.resolveRef('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Record sealed under k1, but the store only knows k2.
    const legacy = new SecretStore(repos.secrets, parseKeyring(K1));
    const rec = await legacy.put('u1', 'c1', 'X', 'v');
    await expect(store.resolveRef(rec.id)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
  });
});

describe('parseKeyring', () => {
  it('rejects malformed and wrong-length keys', () => {
    expect(() => parseKeyring('noseparator')).toThrow(SecretError);
    expect(() => parseKeyring('k1:' + Buffer.from('short').toString('base64'))).toThrow(
      SecretError,
    );
  });
});

describe('SecretRegistry / redactSecrets', () => {
  it('scrubs registered plaintext and ignores trivially short values', () => {
    const reg = new SecretRegistry();
    reg.register('ghp_a_real_token_value');
    reg.register('short'); // < 6 chars → not registered
    expect(reg.size).toBe(1);
    const out = redactSecrets('token=ghp_a_real_token_value done short', reg);
    expect(out).toBe('token=«redacted» done short');
  });

  it('redacts longest-first so overlapping secrets are fully scrubbed', () => {
    const reg = new SecretRegistry();
    reg.register('abcdef');
    reg.register('abcdef-ghijkl');
    expect(redactSecrets('x abcdef-ghijkl y', reg)).toBe('x «redacted» y');
  });

  it('scrubs well-known token shapes even when never registered (M5)', () => {
    const reg = new SecretRegistry(); // empty — nothing was resolved
    const cases = [
      'pat ghp_ABCDEFGHIJKLMNOPQRST123456 end',
      'fine github_pat_11ABCDEFG0123456789_abcdefghij end',
      'oauth gho_ABCDEFGHIJKLMNOPQRST123456 end',
      'app ghs_ABCDEFGHIJKLMNOPQRST123456 end',
      'llm sk-proj-ABCDEFGHIJKLMNOPQRSTUV end',
      'slack xoxb-1234567890-abcdefghij end',
    ];
    for (const text of cases) {
      const out = redactSecrets(text, reg);
      expect(out).toContain('«redacted»');
      expect(out).not.toMatch(/ghp_|github_pat_|gho_|ghs_|sk-|xoxb-/);
    }
  });

  it('leaves ordinary prose and near-miss shapes untouched', () => {
    const reg = new SecretRegistry();
    const text = 'ghp_short sk-1 xoxq-nope github_pat is a prefix, task-42 fine';
    expect(redactSecrets(text, reg)).toBe(text);
  });

  it('applies registered values before patterns so whole secrets win', () => {
    const reg = new SecretRegistry();
    // A registered secret that EMBEDS a token-shaped substring is scrubbed
    // whole, not partially by the pattern pass.
    reg.register('prefix-ghp_ABCDEFGHIJKLMNOPQRST123456-suffix');
    expect(redactSecrets('x prefix-ghp_ABCDEFGHIJKLMNOPQRST123456-suffix y', reg)).toBe(
      'x «redacted» y',
    );
  });
});
