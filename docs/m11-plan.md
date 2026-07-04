# M11 — Expansion VI: durable host env tables (implementation plan)

Design of record for M11. The host-persistence seed every milestone since M8
has been pointing at lands: a sandbox host's env table — pool marks included —
survives a sandbox-core-svc restart. M9 taught a restarted _orchestrator_ to
re-learn its fleet (`adoptFleet`) and M10 taught it to reclaim its warm stock
(the orphan sweep); both reads go through `listEnvironments()`, which until now
answered from a `Map` that a host restart wipes. M11 makes that table durable,
so the recovery machinery that already exists upstream finally covers the
failure it could not: the HOST process dying, not just the control plane.

> Prereqs already landed: `listEnvironments()` (M9 — the census both sweeps
> ride), `applySecrets` (M9 — the re-attach seam recovery leans on), and
> `poolKey` on the host env table (M10 — the mark recovery must preserve).
> The M1/M5 secret discipline is untouched — this plan writes NO secret
> value to host disk, ever.

## Scope

In (per roadmap M11+, the "durable host env tables" seed):

- **Durable env state.** An opt-in per-env JSON state file under
  `SANDBOX_STATE_DIR`: metadata only (envId, status, containerId,
  networkName, workspaceFolder, repoUrl, ref, poolKey, createdAt). Written at
  every lifecycle transition the host must not forget, removed at destroy.
- **Boot-time recovery.** `DevcontainerSandboxCore.recover()`: load the state
  dir, verify each record against the Docker daemon, re-adopt ready envs
  (pool marks included) into the in-memory table, and clean up what a crash
  left half-done (a mid-provision container, a per-env network).
- **Restart composition, for free.** Zero changes upstream: recovered envs
  answer `listEnvironments()`, so `MultiHostSandboxCore.adoptFleet()` counts
  them and `WarmPoolSandboxCore.fill()` re-adopts recovered warm stock — the
  M9/M10 sweeps now survive a host restart, not just an orchestrator restart.

Out (seeded to M12+, with rationale):

- **NATS bus / mTLS.** Rationale unchanged from m8/m9/m10-plan: the bus pays
  for itself when the _orchestrator_ scales out; per-service identity is
  deployment-layer.
- **Resource-aware placement.** Still counts envs, deliberately — weighting
  needs host-side resource accounting that still does not exist.
- **Discord Forum dashboard.** Presentation upgrade over `/sessions`; still
  not a gap.
- **Preview routes surviving a restart.** The proxy's route table is
  in-memory and its tokens are capabilities (never persisted — see
  Decision 2); a restarted host serves recovered envs whose `ports` are
  empty, and a tenant re-runs `expose-port`. Durable routes would mean
  tokens on disk; not worth it.

## Decisions

1. **A state file per env, in a directory — not a database, not labels.**
   The table is tiny (one host's live envs), the writes are rare (lifecycle
   transitions), and per-env files make removal atomic and recovery trivially
   inspectable by ops. Docker container labels were the tempting alternative
   (the containers already carry `devspace.envId` since M1) and are rejected
   for one hard reason: labels are immutable after create, and the pool mark
   must CLEAR at claim (M10 Decision 3 — the mark is the capability). The
   `devspace.envId` label stays what it was: the ops handle.
2. **Metadata only — never secret values, never preview tokens.** The M1/M5
   line (nothing sensitive on host disk) holds: `secretEnv` is not persisted,
   so a recovered env comes back with an EMPTY per-exec secret map and the
   control plane re-attaches via `applySecrets` — the M9 seam is exactly this
   shape (warm claims already do; a recovered tenant env needs the same).
   `ports` carry capability tokens, so they are not persisted either
   (see Scope).
3. **Opt-in config; the zero-config boot is byte-for-byte unchanged.**
   `SANDBOX_STATE_DIR` set → durable table + recovery at boot; unset → the
   documented M8 in-memory posture, no writes, no reads, no new behavior.
4. **The daemon is truth; the file is a hint.** Recovery re-adopts a record
   only when its status is `ready` AND its container still exists
   (`runtime.exists`). Anything else is a crashed transition or a dead env:
   best-effort destroy of the container and per-env network, then the file
   is removed — recovery closes the mid-provision leak instead of re-homing
   it. A corrupt/unparseable file logs and is skipped (tolerant like the M9
   census); it never fails boot.
5. **A persistence failure fails the operation that needed it.** A create
   that cannot persist is `PROVISION_FAILED` (the env is destroyed, not
   handed out — a durable host must not serve envs it will forget); a claim
   that cannot persist its unmark is `EXEC_FAILED` and the claimer destroys
   (a forgotten unmark would resurrect the pool mark at the next restart and
   let the orphan sweep hard-reset a TENANT workspace — the exact hazard M10
   Decision 3 exists to prevent). Destroy-side file removal is best-effort:
   a leftover file for a dead container is exactly what Decision 4 cleans.
