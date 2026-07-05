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
import { randomUUID } from 'node:crypto';
import type { RenderCommand } from '@devspace/contracts';
import { CreateEnvironmentRequestSchema } from '@devspace/contracts';
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
  WarmPoolSandboxCore,
  assertRuntimeAvailable,
  envStateStoreFromEnv,
  hardeningFromEnv,
  internalTlsFromEnv,
  nodeCommandRunner,
  previewProxyFromEnv,
  sandboxHostsFromEnv,
  statsIntervalFromEnv,
  warmKeepOnStopFromEnv,
  warmPoolsFromEnv,
  type EnvStateStore,
  type InternalTlsIdentity,
  type PreviewProxyOptions,
  type SandboxCore,
  type SandboxHardening,
  type SandboxHostConfig,
  type WarmPoolConfig,
} from '@devspace/sandbox-core';
import { DefaultAgentRunner, agentRuntimeMount } from '@devspace/agent-runner';
import { Orchestrator } from './index.js';
import { startElectedTask } from './election.js';
import type { ReapPolicy } from './reaper.js';
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
  /**
   * Internal TLS identity (M13). Defaults to `internalTlsFromEnv(process.env)`
   * (DEVSPACE_TLS_*); when set, sandbox hosts are dialed over mutual TLS as
   * service `sandbox-core` with this orchestrator identity, and the bearer
   * token must be unset — one auth regime per deployment (m13-plan Decision 1).
   */
  internalTls?: InternalTlsIdentity;
  /**
   * Durable env table for the LOCAL in-process sandbox (M11). Defaults to
   * `envStateStoreFromEnv(process.env)` (SANDBOX_STATE_DIR); recovery runs
   * before boot returns. In fleet mode the table belongs to each sandbox
   * host's own boot, like hardening/preview.
   */
  envStateStore?: EnvStateStore;
  /**
   * Warm pools (M9, m9-plan Decision 8). Defaults to
   * `warmPoolsFromEnv(process.env)` (SANDBOX_WARM_POOLS=repoUrl[#ref]=size,…).
   * When set, the sandbox — local or fleet — is wrapped in a
   * WarmPoolSandboxCore whose templates carry the SAME agent-runtime mount
   * the orchestrator provisions with, so a matching create claims a warm env.
   */
  warmPools?: WarmPoolConfig[];
  /**
   * Fleet utilization sampling cadence in ms (M16). Defaults to
   * `statsIntervalFromEnv(process.env)` (SANDBOX_STATS_INTERVAL_MS); fleet
   * mode only — placement ranking then weighs fresh live usage alongside
   * grants. Unset/0 = off (the pure M12 grant ranking).
   */
  statsIntervalMs?: number;
}

