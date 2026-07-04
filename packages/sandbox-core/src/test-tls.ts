/**
 * Test harness for the internal mTLS regime (m13-plan Decision 7): mint a
 * throwaway internal CA plus CN-named service certificates by shelling out to
 * `openssl`, into a per-run temp dir. Nothing is checked in and nothing can
 * expire in a drawer; suites self-skip when openssl is unavailable (the
 * Docker-itest discipline).
 *
 * This is TEST SUPPORT — production certificates come from the operator's own
 * PKI. The recipe below is also the documented minimum viable one: a private
 * CA and one certificate per service whose subject CN is the service name; no
 * SANs are required because clients verify service identity, not hostname
 * (m13-plan Decision 3).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InternalTlsIdentity } from './internal-tls.js';

function openssl(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('openssl', args, { cwd }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`openssl ${args[0]} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
}

/** True when an `openssl` binary is on PATH (gate for `describe.runIf`). */
export function opensslAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('openssl', ['version'], (err) => resolve(!err));
  });
}

/**
 * Mint an internal CA and one identity per service name. Each identity
 * carries the SAME ca so either side can play client or server. `cleanup()`
 * removes the temp dir (keys never outlive the run).
 */
export async function mintInternalTls(names: string[]): Promise<{
  identities: Record<string, InternalTlsIdentity>;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'devspace-tls-'));
  await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key'], dir);
  await openssl(
    [
      'req',
      '-x509',
      '-new',
      '-key',
      'ca.key',
      '-subj',
      '/CN=devspace-internal-ca',
      '-days',
      '2',
      '-out',
      'ca.crt',
    ],
    dir,
  );
  const ca = await readFile(join(dir, 'ca.crt'), 'utf8');

  const identities: Record<string, InternalTlsIdentity> = {};
  for (const name of names) {
    await openssl(
      ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`],
      dir,
    );
    await openssl(
      ['req', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-out', `${name}.csr`],
      dir,
    );
    await openssl(
      [
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-days',
        '2',
        '-out',
        `${name}.crt`,
      ],
      dir,
    );
    identities[name] = {
      cert: await readFile(join(dir, `${name}.crt`), 'utf8'),
      key: await readFile(join(dir, `${name}.key`), 'utf8'),
      ca,
    };
  }

  return {
    identities,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
