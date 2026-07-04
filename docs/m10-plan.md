# M10 — Expansion V: pool identity + claim-time refresh (implementation plan)

Design of record for M10. The two warm-pool seeds m9-plan left on the table
land together because they compose at exactly one point — the claim:
**pool identity** (a warm env is marked pool-owned on its host, so a crashed
orchestrator no longer leaks unclaimed warm envs — the new control plane
re-adopts them) and **claim-time refresh** (the clone a tenant receives is
freshened at hand-out, not as old as fill time). Everything stays behind the
`SandboxCore` seam: the orchestrator FSM, agent-runner, and both chat
adapters are untouched, and a warm-pooled fleet is still just a `SandboxCore`
handed to `bootOrchestrator`'s consumers.

> Prereqs already landed: M9's `WarmPoolSandboxCore` (claim/refill/fall-
> through), `listEnvironments()` (the census read orphan re-adoption rides),
> and `applySecrets` (late binding at claim). The M1/M5 secret discipline is
> untouched — this plan adds no secret-carrying surface.

## Scope

In (per roadmap M10+, the "pool identity / claim-time refresh" seed):

- **Pool identity.** `poolKey` rides `CreateEnvironmentRequest` and is echoed
  on `Environment`: the warm-pool layer stamps every fill-provision with its
  pool's canonical template key, so the HOST's env table — not orchestrator
  memory — records which envs are unclaimed warm stock.
- **Claim as a host operation.** `SandboxCore.claimEnvironment(envId)` hands
  a pool-owned env to a tenant: the owning host freshens the workspace clone
  (`git fetch` + hard reset, the same host-side git the fill-time clone
  used), clears the pool mark, and returns the env. New
  `POST /environments/:id/claim` on the remote surface.
- **Orphan re-adoption.** `WarmPoolSandboxCore.fill()` first sweeps
  `listEnvironments()` for ready envs carrying its pool keys and re-adopts
  them before provisioning anything new — an orchestrator restart reclaims
  its warm stock instead of leaking it (the m9-plan risk, closed).

Out (seeded to M11+, with rationale):

- **NATS bus / mTLS.** Rationale unchanged from m8/m9-plan: the bus pays for
  itself when the _orchestrator_ scales out; per-service identity is
  deployment-layer.
- **Resource-aware placement.** Still counts envs, deliberately — weighting
  needs host-side resource accounting that does not exist yet.
- **Durable host env tables.** The pool mark lives in the host's in-memory
  env table like every other env attribute; a sandbox-core-svc restart loses
  the table wholesale (the documented M8 posture). Fixing that is a
  host-persistence milestone, not a pool concern.
- **Discord Forum dashboard.** Presentation upgrade over `/sessions`; still
  not a gap.

## Decisions

1. **The pool mark IS the canonical template key.** `poolKey` carries
   `canonicalRequestKey(template)` verbatim — no new registry, no hash to
   collide, and re-adoption matching stays exactly as strict as claim
   matching (Decision 5 of m9-plan): a key mismatch can only ever mean "not
   my env", never "wrong-shaped env adopted". `canonicalRequestKey` strips
   `poolKey` along with `secrets` — bookkeeping, like tenancy, is not shape.
2. **Claim is ONE host-side operation: refresh + unmark.** The refresh
   belongs where the clone was made — the owning host has the git binary,
   the host-side credentials, and the workspace folder; an in-container
   fetch would depend on tenant-image tooling and M5 egress policy. Folding
   unmark into the same call keeps the failure mode atomic: anything short
   of a fresh, unmarked, ready env destroys and falls through cold
   (m9-plan Decision 6, extended).
3. **`claimEnvironment` refuses non-pool-owned envs, `CONFLICT`.** A buggy
   (or racing) pool must not be able to "claim" — and hard-reset — a
   tenant's env; the mark is the capability. `NOT_FOUND`/not-ready keep
   their existing lifecycle semantics.
4. **The claim route rides the open JSON surface.** No secret plaintext
   crosses (the M8 Decision-5 line): claim carries an envId and returns an
   `Environment`. `applySecrets` stays token-gated; lifecycle stays the
   local ops tool it has been since M1.
5. **Refresh is `git fetch --depth 1 origin <ref|HEAD>` + hard reset to
   `FETCH_HEAD`, in the host workspace folder.** The same shallow, branch-
   pinned shape as the fill-time clone; `HEAD` covers default-branch pools.
   Scratch templates (no repoUrl) skip the fetch — nothing to refresh.
   A refresh failure surfaces as `EXEC_FAILED` and the claimer destroys:
   the cost of a dead remote is a cold create, never a stale hand-out.