6. **Atomic writes.** Write to a temp name in the same directory, then
   rename. A crash mid-write can only ever leave a torn `.tmp` file (ignored
   and swept at recovery), never a torn state file.
7. **`recover()` is an explicit boot step, not constructor magic.** The
   constructor stays synchronous; the svc (and the in-process orchestrator
   boot) call `await core.recover()` before serving, and log what was
   re-adopted vs discarded. Ordering matters and is now guaranteed: recover →
   listen → (upstream) adoptFleet / fill().

## Workstreams

### A. The durable table: env-state store + core persistence + recovery

- `env-state.ts` (new): `PersistedEnvState` (zod-validated on read),
  `FileEnvStateStore` — `save` (atomic per Decision 6), `remove`,
  `loadAll(): { states, skipped }` (corrupt files reported, not thrown);
  `envStateStoreFromEnv` (`SANDBOX_STATE_DIR`; undefined when unset, mkdir
  at construction).
- `sandbox.ts`: optional `stateStore` dep. Persist points: after the record
  is created (`provisioning`), after ready, after claim's unmark (Decision
  5); removal in `destroyEnvironment`. `recover()` per Decision 4 —
  re-adopted records rebuild the full `EnvRecord` (containerId,
  networkName, workspaceFolder, repoUrl, ref, poolKey) with an empty
  `secretEnv` and empty `ports` (Decision 2); returns
  `{ recovered, discarded }` envId lists for boot logging.
- Tests: store round-trip / atomic overwrite / corrupt-file skip on a real
  temp dir; persist points pin the exact state written (poolKey present on
  a marked fill, gone after claim); create-persist failure destroys and is
  PROVISION_FAILED; claim-persist failure is EXEC_FAILED and leaves the env
  claimable; recovery adopts ready+live (claim and exec work afterward,
  secretEnv empty), discards dead-container records, destroys mid-provision
  leftovers (container AND network), skips corrupt files, sweeps stale
  `.tmp` files.

### B. Boot wiring + restart composition

- `sandbox-core-svc/main.ts`: build the store from env, pass it to the
  core, `await core.recover()` before `listen`, log the summary (count
  re-adopted / discarded, pool marks included).
- `orchestrator/boot.ts` (local in-process mode only): same wiring —
  `envStateStoreFromEnv` + `recover()` before the boot returns; fleet mode
  is untouched (the state dir belongs to each sandbox host's own boot,
  like hardening/preview).
- Composition tests (the M11 story end-to-end, no Docker): "host restart"
  = a second `DevcontainerSandboxCore` over the SAME state dir + a fake
  runtime that still knows the containers; after `recover()`,
  `WarmPoolSandboxCore.fill()` re-adopts the recovered marked envs instead
  of provisioning new ones, and a recovered tenant env accepts
  `applySecrets` + `exec` (the re-attach path). A dead-container record
  never reaches either sweep.
- README/compose: document `SANDBOX_STATE_DIR` alongside the other
  `SANDBOX_*` config.

### C. Docs closeout

- roadmap: M11 landed; M12+ seeded (NATS, mTLS, resource-aware placement,
  Forum dashboard).
- architecture.md: one paragraph (the durable table: persist → recover →
  the existing sweeps).
- README status paragraph.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above — the store
  runs against a real temp directory (plain node fs, CI-safe); core persist/
  recovery runs over the existing fake runtime/provisioner harness; the
  restart composition test is pure wiring over fakes.
- **Live-Docker itest:** unchanged. Recovery's only daemon interaction is
  `runtime.exists`/`destroy`, both already proven live in M1's suite.

## Risks / notes

- **The state file can drift from the daemon** (a container OOM-killed while
  the host was down). Decision 4 bounds the blast radius: recovery trusts
  the daemon, so drift degrades to "not recovered", never "recovered wrong".
- **Recovered envs lose their per-exec secrets** — by design (Decision 2).
  Warm stock re-secretes at claim (M10 path, unchanged); a recovered TENANT
  env needs the control plane to re-run `applySecrets` before the next turn.
  The orchestrator already resolves secrets per-turn, so the practical
  exposure is a window where an exec sees no `GH_TOKEN`/LLM key — the turn
  fails closed, not open.
- **Two processes sharing one state dir would fight.** Same posture as the
  M10 single-control-plane assumption, one level down: one sandbox-core-svc
  per state dir. Not enforced with lockfiles — a deployment concern, like
  the daemon socket itself.
- **`workspaceFolder` lives under tmpdir by default** — a machine REBOOT
  (as opposed to a service restart) may clear it, in which case a recovered
  pool env's claim-time refresh fails and the claimer destroys and goes
  cold (the M10 failure shape, unchanged). Ops pointing `SANDBOX_STATE_DIR`
  at a persistent path should point the workspace root somewhere persistent
  too; documented, not enforced.
