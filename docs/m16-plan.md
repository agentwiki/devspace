# M16 — Expansion XI: live utilization truth + usage-aware ranking (implementation plan)

Design of record for M16. Since M12 the fleet schedules on GRANTS — stable,
known at placement time, with the budget itself as the oversubscription dial —
and the roadmap has carried "live-utilization scheduling" as a deferred seed
ever since, with the caveat that usage-based placement needs a cgroup stats
pipeline and an eviction story. M16 lands the half of that seed that is ready
and deliberately leaves the half that is not: hosts learn to report what their
envs actually consume (`docker stats`, surfaced as one JSON read per host),
and fleet placement uses that live signal to RANK candidate hosts — never to
admit them. Admission stays exactly the M12/M14 grant arithmetic, so a host
can never be oversubscribed past its declared budgets by this change, and the
eviction story the roadmap warned about is not needed: a live signal that only
demotes a hot host requires nothing to be killed when the signal was wrong.
Zero changes to any existing route or interface method; the surface is one
additive contract type, one optional `ContainerRuntime` method, one new
host route (`GET /stats`), and one orchestrator config knob.

> Prereqs already landed: per-env resource truth echoed and durable
> (M12/M11), grant-budgeted admission at both the placement layer (M12) and
> the host itself (M14), the fleet's per-host `SandboxCore` seam with
> tolerant degraded modes (M8/M9), and the remote JSON surface + client the
> new read rides (M8).

## What M16 fixes

1. **The control plane is blind to actual load.** Placement, budgets, and
   the census all reason about grants; nobody can see that one host's envs
   are pegging their cpus while another's are idle. Operators get no
   utilization read at all short of sshing to a host and running
   `docker stats` by hand.
2. **Ranking treats a saturated host and an idle one as equals.** Two hosts
   with the same summed grants score identically today even when their real
   loads differ by an order of magnitude (grants are ceilings, and agent
   workloads are bursty — most envs idle most of the time). The M12 score
   already picks the least-loaded host BY GRANT; with a live signal it can
   stop sending new envs to the host that happens to be hot right now.

## Scope

In (per roadmap M16+, the ready half of "live-utilization scheduling"):

- **Host utilization truth.** `docker stats --no-stream` behind the same
  pure-argv/pure-parse discipline as every docker call since M1, exposed as
  `getHostStats()` on the local core: per-env usage in GRANT UNITS (cpu
  cores, memMB) plus the host's own physical capacity (cpu count, total
  memory), stamped with a sample time. One additive contract type
  (`HostStats`) because the read crosses the wire: `GET /stats` on the
  remote surface, `RemoteSandboxCore.getHostStats()` on the client.
- **Usage-aware ranking in the fleet.** `MultiHostSandboxCore` gains an
  optional background sampler (`SANDBOX_STATS_INTERVAL_MS`; off by
  default). Each round polls every host's `/stats` and caches the result;
  placement's score becomes `max(grant fractions, live fractions)` for
  hosts with a FRESH sample and stays the pure M12 grant score otherwise.
  Live fractions weigh measured usage against the host's declared budgets
  when present, else against its reported physical capacity. A sample
  older than 3× the interval is stale and ignored — an unreachable host
  degrades to grant-based ranking, never to unplaceable.
- **Admission untouched.** Fit-checks (count slot, cpu/mem budgets, the
  M14 host-side backstop) evaluate grants exactly as before. The live
  signal can only demote a candidate in the ranking, never veto or admit.

Out (seeded to M17+, with rationale):

- **Usage-based ADMISSION and eviction.** Admitting on a low instantaneous
  reading invites oversubscription the moment idle envs wake up, and then
  something must be evicted — the cost/benefit the roadmap flagged, still
  not paid. Grants remain the admission truth.
- **Disk-weighted placement.** Host disk interacts with image/layer
  sharing in ways neither grants nor per-container stats model;
  `docker stats` does not report disk at all. Unchanged from the M14/M15
  closeouts.
- **Turn-level failover, NATS, certificate rotation tooling, Forum
  dashboard.** Unchanged from the M15 closeout.

## Decisions

1. **`docker stats` is the pipeline, not cgroup files.** Every host
   operation since M1 shells to `docker` through the same CommandRunner
   seam with pure argv builders and pure output parsers; stats is one more.
   Reading cgroup v1/v2 files directly would be faster but binds sandbox-core
   to the daemon host's cgroup layout — exactly the coupling the runtime
   seam exists to avoid. `--no-stream` costs ~1–2s per sample, which the
   background sampler absorbs off the placement path.
2. **Usage reports in grant units.** Docker's `CPUPerc` is percent-of-one-
   core and `MemUsage` is a human-formatted byte pair; the parser normalizes
   to cpu CORES and MB — the exact units of `ResourceLimits`, host budgets,
   and the `cpu=`/`mem=` host flags — so every consumer compares usage to
   grants without unit arithmetic.
3. **Ranking only, and `max()` with the grant score.** The live signal can
   only make a host look WORSE, never better: an idle-but-fully-granted
   host still carries its grant fraction (those envs may wake up any
   moment — the grant is the ceiling the host must honor), while a host
   measurably hotter than its grants suggest is demoted. Correctness never
   depends on the sample: stale, missing, or wrong samples leave placement
   exactly as good as M12. This is the same posture as the M15 lease —
   the new signal deduplicates waste; it is never load-bearing.
