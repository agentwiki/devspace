/**
 * The internal TLS identity module (M13): config loading and the pure identity
 * checks. The full mTLS handshake/authorization story runs over real loopback
 * https servers in `remote-tls.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PeerCertificate } from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import {
  clientTlsOptions,
  internalTlsFromEnv,
  peerAllowed,
  peerServiceName,
  serverTlsOptions,
} from './internal-tls.js';

describe('internalTlsFromEnv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devspace-tls-env-'));
  const paths = {
    DEVSPACE_TLS_CERT: join(dir, 'svc.crt'),
    DEVSPACE_TLS_KEY: join(dir, 'svc.key'),
    DEVSPACE_TLS_CA: join(dir, 'ca.crt'),
  };
  writeFileSync(paths.DEVSPACE_TLS_CERT, 'CERT-PEM');
  writeFileSync(paths.DEVSPACE_TLS_KEY, 'KEY-PEM');
  writeFileSync(paths.DEVSPACE_TLS_CA, 'CA-PEM');

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined when nothing is configured', () => {
    expect(internalTlsFromEnv({})).toBeUndefined();
  });

  it('loads the three PEM files', () => {
    expect(internalTlsFromEnv(paths)).toEqual({ cert: 'CERT-PEM', key: 'KEY-PEM', ca: 'CA-PEM' });
  });

  it('refuses a partial set — silently falling back to token mode would be worse', () => {
    for (const missing of Object.keys(paths)) {
      const env: Record<string, string | undefined> = { ...paths, [missing]: undefined };
      expect(() => internalTlsFromEnv(env)).toThrow(/must be set together/);
    }
  });
});

describe('client service-identity verification (m13-plan Decision 3)', () => {
  const identity = { cert: 'c', key: 'k', ca: 'ca' };
  const check = clientTlsOptions({
    ...identity,
    expectService: 'sandbox-core',
  }).checkServerIdentity;
  const cert = (cn?: string): PeerCertificate =>
    ({ subject: cn === undefined ? undefined : { CN: cn } }) as unknown as PeerCertificate;

  it('accepts the expected service name regardless of hostname', () => {
    expect(check('127.0.0.1', cert('sandbox-core'))).toBeUndefined();
    expect(check('any.host.example', cert('sandbox-core'))).toBeUndefined();
  });

  it('rejects another service and a nameless certificate', () => {
    expect(check('127.0.0.1', cert('chat-gateway'))?.message).toContain('chat-gateway');
    expect(check('127.0.0.1', cert(undefined))?.message).toContain('expected "sandbox-core"');
  });
});

describe('peer identity extraction (fail-closed)', () => {
  const asReq = (socket: unknown): IncomingMessage => ({ socket }) as IncomingMessage;

  it('answers undefined for a plain (non-TLS) socket', () => {
    // A TLS-mode handler accidentally mounted on a cleartext server must
    // refuse everything (m13-plan Decision 6).
    expect(peerServiceName(asReq({}))).toBeUndefined();
    expect(peerAllowed(asReq({}), ['orchestrator'])).toBe(false);
  });

  it('answers undefined for an unauthorized TLS peer', () => {
    const socket = { authorized: false, getPeerCertificate: () => ({ subject: { CN: 'x' } }) };
    expect(peerServiceName(asReq(socket))).toBeUndefined();
  });

  it('extracts the CN from an authorized peer and applies the allowlist', () => {
    const socket = {
      authorized: true,
      getPeerCertificate: () => ({ subject: { CN: 'orchestrator' } }),
    };
    expect(peerServiceName(asReq(socket))).toBe('orchestrator');
    expect(peerAllowed(asReq(socket), ['orchestrator'])).toBe(true);
    expect(peerAllowed(asReq(socket), ['chat-gateway'])).toBe(false);
  });
});

describe('serverTlsOptions', () => {
  it('always requires and verifies the client certificate against the internal CA', () => {
    const opts = serverTlsOptions({ cert: 'c', key: 'k', ca: 'ca' });
    expect(opts.requestCert).toBe(true);
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.ca).toBe('ca');
  });
});
