import { describe, expect, it } from 'vitest';
import type { CommandRunner } from './cli.js';
import type { RunResult } from './cli.js';
import {
  assertRuntimeAvailable,
  DEMO_HARDENING,
  dockerInfoRuntimesArgs,
  dockerNetworkCreateArgs,
  dockerNetworkGatewayArgs,
  dockerNetworkRmArgs,
  HARDENED_DEFAULTS,
  hardeningFromEnv,
  hardeningRunArgs,
  ownsNetworkLifecycle,
  parseDockerRuntimes,
  parseNetworkGateway,
  perEnvNetworkName,
  proxyContainerEnv,
  resolveNetworkName,
} from './hardening.js';

describe('hardeningRunArgs', () => {
  it('maps the full hardened profile flag-by-flag', () => {
    const args = hardeningRunArgs(
      {
        runtime: 'runsc',
        noNewPrivileges: true,
        capDrop: ['ALL'],
        capAdd: ['CHOWN', 'KILL'],
        network: 'per-env',
        enforceDiskQuota: true,
        extraRunArgs: ['--ipc=none'],
      },
      { diskMB: 20480, networkName: 'devspace-net-e1' },
    );
    expect(args).toEqual([
      '--runtime=runsc',
      '--security-opt=no-new-privileges',
      '--cap-drop=ALL',
      '--cap-add=CHOWN',
      '--cap-add=KILL',
      '--network=devspace-net-e1',
      '--storage-opt=size=20480m',
      '--ipc=none',
    ]);
  });

  it('emits nothing for the demo profile', () => {
    expect(hardeningRunArgs(DEMO_HARDENING, { diskMB: 1024 })).toEqual([]);
  });

  it('omits disk quota unless explicitly enforced (driver-gated)', () => {
    const args = hardeningRunArgs(HARDENED_DEFAULTS, { diskMB: 1024, networkName: 'n' });
    expect(args.some((a) => a.startsWith('--storage-opt'))).toBe(false);
  });

  it('omits the network flag when no network resolved', () => {
    const args = hardeningRunArgs({ runtime: 'runsc' }, { diskMB: 1024 });
    expect(args).toEqual(['--runtime=runsc']);
  });
});

describe('network resolution', () => {
  it('resolves per-env to a sanitized env-scoped name that it owns', () => {
    expect(resolveNetworkName({ network: 'per-env' }, 'env_ab/c')).toBe(
      perEnvNetworkName('env_ab/c'),
    );
    expect(perEnvNetworkName('env_ab/c')).toBe('devspace-net-env_ab_c');
    expect(ownsNetworkLifecycle({ network: 'per-env' })).toBe(true);
  });

  it('passes a named network through without owning its lifecycle', () => {
    expect(resolveNetworkName({ network: 'shared-net' }, 'e1')).toBe('shared-net');
    expect(ownsNetworkLifecycle({ network: 'shared-net' })).toBe(false);
  });

  it('resolves to undefined in demo mode', () => {
    expect(resolveNetworkName(DEMO_HARDENING, 'e1')).toBeUndefined();
  });

  it('builds network create/rm argv', () => {
    expect(dockerNetworkCreateArgs('n1', { internal: true })).toEqual([
      'network',
      'create',
      '--internal',
      'n1',
    ]);
    expect(dockerNetworkCreateArgs('n1', { internal: false })).toEqual(['network', 'create', 'n1']);
    expect(dockerNetworkRmArgs('n1')).toEqual(['network', 'rm', 'n1']);
  });
});

describe('proxyContainerEnv', () => {
  it('sets both env-var cases and keeps loopback off the proxy', () => {
    const env = proxyContainerEnv('http://172.20.0.1:3128');
    expect(env.HTTP_PROXY).toBe('http://172.20.0.1:3128');
    expect(env.HTTPS_PROXY).toBe('http://172.20.0.1:3128');
    expect(env.http_proxy).toBe('http://172.20.0.1:3128');
    expect(env.https_proxy).toBe('http://172.20.0.1:3128');
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.no_proxy).toContain('127.0.0.1');
  });
});

