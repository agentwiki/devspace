# M9 — Expansion IV: fleet capacity truth + warm pools (implementation plan)

Design of record for M9. Two of the M9+ seeds are ready now that M8's
placement exists to hang them on: **capacity truth** (host-side enforcement +
a boot-time fleet census — closing the over-place window m8-plan documented
as a risk) and **warm pools** (top-risk #4, cold-start latency). Both land
behind the existing `SandboxCore` seam: the orchestrator FSM, agent-runner,
and both chat adapters are untouched, and a warm-pooled fleet is still just
a `SandboxCore` handed to `bootOrchestrator`'s consumers.

> Prereqs already landed: M8's `MultiHostSandboxCore` (placement, sticky
> routing, cold-miss rediscovery), the remote surface (`remote-server.ts` /
> `RemoteSandboxCore`) the census and late-bound secrets ride, and the M1/M5
> secret discipline this plan must not weaken (env secrets injected per-exec,
> file secrets written post-ready, nothing on the workspace disk).

## Scope

In (per roadmap M9+):

- **Capacity truth.**
  - `SandboxCore.listEnvironments()` — the host's env table becomes readable
    (it always durably WAS the table; M8 said so). New `GET /environments`
    on the remote surface.
  - **Host-side capacity enforcement**: `SANDBOX_MAX_ENVS` on
    sandbox-core-svc caps live envs at the host, the backstop the M8
    client-side cap explicitly lacked.
  - **Boot-time fleet census**: `MultiHostSandboxCore.adoptFleet()` adopts
    every live env on every reachable host at boot, so an orchestrator
    restart no longer zeroes counted load until lazy re-adoption (the
    m8-plan risk, closed).
- **Late-bound secrets.** `SandboxCore.applySecrets(envId, secrets)` —
  attach env/file secrets to a LIVE environment. Exists because warm claim
  needs it (a pooled env is provisioned before its tenant is known), and it
  crosses the service boundary, so the request shape is contract
  (`ApplySecretsRequest`).
