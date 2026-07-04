# M12 — Expansion VII: resource-aware placement (implementation plan)

Design of record for M12. The placement seed the roadmap has carried since M8
lands: "capacity still counts envs, deliberately — cpu/mem-aware scheduling
needs host-side resource accounting; M9 made the count TRUE, M12+ makes it
weighted." Both halves of that sentence become real: every environment now
reports the resources it was granted (the host-side accounting that did not
exist), and `MultiHostSandboxCore` places by fractional utilization against
per-host cpu/memory budgets instead of a bare env count. Everything stays
behind the `SandboxCore` seam — the orchestrator FSM, agent-runner, and both
chat adapters are untouched; one optional contract field (`Environment.
resources`) and two optional host-config knobs are the entire surface change.

> Prereqs already landed: `listEnvironments()` + `adoptFleet()` (M9 — the
> census the weights ride), request-side `resources` with schema defaults
> (M0 — every env has always HAD a grant; nothing reported it), and the M11
> durable table (recovered envs must keep their true weight, not a guess).

## Scope

In (per roadmap M12+, the "resource-aware placement" seed):

- **Resource truth.** `Environment` echoes the `ResourceLimits` the host
  granted at provisioning (request value, schema defaults applied). The echo
  rides `listEnvironments()`/`getEnvironment()` unchanged over the M8 wire,
  is preserved by claim (a hand-out does not change an env's size), and is
  persisted in the M11 state file so recovery restores the real weight.
- **Weighted placement.** A sandbox host can declare cpu/memory budgets
  (`SANDBOX_HOSTS=name=url[|capacity][|cpu=<cores>][|mem=<MB>][|drain]`).
  Placement admission checks fit (a request's grant must fit every budget
  the host declares, and the env count stays under `capacity` — the M8/M9
  backstop is unchanged); ranking becomes least fractional utilization.
  In-flight reservations carry their resource weight, not just a count.
- **Adopted weights.** The census, `listEnvironments()` adoption, and
  cold-miss probes read each env's echoed `resources` into the accounting;
  an env from a pre-M12 host (no echo) weighs the contract defaults — the
  same values its provisioner actually applied.

Out (seeded to M13+, with rationale):

- **NATS bus / mTLS.** Rationale unchanged since m8-plan: the bus pays for
  itself when the _orchestrator_ scales out; per-service identity is
  deployment-layer.
- **Live utilization (cgroup stats).** M12 schedules on GRANTS, not usage —
  grants are stable, known at placement time, and enforced by the container
  runtime (`--cpus`/`--memory` since M0). Usage-based scheduling needs a
  stats pipeline and an eviction story; a different milestone.
- **Disk-weighted placement.** `diskMB` is enforced per-env when the storage
  driver supports it (M5) but host disk budgets interact with image/layer
  sharing in ways a sum of grants does not model; deferred until it hurts.
- **Discord Forum dashboard.** Presentation upgrade over `/sessions`; still
  not a gap.

## Decisions

1. **Schedule on grants, not usage.** The request's `ResourceLimits` (with
   schema defaults applied — what the provisioner passes to `--cpus`/
   `--memory`) is the unit of accounting. It is known before the container
   exists, never fluctuates, and sums linearly. Oversubscription is expressed
   in the budget itself (declare `cpu=32` on a 16-core host) rather than in
   scheduler heuristics.
2. **The echo is optional on the contract, always present from this host.**
   `Environment.resources` is `.optional()` so answers from a pre-M12
   sandbox-core-svc still parse (the M8 wire discipline: additive, never
   breaking). Consumers that need a weight for an echo-less env use the
   contract defaults — which is exactly what that env's provisioner granted
   if its request omitted resources.
3. **Budgets are opt-in per host; a fleet that declares nothing keeps the M8
   comparator's results.** With no `cpu=`/`mem=` flags, admission is the env
   count (unchanged) and ranking is count/capacity — identical ORDER to M8's
   raw count whenever capacities are uniform (the common config; every entry
   defaults to `DEFAULT_HOST_CAPACITY`). Heterogeneous-capacity fleets now
   fill proportionally — that is the deliberate behavior change this
   milestone exists to make, and it is what "least-loaded" should have meant
   once capacities differ.
4. **One comparator: max fractional utilization over declared dimensions.**
   A host's load score is `max(count/capacity, cpu/cpuBudget, mem/memBudget)`
   over the dimensions it declares; lowest score wins, ties in config order.
   The max (not average) keeps a host that is cpu-saturated but memory-empty
   from winning on the average and admitting an env its cpu cannot fit.