export interface BootedOrchestrator {
  orch: Orchestrator;
  repos: Repositories;
  bus: EventBus;
  secrets: SecretStore;
  /** Start the PR poll reconciler (the webhook stand-in); returns its stop fn. */
  startReconciler(intervalMs: number): () => void;
  /** Start the elected lifecycle reaper (M17); returns its stop fn. */
  startReaper(policy: ReapPolicy): () => void;
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
  let stopStatsSampling: (() => void) | undefined;
  if (sandboxHosts?.length) {
    const token = config.internalToken ?? process.env.DEVSPACE_INTERNAL_TOKEN;
    const tls = config.internalTls ?? internalTlsFromEnv(process.env);
    if (token && tls) {
      throw new Error(
        'DEVSPACE_INTERNAL_TOKEN and DEVSPACE_TLS_* are mutually exclusive — one auth regime per deployment',
      );
    }
    if (!token && !tls) {
      throw new Error(
        'SANDBOX_HOSTS requires DEVSPACE_INTERNAL_TOKEN or the DEVSPACE_TLS_* identity',
      );
    }
    // Explicitly-passed local sandbox options would be silently dead in fleet
    // mode — refuse loudly instead (env-var equivalents are simply not read
    // here: they may legitimately target the sandbox hosts' own boots).
    if (config.sandboxHardening || config.preview || config.envStateStore) {
      throw new Error(
        'sandboxHosts is incompatible with sandboxHardening/preview/envStateStore — configure them on each sandbox host',
      );
    }
    const fleet = new MultiHostSandboxCore(
      sandboxHosts.map((h) => ({
        name: h.name,
        capacity: h.capacity,
        cpu: h.cpu,
        memMB: h.memMB,
        draining: h.draining,
        core: new RemoteSandboxCore(h.url, token, tls ? { tls } : {}),
      })),
      { onLog: (line) => console.log(`[orchestrator] fleet: ${line}`) },
    );
    // Fleet census (M9): re-learn live envs BEFORE the first placement so a
    // restart never zeroes counted load. A down host warns — lazy cold-miss
    // rediscovery still covers it — but never blocks the whole control plane.
    const census = await fleet.adoptFleet();
    if (census.adopted > 0) {
      console.log(`[orchestrator] fleet census adopted ${census.adopted} live env(s)`);
    }
    for (const failure of census.failures) {
      console.error(
        `[orchestrator] fleet census: host ${failure.host} unreachable: ${failure.error}`,
      );
    }
    // Live utilization sampling (M16): with a cadence configured, ranking
    // weighs each host's fresh measured heat alongside its grants. Off by
    // default; admission never consults it either way.
    const statsIntervalMs = config.statsIntervalMs ?? statsIntervalFromEnv(process.env);
    if (statsIntervalMs) {
      stopStatsSampling = fleet.startStatsSampling(statsIntervalMs);
      console.log(`[orchestrator] fleet utilization sampling every ${statsIntervalMs}ms`);
    }
    sandbox = fleet;
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
    // Durable env table (M11): the in-process sandbox recovers what its
    // predecessor was serving BEFORE anything places or sweeps.
    const stateStore = config.envStateStore ?? envStateStoreFromEnv(process.env);
    const local = new DevcontainerSandboxCore({ hardening, preview, stateStore });
    if (stateStore) {
      const { recovered, discarded, skipped } = await local.recover();
      console.log(
        `[orchestrator] durable env table: recovered ${recovered.length}, cleaned up ${discarded.length}` +
          (skipped.length ? `, skipped ${skipped.length} corrupt file(s)` : ''),
      );
    }
    sandbox = local;
  }
  // Warm pools (M9) compose OVER whatever sandbox this boot built. Templates
  // are built with the same mounts the orchestrator provisions with — claim
  // matching is exact, so any drift only ever means a cold create. fill()
  // first re-adopts pool-marked envs a crashed predecessor left behind (M10).
  const warmPools = config.warmPools ?? warmPoolsFromEnv(process.env);
  let warm: WarmPoolSandboxCore | undefined;
  if (warmPools?.length) {
    warm = new WarmPoolSandboxCore(
      sandbox,
      warmPools.map((p) => ({
        size: p.size,
        template: CreateEnvironmentRequestSchema.parse({
          repoUrl: p.repoUrl,
          ref: p.ref,
          mounts: [agentRuntimeMount()],
        }),
      })),
      {
        onLog: (line) => console.log(`[orchestrator] warm-pool: ${line}`),
        // Rolling-deploy handover (M15): with the knob set, close() leaves
        // marked stock for sibling controllers / the next boot to adopt.
        keepStockOnStop: warmKeepOnStopFromEnv(process.env),
      },
    );
    sandbox = warm;
    void warm.fill(); // background; never rejects — failures log and retry
  }
  const agents = new DefaultAgentRunner({
    exec: sandbox,
    // llmKeyRef is a secret record id resolved through the envelope store.
    resolveSecret: (ref) => secrets.resolveRef(ref),
  });
  // One identity per controller (M15, m15-plan Decision 5): the SAME name
  // shows up in bus-claim diagnostics and the reconciler lease, so an
  // incident reads one id across `claimed_by` and `leases.holder`.
  const instanceId = process.env.DEVSPACE_INSTANCE_ID?.trim() || `orch_${randomUUID()}`;
  // N controllers may share this bus (M14): rows are claim-leased, so the
  // handlers below run on exactly one instance per event in steady state.
  const bus = createPgEventBus(pool, repos.events, { instanceId });

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
      // Elected since M15: every controller ticks, but only the holder of
      // the `pr-reconciler` lease polls GitHub — the M14 closeout's "N
      // duplicate pollers" waste, closed. Publishes stay idempotent, so a
      // rare double-poll (paused holder past its TTL) remains harmless.
      return startElectedTask({
        leases: repos.leases,
        name: 'pr-reconciler',
        instanceId,
        intervalMs,
        run: () =>
          orch.reconcileOpenPrs(async (e) => {
            await bus.publish({ topic: e.topic, workUnitId: e.workUnitId, payload: {} });
          }),
        onLog: (line) => console.log(`[reconcile] ${line}`),
      });
    },
    startReaper(policy: ReapPolicy): () => void {
      // The second elected role (M17, the M15 seed): every controller ticks,
      // only the `lifecycle-reaper` lease holder sweeps. teardown is
      // idempotent and transitions row-locked, so a paused holder resuming
      // past its TTL costs a redundant no-op sweep, never a double destroy.
      return startElectedTask({
        leases: repos.leases,
        name: 'lifecycle-reaper',
        instanceId,
        intervalMs: policy.intervalMs,
        run: async () => {
          const { reaped, warned, suspended, released, prunedTranscripts, prunedAudit, failed } =
            await orch.reapExpired(policy);
          if (
            reaped ||
            warned ||
            suspended ||
            released ||
            prunedTranscripts ||
            prunedAudit ||
            failed
          ) {
            console.log(
              `[reap] reclaimed ${reaped} work unit(s), warned ${warned}, ` +
                `suspended ${suspended}, released ${released} env(s), pruned ` +
                `${prunedTranscripts} transcript + ${prunedAudit} audit row(s), ` +
                `${failed} failure(s)`,
            );
          }
        },
        onLog: (line) => console.log(`[reap] ${line}`),
      });
    },
    async close() {
      // Unclaimed warm envs die with the control plane (clean-shutdown path;
      // after a crash the next boot's fill() re-adopts them by pool mark,
      // M10) — unless SANDBOX_WARM_KEEP_ON_STOP hands them to the fleet (M15).
      await warm?.stop();
      stopStatsSampling?.();
      await bus.stop();
      await preview?.stop();
    },
  };
}