- **Warm pools** (top-risk #4). `WarmPoolSandboxCore` wraps ANY inner
  `SandboxCore` (local, remote, or multi-host — composition, not a mode):
  configured pools are pre-provisioned in the background; a matching
  `createEnvironment` claims a warm env, applies the request's secrets, and
  returns in milliseconds instead of minutes; misses fall through to the
  cold path unchanged.

Out (seeded to M10+, with rationale):

- **NATS bus / mTLS.** Rationale unchanged from m8-plan: the bus pays for
  itself when the _orchestrator_ scales out; per-service identity is
  deployment-layer.
- **Resource-aware placement.** Capacity still counts envs, deliberately —
  cpu/mem-aware scheduling needs host-side resource accounting; what M9
  fixes is that the env COUNT is now true (enforced at the host, censused at
  boot).
- **Pool identity / claim-time refresh.** A warm env is not labeled as
  pool-owned on the host, and its clone is as old as fill time (see Risks).
- **Discord Forum dashboard.** Presentation upgrade over `/sessions`; still
  not a gap.

## Decisions

1. **The census is `listEnvironments`, not a new snapshot RPC.** The hosts
   already durably are the env table; making it readable is one route
   (`GET /environments`) and one interface method every core can answer
   from what it already holds. `adoptFleet()` is then pure composition:
   list each host, adopt live envs into the routing table.
2. **Census failures warn; they do not fail boot.** A down host at boot is
   exactly the case M8's lazy rediscovery already covers — refusing to boot
   the whole control plane over it would make one host outage total.
   `adoptFleet` returns `{ adopted, failures }` and the boot layer logs
   both. Only `provisioning`/`ready` envs are adopted: a `stopped`/`failed`
   record must not occupy a placement slot.
3. **Host-side enforcement is a cap on LIVE envs, `PROVISION_FAILED`, named
   clearly.** `SANDBOX_MAX_ENVS` (unset = uncapped, the pre-M9 posture)
   refuses `createEnvironment` at the host when live (provisioning|ready)
   envs are at the cap — the backstop for a mis-configured or
   freshly-restarted orchestrator, not a second scheduler. The multi-host
   core does not parse the message; its client-side cap remains the primary
   and the census keeps it honest.
4. **`applySecrets` is contract, token-gated like exec.** It carries secret
   plaintext across the service boundary, so the shape lives in
   `@devspace/contracts` (`ApplySecretsRequest`) and the route answers 503
   without `DEVSPACE_INTERNAL_TOKEN` — exactly the M8 Decision-5 line: the
   open tokenless JSON surface never handles secrets. Semantics preserve
   the M1 discipline: env-target values merge into the per-exec injection
   map (never baked into the container config), file-target values are
   written 0600 via the exec-based fs path, and file paths are validated
   up front so a bad spec cannot half-apply.
5. **Warm pools are a wrapper, and matching is exact.** A pool is keyed by
   its full template `CreateEnvironmentRequest` (secrets stripped,
   canonically serialized). A claim happens only when the incoming request
   — secrets stripped, schema-normalized — is byte-identical to the
   template: resources, mounts, ref, everything. Anything else falls
   through to the cold path, so drift between the orchestrator's request
   shape and the configured template can never hand out a wrong-shaped env;
   the failure mode of a stale template is "pool never hits", not
   "agent runs in the wrong container".
6. **Claim is verify → apply-secrets → hand out; anything less destroys.**
   A pooled envId is re-checked against the inner core at claim time (the
   host may have been wiped); a vanished env is dropped and the next one
   tried. If `applySecrets` fails, the env is destroyed (best-effort) and
   the claim falls through cold — an env with half-applied secrets never
   reaches a tenant and never returns to the pool.
7. **Refill is background, single-flight per pool, and never throws.** Every
   claim (hit or miss) kicks an async top-up back to the pool size; one
   filler runs per pool at a time (provisioning a fleet of warm envs is
   exactly the burst M8's reservations exist for — no stampede); a fill
   failure logs and stops, retried on the next kick. `fill()` (awaited in
   tests, fire-and-forget at boot) is the same code path.
8. **Warm pools compose OVER whatever sandbox the boot built.** Config is
   `SANDBOX_WARM_POOLS=repoUrl[#ref]=size,…`; the boot layer builds each
   template with the same `agentRuntimeMount()` the orchestrator uses at
   create time, wraps the (local or fleet) core, and fires `fill()`.
   `close()` calls `stop()`, which destroys still-unclaimed warm envs so a
   clean shutdown leaves nothing running.

## Workstreams

### A. Capacity truth

- `sandbox.ts`: `listEnvironments()` on the interface +
  `DevcontainerSandboxCore` (map over the env table); `maxEnvs` constructor
  option enforced in `createEnvironment` (live = provisioning|ready);
  `maxEnvsFromEnv` (`SANDBOX_MAX_ENVS`, positive int, config errors throw at
  boot — the fail-fast precedent).
- `remote-server.ts`: `GET /environments`; `remote-client.ts`:
  `listEnvironments()`.
- `multihost.ts`: `listEnvironments()` (strict aggregate — a down host
  surfaces, it is not an empty list) adopting live envs as it reads;
  `adoptFleet()` (tolerant census per Decision 2).
- `boot.ts` (fleet mode): await `adoptFleet()`, log adopted count + per-host
  failures. apps/sandbox-core-svc: `maxEnvs` from env, logged when set.
- Tests: cap refuses at N live / frees on destroy / ignores failed records;
  census adopts across hosts, skips dead records, tolerates a down host and
  reports it, adopted envs count toward capacity; remote list round-trips.

### B. Late-bound secrets

- contracts: `ApplySecretsRequestSchema { secrets: SecretSpec[] (min 1) }`.
- `sandbox.ts`: `applySecrets` per Decision 4 (requireReady; validate file
  paths first; merge env-target; write file-target 0600).
- `remote-server.ts`: `POST /environments/:id/secrets`, 503 tokenless, 204
  on success; `remote-client.ts` + `multihost.ts` forward.
- Tests: env-target visible to the next exec; file-target lands 0600;
  missing file path rejects without applying anything; CONFLICT before
  ready; remote round-trip; tokenless 503; multihost routes to the owner.

### C. Warm pools

- `warm-pool.ts`: `WarmPoolSandboxCore implements SandboxCore` (Decisions
  5–7): `fill()`, claim-in-`createEnvironment`, background top-up,
  `stop()`; every other op forwards to the inner core.
  `canonicalRequestKey` (schema-parse, strip secrets, stable stringify).
- `parseWarmPools` / `warmPoolsFromEnv`: `repoUrl[#ref]=size` comma list;
  malformed entries throw at boot.
- `boot.ts`: wrap per Decision 8; compose.yaml commented example.
- Tests: fill provisions to size; exact match claims (no cold create) and
  applies the request's secrets; near-miss (different resources/ref) goes
  cold; empty pool goes cold and refills; vanished warm env skipped;
  apply-failure destroys and falls back; claim kicks a refill; stop
  destroys unclaimed envs; parser accept/reject table; key canonicalization.

### D. Docs closeout

- roadmap: M9 landed; M10+ seeded (NATS, mTLS, resource-aware placement,
  pool identity/claim-refresh, Forum dashboard). Top-risk #4 answered.
- architecture.md: one paragraph (capacity truth + warm claim path).
- README status paragraph.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above — warm pool
  and census logic is pure composition over fake cores; the remote additions
  ride the existing loopback suite.
- **Live-Docker itest:** unchanged. The new layers add no container-specific
  behavior — a warm env is provisioned by the same code path the live suite
  already proves.

## Risks / notes

- **A warm env's clone is as old as fill time.** Acceptable for the hot-repo
  / demo case pools exist for; claim-time refresh (a `git fetch` exec before
  hand-out) is seeded to M10 with pool identity.
- **Warm envs for private repos need host-side credentials.** The provision
  clone uses no request secrets today (M1 design); pools inherit exactly
  that behavior — a repo the host cannot clone cannot be pooled.
- **A crash leaks unclaimed warm envs.** `stop()` covers clean shutdown;
  after a crash the census re-adopts them as live load (so capacity stays
  true) but nothing reclaims them — they are indistinguishable from tenant
  envs without pool identity on the host (seeded to M10). Ops can destroy
  them over the JSON surface.
- **The cap and the census close the M8 window, not the race.** A burst
  between census and first placements is still bounded by the host-side cap;
  that is the point of enforcing at both ends.
