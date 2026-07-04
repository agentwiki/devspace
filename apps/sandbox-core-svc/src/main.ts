/**
 * Deployable entrypoint for sandbox-core — one host of the (possibly 1-sized)
 * sandbox fleet.
 *
 * Since M8 the full surface lives in the package (`remote-server.ts`) and this
 * file is config + wiring: the JSON control surface plus the `devspace-exec`
 * upgrade endpoint that carries the load-bearing full-duplex exec stream over
 * the network to the orchestrator's RemoteSandboxCore. With
 * DEVSPACE_INTERNAL_TOKEN set, everything except /health requires the internal
 * bearer; without it, the JSON surface stays a local ops/debug tool and the
 * exec stream refuses to serve (m8-plan Decision 5).
 */
import { createServer } from 'node:http';
import {
  DEFAULT_EGRESS_ALLOWLIST,
  DevcontainerSandboxCore,
  EgressProxy,
  PreviewProxy,
  assertRuntimeAvailable,
  createSandboxRequestHandler,
  createSandboxUpgradeHandler,
  hardeningFromEnv,
  maxEnvsFromEnv,
  nodeCommandRunner,
  previewProxyFromEnv,
} from '@devspace/sandbox-core';

const SERVICE = 'sandbox-core';
const PORT = Number(process.env.PORT ?? 4001);
const TOKEN = process.env.DEVSPACE_INTERNAL_TOKEN || undefined;

// M5 hardening is boot-time host policy (m5-plan Decision 1). Fail fast when
// the configured runtime class (gVisor/Kata) is absent from the daemon.
const hardening = hardeningFromEnv(process.env);
if (hardening?.runtime) {
  await assertRuntimeAvailable(nodeCommandRunner, hardening.runtime);
  console.log(`[${SERVICE}] container runtime: ${hardening.runtime}`);
}

// The egress allowlist proxy — the only door out of an --internal env network.
// EGRESS_ALLOWLIST extends the sandbox defaults (comma-separated hostnames).
if (hardening?.egressProxyPort) {
  const allowlist = [
    ...DEFAULT_EGRESS_ALLOWLIST,
    ...(process.env.EGRESS_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  const proxy = new EgressProxy({
    allowlist,
    port: hardening.egressProxyPort,
    onLog: (line) => console.log(`[${SERVICE}] egress: ${line}`),
  });
  await proxy.start();
  console.log(`[${SERVICE}] egress proxy on :${hardening.egressProxyPort}`);
}

// The ports preview proxy (M6) — authenticated ingress to env ports; the
// ingress counterpart of the egress proxy above. Off without PREVIEW_PROXY_PORT.
const previewOptions = previewProxyFromEnv(process.env);
let preview: PreviewProxy | undefined;
if (previewOptions) {
  preview = new PreviewProxy(previewOptions);
  const started = await preview.start();
  console.log(`[${SERVICE}] preview proxy on :${started.port} (${started.baseUrl})`);
}

// Host-side capacity backstop (M9): SANDBOX_MAX_ENVS caps live envs at THIS
// host regardless of what the placement layer believes (m9-plan Decision 3).
const maxEnvs = maxEnvsFromEnv(process.env);
if (maxEnvs !== undefined) console.log(`[${SERVICE}] capacity cap: ${maxEnvs} live env(s)`);

const core = new DevcontainerSandboxCore({ hardening, preview, maxEnvs });

const server = createServer(createSandboxRequestHandler(core, { token: TOKEN, service: SERVICE }));
server.on(
  'upgrade',
  createSandboxUpgradeHandler(core, {
    token: TOKEN,
    onLog: (line) => console.log(`[${SERVICE}] exec: ${line}`),
  }),
);

server.listen(PORT, () => {
  console.log(`[${SERVICE}] listening on :${PORT}`);
  if (!TOKEN) {
    console.log(
      `[${SERVICE}] DEVSPACE_INTERNAL_TOKEN unset — JSON surface open (local ops), exec stream disabled`,
    );
  }
});