5. **Admission is fit-checked per dimension; refusal messages distinguish
   why.** A host is eligible when it is not draining, has an env-count slot,
   AND the request's grant fits every declared budget's remaining room.
   "All non-full hosts are draining" / "no host has capacity left" (both
   unchanged from M8) gain a third distinct refusal: "no host fits the
   requested resources" — an operator must be able to tell a full fleet
   from a fragmented one.
6. **Reservations weigh what they will occupy.** The M8 in-flight pending
   count becomes a pending WEIGHT ({count, cpu, memMB}); a burst of
   concurrent creates reserves its resource footprint the same way it
   reserves its slot, so overlapping placements cannot oversubscribe a
   budget any more than they could overshoot a capacity.
7. **The route table owns the weights.** Each adopted/placed route stores
   its env's weight next to the host name; eviction, destroy, and re-adoption
   free or recount weights exactly when they free or recount the slot — no
   second table to drift.
8. **Persist the grant in the M11 state file.** A recovered env must weigh
   what it actually holds (`--cpus`/`--memory` were applied at provision
   time and survive the restart with the container). `resources` joins the
   metadata-only persisted slice — it is a size, not a secret. Optional on
   the schema, so pre-M12 state files load unchanged (their envs echo
   nothing and upstream weighs defaults — see Decision 2).

## Workstreams

### A. Resource truth: contract echo + host accounting + persistence

- `contracts`: `EnvironmentSchema` gains `resources:
ResourceLimitsSchema.optional()` (Decision 2). No other contract change.
- `sandbox.ts`: the parsed request's `resources` land on the `Environment`
  at creation and are preserved through ready/claim/destroy transitions;
  `persistedState` includes them; `recover()` restores them onto the
  re-adopted env (absent in an old file → absent on the echo, Decision 8).
- `env-state.ts`: `PersistedEnvStateSchema` gains optional `resources`.
- Tests: the echo appears with schema defaults when the request omits
  resources and with the request's values when it does not; claim preserves
  it; the persisted state pins it; recovery restores it; an old state file
  (no `resources`) still loads and recovers echo-less.

### B. Weighted placement: budgets + fractional ranking + reservations

- `multihost.ts`: `SandboxHost`/`SandboxHostConfig` gain optional `cpu` and
  `memMB`; `parseSandboxHosts` accepts `cpu=<cores>` (positive, fractional
  ok) and `mem=<MB>` (positive integer) flags; routes store
  `{ host, weight }` (Decision 7); pending stores weights (Decision 6);
  `place()` fit-checks and ranks per Decisions 4–5. Weights come from the
  parsed request at placement and from the env's echo (defaults when
  absent) at adoption/probe/census.
- `boot.ts`: pass `cpu`/`memMB` through to the fleet's `SandboxHost`s.
- README: document the new `SANDBOX_HOSTS` flags.
- Tests: flag parsing (including rejects); fractional ranking picks the
  proportionally-least-loaded host (uniform-capacity order matches M8);
  fit-check refuses with the distinct message when count slots exist but no
  budget fits; concurrent creates reserve weights (a cpu burst cannot
  oversubscribe a budget); census/adoption weighs echoed resources and
  defaults an echo-less env; destroy/evict free the weight.

### C. Docs closeout

- roadmap: M12 landed; M13+ seeded (NATS, mTLS, live-utilization
  scheduling, disk budgets, Forum dashboard).
- architecture.md: one paragraph (grants echoed → weighted fleet placement).
- README status paragraph.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above — the echo
  and persistence run over the existing fake runtime/provisioner harness;
  placement runs over the existing fake per-host cores; parsing is pure.
- **Live-Docker itest:** unchanged. The grant was already applied to the
  container (M1/M5 runArgs, inspected live since M5); M12 only reports it.

## Risks / notes

- **Grants lie when operators oversubscribe.** By design (Decision 1): the
  budget is the oversubscription dial. The scheduler stays truthful about
  what it PROMISED, which is the only thing it can know without a stats
  pipeline (deferred, see Scope).
- **Heterogeneous-capacity fleets change fill order** (Decision 3). The M8
  behavior was "fewest envs wins"; proportional fill is strictly more
  sensible with mixed capacities, but an operator who tuned around the old
  order will see placements move. Called out in the README config docs.
- **A pre-M12 host in a mixed fleet weighs its envs as defaults** (Decision
  2). If its envs were granted more than defaults, its budgets under-count
  until the host upgrades — bounded by the env-count capacity backstop,
  which never stopped applying.
- **Weights double as memory: the routing table grows a value struct.** Same
  lifetime and eviction rules as the routes themselves (Decision 7); no new
  cleanup path to forget.
