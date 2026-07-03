/**
 * Shared production assembly (m4-plan workstream E): Postgres repositories,
 * LISTEN/NOTIFY event bus, envelope-encrypted secret store, live sandbox +
 * agent runner, and the real `Orchestrator` — with migrations applied before
 * anything serves. Extracted from orchestrator-svc so the standalone control
 * plane and the in-process Slack demo wiring boot through ONE code path
 * (no copy-pasted Pg/bus/secret wiring).
 *
 * The caller owns the `pg` Pool (created and closed outside); `close()` here
 * stops only what boot started (the bus). The render transport is injected:
 * orchestrator-svc logs commands, the demo service passes SlackAdapter.render.
 */
import { execFile } from 'node:child_process';
import type { RenderCommand } from '@devspace/contracts';
import {
  createPgEventBus,
  createPostgresRepositories,
  runMigrations,
  type EventBus,
  type Repositories,
} from '@devspace/db';
import {
  DevcontainerSandboxCore,
  MultiHostSandboxCore,
  PreviewProxy,
  RemoteSandboxCore,
  assertRuntimeAvailable,
  hardeningFromEnv,
  nodeCommandRunner,
  previewProxyFromEnv,
  sandboxHostsFromEnv,
  type PreviewProxyOptions,
  type SandboxCore,
  type SandboxHardening,
  type SandboxHostConfig,
} from '@devspace/sandbox-core';
import { DefaultAgentRunner } from '@devspace/agent-runner';
import { Orchestrator } from './index.js';
import { parseKeyring, SecretStore } from './secrets.js';
import { createGitHubRestClient, type HostGitExec } from './git.js';

/** The pool type as declared by the db package — no direct `pg` dependency. */
export type PgPool = Parameters<typeof createPostgresRepositories>[0];

/** Host-side git executor. Never runs inside a container (M3 Decision 1). */
export const nodeHostGit: HostGitExec = {
  run(args, opts) {
    return new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd: opts?.cwd, env: { ...process.env, ...opts?.env } },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ stdout, stderr, code });
        },
      );
    });
  },
};

export interface OrchestratorBootConfig {
  /** Current envelope key, "<keyId>:<base64 32-byte key>". */
  envelopeKey: string;
  /** Retired decrypt-only keys (rotation). */
  retiredKeys?: string[];
  /** GitHub REST base (Enterprise/on-prem override). */
  githubApiBase?: string;
  /** The render transport (Slack adapter in the demo; logs standalone). */
  render: (command: RenderCommand) => Promise<void>;
  workdirFor?: (workUnitId: string) => string;
  revokeToken?: (token: string) => Promise<void>;
  baseBranch?: string;
  /**
   * Sandbox isolation policy (m5-plan Decision 1). Defaults to
   * `hardeningFromEnv(process.env)` so every boot path picks up the
   * SANDBOX_* / EGRESS_* vars; demo mode when nothing is configured.
   */
  sandboxHardening?: SandboxHardening;
  /**
   * Ports preview proxy (M6). Defaults to `previewProxyFromEnv(process.env)`
   * (PREVIEW_PROXY_PORT et al.); off when nothing is configured —
   * `forwardPort` then rejects with a clear message.
   */
  preview?: PreviewProxyOptions;
  /**
   * Sandbox fleet (M8, m8-plan Decision 8). Defaults to
   * `sandboxHostsFromEnv(process.env)` (SANDBOX_HOSTS). When set, the sandbox
   * is MultiHostSandboxCore over RemoteSandboxCore clients and everything
   * host-local (hardening assert, egress/preview proxies) is each sandbox
   * host's own concern; unset, the zero-config in-process boot is unchanged.
   */
  sandboxHosts?: SandboxHostConfig[];
  /** Bearer for the sandbox hosts (defaults to DEVSPACE_INTERNAL_TOKEN). */
  internalToken?: string;
}