6. **Orphan re-adoption lives in `fill()`, reads the census surface, and
   trims.** `fill()` is the boot-time entry (m9-plan Decision 8); the
   background per-claim kicks stay list-free. Ready envs carrying our key
   and not already tracked are adopted FIFO up to pool size; anything
   beyond size (a shrunk config) is destroyed — re-adoption must close the
   leak, not re-home it. The sweep is tolerant like the census (Decision 2
   of m9-plan): a listing failure logs and the top-up still runs.
7. **Templates must not carry `poolKey`.** The wrapper owns the mark; a
   template arriving pre-marked is a config error, refused at construction
   like a secret-carrying template.

## Workstreams

### A. Pool identity + claim, across the seams

- contracts: `poolKey` (optional, min 1) on `CreateEnvironmentRequestSchema`
  and `EnvironmentSchema`.
- `sandbox.ts`: `claimEnvironment` on the interface; `EnvRecord` keeps
  `workspaceFolder`/`repoUrl`/`ref` from provision time; the core takes the
  `CommandRunner` + `gitPath` it already indirectly owns; implementation per
  Decisions 2/3/5. `DevcontainerSandboxCore.createEnvironment` echoes
  `req.poolKey` onto the env.
- `provision.ts`: `buildGitRefreshArgs(ref?)` next to `buildGitCloneArgs`
  (pure, tested); `ProvisionResult.workspaceFolder` finally gets a consumer.
- `remote-server.ts`: `POST /environments/:id/claim` → 200 Environment;
  `remote-client.ts`: `claimEnvironment()`; `multihost.ts`: forward to the
  owning host (sticky routes / cold-miss probe unchanged).
- Tests: claim refreshes (fake runner pins the exact git argv, cwd included)
  and clears the mark; scratch env skips git; CONFLICT on unmarked env /
  not-ready; NOT_FOUND; refresh failure is EXEC_FAILED and leaves the env
  claimable; remote round-trip + 404; multihost routes to the owner.

### B. Warm pool: stamped fills, refreshed claims, orphan re-adoption

- `warm-pool.ts`: fills provision `{...template, poolKey: pool.key}`; claim
  becomes verify → `claimEnvironment` (destroy on failure) → `applySecrets`
  (destroy on failure) → hand out; `fill()` runs the orphan sweep per
  Decision 6 before topping up; constructor rejects pre-marked templates
  (Decision 7).
- `boot.ts`: no wiring change (fill() already runs at boot) — the crash-leak
  comments get truthed up.
- Tests: fill stamps the key; claim hands out the unmarked env and calls
  claim before secrets; claim failure destroys and falls through cold;
  restart-shaped sweep re-adopts marked ready envs instead of provisioning
  (and counts them toward size); excess beyond size is destroyed; foreign
  keys and unmarked tenant envs are never touched; sweep failure logs and
  top-up still runs; pre-marked template refused.

### C. Docs closeout

- roadmap: M10 landed; M11+ seeded (NATS, mTLS, resource-aware placement,
  host env-table durability, Forum dashboard).
- architecture.md: one paragraph (the claim path: mark → refresh → unmark).
- README status paragraph.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above — claim and
  re-adoption are pure composition over fake cores/runners; the remote
  additions ride the existing loopback suite.
- **Live-Docker itest:** unchanged. Claim adds one host-side git invocation,
  argv-pinned in unit tests; the provision path already proves host git
  against a real repo end to end.

## Risks / notes

- **Claim latency now includes one `git fetch`.** Small against the minutes
  a cold provision costs; the pool still answers in O(seconds) worst-case,
  and a fetch failure degrades to exactly the cold path.
- **Two control planes sharing a fleet would fight over the same marks.**
  Unchanged single-orchestrator assumption (every M8/M9 layer shares it);
  the bus/mTLS milestone is where multi-controller coordination lands.
- **A host restart still forgets its env table** — marks included; the
  containers (labeled `devspace.envId` since M1) become an ops concern.
  Seeded as host-persistence, out of scope here (see Scope).
- **Warm envs for private repos** inherit the M1 posture unchanged: the
  refresh uses the same host credentials the fill-time clone used — a repo
  the host cannot fetch could not have been pooled in the first place.