describe('network gateway resolution', () => {
  it('builds the inspect argv and parses v4/v6/CIDR gateways', () => {
    expect(dockerNetworkGatewayArgs('n1')).toEqual([
      'network',
      'inspect',
      '--format',
      '{{(index .IPAM.Config 0).Gateway}}',
      'n1',
    ]);
    expect(parseNetworkGateway('172.20.0.1\n')).toBe('172.20.0.1');
    expect(parseNetworkGateway('172.20.0.1/16')).toBe('172.20.0.1');
    expect(parseNetworkGateway('fd00::1')).toBe('fd00::1');
    expect(() => parseNetworkGateway('')).toThrow(/could not parse/);
    expect(() => parseNetworkGateway('<no value>')).toThrow(/could not parse/);
  });
});

describe('hardeningFromEnv', () => {
  it('returns undefined when nothing is configured (demo mode)', () => {
    expect(hardeningFromEnv({})).toBeUndefined();
    expect(hardeningFromEnv({ UNRELATED: 'x' })).toBeUndefined();
  });

  it('starts from HARDENED_DEFAULTS on SANDBOX_HARDENED=1', () => {
    const h = hardeningFromEnv({ SANDBOX_HARDENED: '1' })!;
    expect(h.runtime).toBe('runsc');
    expect(h.network).toBe('per-env');
    expect(h.noNewPrivileges).toBe(true);
    expect(h.enforceDiskQuota).toBe(false);
  });

  it('lets individual vars override, including unsetting the runtime', () => {
    const h = hardeningFromEnv({
      SANDBOX_HARDENED: 'true',
      SANDBOX_RUNTIME: '', // no gVisor on this host
      SANDBOX_DISK_QUOTA: '1',
      EGRESS_PROXY_PORT: '3128',
    })!;
    expect(h.runtime).toBeUndefined();
    expect(h.enforceDiskQuota).toBe(true);
    expect(h.egressProxyPort).toBe(3128);
  });

  it('supports piecemeal config without the hardened base', () => {
    const h = hardeningFromEnv({ SANDBOX_NETWORK: 'shared-net', EGRESS_PROXY_URL: 'http://gw:1' })!;
    expect(h).toMatchObject({ network: 'shared-net', egressProxyUrl: 'http://gw:1' });
    expect(h.runtime).toBeUndefined();
  });
});

describe('parseDockerRuntimes', () => {
  it('extracts runtime names from docker info JSON', () => {
    const stdout = '{"io.containerd.runc.v2":{"path":"runc"},"runsc":{"path":"/usr/bin/runsc"}}\n';
    expect(parseDockerRuntimes(stdout)).toEqual(['io.containerd.runc.v2', 'runsc']);
  });

  it('throws on malformed or non-object output', () => {
    expect(() => parseDockerRuntimes('not json')).toThrow(/could not parse/);
    expect(() => parseDockerRuntimes('[1,2]')).toThrow(/not an object/);
    expect(() => parseDockerRuntimes('null')).toThrow(/not an object/);
  });
});

describe('assertRuntimeAvailable', () => {
  const runnerReturning = (result: RunResult): CommandRunner => ({
    run: async () => result,
    stream: () => {
      throw new Error('unused');
    },
  });

  it('passes when the runtime is present', async () => {
    const runner = runnerReturning({
      code: 0,
      stdout: '{"runsc":{"path":"/usr/bin/runsc"}}',
      stderr: '',
    });
    await expect(assertRuntimeAvailable(runner, 'runsc')).resolves.toBeUndefined();
  });

  it('fails fast with the available list when missing', async () => {
    const runner = runnerReturning({
      code: 0,
      stdout: '{"io.containerd.runc.v2":{}}',
      stderr: '',
    });
    await expect(assertRuntimeAvailable(runner, 'runsc')).rejects.toThrow(
      /"runsc" is not available.*io\.containerd\.runc\.v2/,
    );
  });

  it('queries docker info with the runtimes format', () => {
    expect(dockerInfoRuntimesArgs()).toEqual(['info', '--format', '{{json .Runtimes}}']);
  });
});