export interface BootedOrchestrator {
  orch: Orchestrator;
  repos: Repositories;
  bus: EventBus;
  secrets: SecretStore;
  /** Start the PR poll reconciler (the webhook stand-in); returns its stop fn. */
  startReconciler(intervalMs: number): () => void;
  /** Stop what boot started (the bus). The caller closes its own pool. */
  close(): Promise<void>;
}

export async function bootOrchestrator(
  pool: PgPool,
  config: OrchestratorBootConfig,
): Promise<BootedOrchestrator> {
  // Migrations first — never serve against an unmigrated schema.
  await runMigrations(pool);

  const repos = createPostgresRepositories(pool);
  const keyring = parseKeyring(config.envelopeKey, config.retiredKeys ?? []);
  const secrets = new SecretStore(repos.secrets, keyring);
  // Fleet mode (M8): SANDBOX_HOSTS makes the sandbox a placement layer over
  // remote sandbox-core-svc hosts. Hardening, egress, and preview are host
  // policy and live where the daemons live, so nothing local starts here.
  const sandboxHosts = config.sandboxHosts ?? sandboxHostsFromEnv(process.env);
  let sandbox: SandboxCore;
  let preview: PreviewProxy | undefined;
  if (sandboxHosts?.length) {
    const token = config.internalToken ?? process.env.DEVSPACE_INTERNAL_TOKEN;
    if (!token) throw new Error('SANDBOX_HOSTS requires DEVSPACE_INTERNAL_TOKEN');
    // Explicitly-passed local sandbox options would be silently dead in fleet
    // mode — refuse loudly instead (env-var equivalents are simply not read
    // here: they may legitimately target the sandbox hosts' own boots).
    if (config.sandboxHardening || config.preview) {
      throw new Error(
        'sandboxHosts is incompatible with sandboxHardening/preview — configure them on each sandbox host',
      );
    }
    sandbox = new MultiHostSandboxCore(
      sandboxHosts.map((h) => ({
        name: h.name,
        capacity: h.capacity,
        draining: h.draining,
        core: new RemoteSandboxCore(h.url, token),
      })),
    );
  } else {
    // Hardening is boot-time host policy; a configured runtime class (gVisor/
    // Kata) must exist on the daemon or we refuse to serve at all.
    const hardening = config.sandboxHardening ?? hardeningFromEnv(process.env);
    if (hardening?.runtime) {
      await assertRuntimeAvailable(nodeCommandRunner, hardening.runtime);
    }
    // The ports preview proxy (M6) — started before anything can forwardPort.
    const previewOptions = config.preview ?? previewProxyFromEnv(process.env);
    if (previewOptions) {
      preview = new PreviewProxy(previewOptions);
      await preview.start();
    }
    sandbox = new DevcontainerSandboxCore({ hardening, preview });
  }
  const agents = new DefaultAgentRunner({
    exec: sandbox,
    // llmKeyRef is a secret record id resolved through the envelope store.
    resolveSecret: (ref) => secrets.resolveRef(ref),
  });
  const bus = createPgEventBus(pool, repos.events);

  const orch = new Orchestrator({
    repos,
    sandbox,
    agents,
    secrets,
    git: nodeHostGit,
    githubRest: (token) =>
      createGitHubRestClient(token, config.githubApiBase ?? 'https://api.github.com'),
    render: config.render,
    workdirFor: config.workdirFor,
    revokeToken: config.revokeToken,
    baseBranch: config.baseBranch,
  });

  bus.subscribe((evt) => orch.handleBusEvent(evt));
  await bus.start();

  return {
    orch,
    repos,
    bus,
    secrets,
    startReconciler(intervalMs: number): () => void {
      const timer = setInterval(() => {
        void orch
          .reconcileOpenPrs(async (e) => {
            await bus.publish({ topic: e.topic, workUnitId: e.workUnitId, payload: {} });
          })
          .catch((err) => console.error(`[reconcile] ${String(err)}`));
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    async close() {
      await bus.stop();
      await preview?.stop();
    },
  };
}