4. **The sampler lives in the fleet layer, off by default.** Placement is
   latency-sensitive, so `place()` never dials a host; it reads the cache
   the background sampler maintains. `SANDBOX_STATS_INTERVAL_MS` unset (or 0) means no sampler, no cache, byte-for-byte M12 ranking — the
   zero-config posture every milestone has kept. Freshness is 3× the
   interval: one missed round (slow host, transient error) does not flap
   ranking back to grants, a dead host fades out after three.
5. **Per-env attribution by container-id prefix.** `docker stats` reports
   short (12-char) ids; the env table holds full ids. Matching is
   prefix-based against OUR ready envs only — foreign containers on a
   shared daemon are invisible in the per-env list. They still show in the
   host's physical capacity picture implicitly (their load doesn't count,
   which is fine: budgets are about what WE placed; the physical capacity
   denominators are what the sampler reports, not what it can attribute).
6. **`GET /stats` keeps the `listEnvironments` auth posture.** The read
   carries usage numbers and env ids — no secret material, no capability
   tokens — so it serves on the open local-ops surface tokenless, behind
   the bearer in token mode, and behind the peer allowlist in TLS mode:
   exactly the M9 census read's line. Cores without stats support (the
   runtime seam is optional) answer 404, and the fleet sampler treats that
   as "no sample", not an error.
7. **One additive contract type, no `Environment` change.** Usage is an
   instantaneous sample of a HOST, not durable env state — putting it on
   `Environment` would invite consumers to trust a stale number that
   happened to ride along with a lifecycle read. `HostStatsSchema`
   validates the wire read on both ends; nothing existing re-parses.

## Workstreams

### A. Host utilization truth (contracts + sandbox-core host side)

- contracts: `EnvUsageSchema` (`envId`, `cpu` cores, `memMB`) and
  `HostStatsSchema` (`sampledAt`, `cpuCount`, `memTotalMB`,
  `envs: EnvUsage[]`). Additive.
- `runtime.ts`: `dockerStatsArgs()` (`stats --no-stream --format {{json .}}`,
  all running containers — never named ids, so a container that died
  mid-sample cannot fail the whole read), `parseDockerStats(stdout)` (pure,
  total: `CPUPerc` "12.34%" → cores, `MemUsage` "1.5GiB / 15.6GiB" → MB;
  malformed lines skipped, never throw), `ContainerRuntime.stats?()`.
- `sandbox.ts`: `HostStatsProvider` interface + `hasHostStats` guard;
  `DevcontainerSandboxCore.getHostStats()` — runtime stats filtered to OUR
  live envs by id-prefix, host capacity via injectable `hostInfo` (defaults
  to `os.cpus().length` / `os.totalmem()`).
- `remote-server.ts`: `GET /stats` (Decision 6); `remote-client.ts`:
  `getHostStats()`.
- Tests: argv/parse units (formats, units, garbage lines); fake-runtime
  sandbox mapping (prefix match, foreign containers dropped, non-ready envs
  excluded); loopback route round-trip + 404-without-support.

### B. Usage-aware ranking (multihost + boot)

- `multihost.ts`: per-host sample cache; `sampleStats(now?)` — one tolerant
  round (per-host failures log and keep the old sample until stale);
  `startStatsSampling(intervalMs)` → stop fn; `place()` blends fresh live
  fractions into the score per Decision 3 (budget denominators when
  declared, reported capacity otherwise).
- `statsIntervalFromEnv` (`SANDBOX_STATS_INTERVAL_MS`, positive integer ms;
  unset/0 = off; garbage refuses loudly at boot).
- `boot.ts`: fleet mode starts the sampler when configured; `close()` stops
  it. Local mode ignores the knob (there is nothing to rank).
- compose/.env.example/README knobs.
- Tests: fresh-sample demotion (hot host loses a tie it would have won on
  grants), stale fade-back to grant ranking, sampler tolerance (a failing
  host keeps its last sample, then stales out), off-by-default byte-for-byte
  M12 behavior, admission unaffected by any sample.

### C. Docs closeout

- roadmap: M16 landed; M17+ seeded (leftovers, incl. the deliberately
  unpaid halves: usage admission/eviction, disk).
- architecture.md: one paragraph (host stats read, ranking blend).
- README status paragraph; .env.example knob.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** parsers; sandbox mapping over
  a fake runtime; multihost ranking/staleness/tolerance over fake host
  cores; loopback HTTP for the new route and client method.
- **Live-Docker itest:** extend the existing suite with one stats read
  against the real daemon (fields present, our env attributed) — the same
  self-skip discipline as every live check since M1.
- **Pg itest:** untouched — nothing here goes near the database.

## Risks / notes

- **A stats sample is a lie by the time it is read.** Accepted by
  construction (Decision 3): the signal only ever demotes, admission never
  consults it, and stale samples fall away. The failure mode of a wrong
  sample is one placement that M12 would have made anyway.
- **`docker stats` is slow (~1–2s).** Off the placement path (Decision 4);
  the sampler round is sequential per host but concurrent across hosts is
  unnecessary at N≤handful — a round costs seconds against an interval of
  tens of seconds.
- **Shared daemons under-attribute.** Foreign containers' load appears in
  no per-env row (Decision 5). The physical denominators still reflect the
  whole machine, so a co-tenanted host's live fractions UNDERSTATE its
  heat rather than overstate — conservative in the direction that only
  costs efficiency, never correctness.
- **One more knob.** Off by default, fleet-only, same parse-or-refuse
  discipline as every `SANDBOX_*` before it.
