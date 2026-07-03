# M8 — Expansion III: multi-host foundations (implementation plan)

Design of record for M8. This milestone does the one thing the roadmap said
must anchor it: **the in-process exec stream goes over the network** (top-risk
#1), and multi-host **placement/capacity/drain** lands on top of it. After M8
the orchestrator can drive a fleet of sandbox hosts — each running
sandbox-core-svc against its own Docker daemon — while agent-runner, the
orchestrator FSM, and both chat adapters are untouched, because the whole
change hides behind the two seams the codebase already drew: `SandboxCore`
(the orchestrator's sandbox handle) and `ExecProvider` (agent-runner's single
DOWN dependency).

> Prereqs already landed: the M1 full-duplex `ExecStream` with kernel-enforced
> backpressure (`process-stream.ts` — "the real (gRPC/WS over docker exec)
> stream" it anticipated is this milestone); `ExecFrame` in the contracts,
> base64-armored for JSON transport from day one; the M6 internal-API bearer
> discipline (`DEVSPACE_INTERNAL_TOKEN`, timing-safe, both directions); the M7
> preview-proxy Upgrade handling (404-before-dial, splice-don't-parse) whose
> shape the exec wire reuses.

## Scope

In (per roadmap M8+):

- **Remote sandbox surface.** sandbox-core-svc's HTTP routing moves out of the
  app into the package (`remote-server.ts`) so it is testable over loopback,
  and the whole surface (except `/health`) gains the internal bearer token.
- **Exec stream over the wire.** A `devspace-exec` HTTP Upgrade endpoint
  carries the full-duplex stream as ndjson `ExecFrame`s with **end-to-end
  backpressure preserved** — TCP's window replaces the OS pipe as the
  kernel-enforced middle, and the M1 watermark channel sits at both rims.
- **`RemoteSandboxCore`.** A client implementing the complete `SandboxCore`
  interface against a remote sandbox-core-svc — lifecycle/fs/ports over JSON,
  exec over the upgrade — so "remote" is a constructor swap, not a refactor.
- **Multi-host placement.** `MultiHostSandboxCore` composes N named hosts:
  capacity-bounded least-loaded placement, sticky env→host routing with
  cold-miss rediscovery (an orchestrator restart must not orphan live envs),
  and drain (a draining host takes no new envs but keeps serving its own).

Out (seeded to M9, with rationale):

- **NATS bus.** M8's multi-host is _sandbox_ hosts; the event bus stays a
  single-orchestrator concern and Postgres LISTEN/NOTIFY already survives the
  split. NATS pays for itself when the _orchestrator_ scales out; `EventBus`
  remains the seam.
- **mTLS / per-service identity.** Deployment layer replacing the shared
  token (m6-plan Decision 3) — unchanged by this milestone; the sandbox hosts
  simply join the same bearer regime until then.
- **Warm pools / prebuilt placement hints.** Cold-start work (top-risk #4)
  deserves its own milestone once placement exists to hang it on.
- **Discord Forum dashboard.** Presentation upgrade over `/sessions`; still
  not a gap.

## Decisions

1. **The wire is ndjson `ExecFrame`s over an HTTP/1.1 Upgrade — no gRPC, no
   WebSocket framing.** The roadmap's default answer to top-risk #1 was "gRPC
   bidi w/ flow control"; what actually matters is a _byte channel with
   kernel-enforced flow control in both directions_, and a raw upgraded TCP
   socket IS that channel — with zero new dependencies (the repo has none and
   M5/M6/M7 kept it that way). `ExecFrame` has been base64-armored for JSON
   transport since M0, so the framing is one `JSON.stringify` + newline per
   frame. WebSocket framing would add masking/opcode ceremony for no benefit
   on an internal, token-authed link; gRPC would add a code generator and a
   runtime for a stream we already have contract types for.
2. **Backpressure survives the wire because both rims re-apply the M1
   discipline.** Server→client: the server pulls the container's frames with
   the ordinary consumer loop and honors `socket.write() === false` with a
   `drain` wait — a slow reader stops the pull loop, the M1 channel crosses
   its high-water mark, pauses the pipes, and the kernel blocks the producer.
   Client→server: the exported `FrameChannel` (the M1 watermark channel,
   now a public primitive) buffers inbound frames and pauses/resumes the
   _socket_, so TCP's receive window closes against the server. stdin runs
   the same protocol mirrored. No hop buffers unboundedly.
3. **Everything checkable is checked before the 101.** Bearer token, env
   existence, env readiness — all answered as plain HTTP (401/404/409) on the
   not-yet-upgraded socket, mirroring the preview proxy's 404-before-dial.
   The `ExecRequest` itself is the FIRST ndjson line the client sends _after_
   the upgrade — not a header — because `launchCommand` env carries the LLM
   key and headers leak into logs. Post-upgrade failures (bad first line)
   are an in-band `stderr` frame + `exit -1`, the same shape M1 gave spawn
   errors.
4. **The client-side control frames are contract, not module-private.**
   `stdin` reuses the existing `ExecFrame` variant; `stdin_close` and `kill`
   are new (`ExecClientFrameSchema`). They cross a service boundary
   (orchestrator-svc ↔ sandbox-core-svc), and the contracts package is the
   single source of truth for exactly that surface. Server→client frames are
   the existing `ExecFrame` minus `stdin`.
5. **The svc keeps working tokenless — but exec never does, in either form.**
   With `DEVSPACE_INTERNAL_TOKEN` set, every route except `/health` requires
   the bearer (timing-safe, the M6 helper's discipline). Unset, the
   fs/lifecycle JSON surface stays open exactly as it has been since M1 (a
   local ops/debug surface on a trusted network) — but BOTH exec paths refuse
   with 503: the upgrade stream and the JSON capture exec alike inject
   per-env secrets and do not run unauthenticated, ever. Fleet mode therefore
   _requires_ the token by construction.
6. **Placement is least-loaded with a per-host cap, and it is deliberately
   dumb.** Fewest live envs wins; ties break in config order; draining and
   full hosts are skipped; no host ⇒ `PROVISION_FAILED` with a message that
   names the reason (all draining vs. at capacity). Bin-packing, affinity,
   and cost models belong to the warm-pool milestone; what M8 must get right
   is the _seam_ — placement lives entirely inside `MultiHostSandboxCore`,
   so a smarter scheduler is an internal swap.
7. **Routing is in-memory with cold-miss rediscovery, matching the existing
   persistence posture.** `DevcontainerSandboxCore` has always kept its env
   table in memory; the remote hosts now durably _are_ that table (they hold
   the containers). On a routing miss the multi-host core probes each host's
   `GET /environments/:id` and adopts the hit, so an orchestrator restart
   re-learns its fleet lazily instead of orphaning envs. Probing is O(hosts)
   on a miss only — misses are rare (restart or genuinely-unknown id).
8. **Fleet mode is a config flip and the default stays zero-config
   in-process.** `SANDBOX_HOSTS=name=url[|capacity][|drain],…` +
   `DEVSPACE_INTERNAL_TOKEN` switches `bootOrchestrator` to
   `MultiHostSandboxCore` over `RemoteSandboxCore` clients; unset, the M4
   demo boot is byte-for-byte unchanged. In fleet mode the orchestrator
   starts NO local hardening assert, egress proxy, or preview proxy — those
   are host policy and run where the daemon runs (each sandbox host's svc
   already boots all three). `forwardPort` URLs come back from the owning
   host's preview proxy, which is exactly where the route lives.

## Workstreams

### A. Remote sandbox control plane (server side)

- `remote-server.ts`: the svc's routing moves into the package as
  `createSandboxRequestHandler(core, opts)` (health, env lifecycle, capture
  exec, fs, ports, zod-validated, `SandboxError`→status mapping) plus
  `createSandboxUpgradeHandler(core, opts)` for the exec wire (workstream B).
  `verifyBearer` is reimplemented locally (sandbox-core cannot import the
  orchestrator package — the dependency points the other way).
- Token gating per Decision 5; `opts.token` from `DEVSPACE_INTERNAL_TOKEN`.
- apps/sandbox-core-svc/main.ts shrinks to config + proxies + two `createServer`
  wires — the Bolt-internals line, redrawn once more.
- Tests: loopback HTTP against a fake `SandboxCore` — every JSON route round-
  trips; 401 on bad/missing bearer when the token is set; tokenless mode keeps
  JSON open and refuses the upgrade with 503.

### B. The exec wire + RemoteSandboxCore (client side)

- Protocol (in `remote-protocol.ts`): `GET /environments/:id/exec` with
  `Upgrade: devspace-exec`. Pre-101 checks per Decision 3. Post-101, client
  sends one `ExecRequest` line then `ExecClientFrame` lines; server sends
  `ExecFrame` lines, `exit` always last, then FIN. `kill` forwards to the
  underlying stream's `kill()` (the docker-exec caveat applies unchanged and
  is documented at the schema — agent-runner's abort path already uses
  `killCommand()` execs, not this).
- Server pump: inbound socket lines → `writeStdin` honoring `false`+`drain`
  with the socket paused meanwhile; outbound frame loop honoring
  `socket.write` false + `drain` (Decision 2). Either side's error/close
  kills the local stream and destroys the socket — no half-open pumps.
- `remote-client.ts`: `RemoteSandboxCore implements SandboxCore`. JSON ops
  via `node:http(s)` requests with NO client timeout — global fetch (undici)
  imposes a 300s headersTimeout that would sever a slow `createEnvironment`
  and orphan the remote container; `exec()` via the `http.request` upgrade
  returning a real `ExecStream` whose inbound side is a `FrameChannel`
  pausing/resuming the socket. A connection lost before `exit` synthesizes
  `stderr("connection lost") + exit -1` — the M1 spawn-error convention.
  Error envelopes map back to `SandboxError` codes.
- `process-stream.ts`: `FrameChannel` becomes exported (unchanged semantics).
- Tests (loopback, CI-safe, no Docker): full exec round-trip against a fake
  core backed by REAL `spawnExecStream` children (`cat` echo with binary
  bytes; exit codes; stderr separation); **backpressure end-to-end** — an
  unbounded counted producer behind the server plateaus while the client
  consumer parks (measured at the source, the M1 proof restated over TCP);
  `kill` frame terminates a live child through the wire; 404/409/401 before
  upgrade; connection-drop synthesis; large stdin round-trip (drain path).

### C. Multi-host placement

- `multihost.ts`: `SandboxHost { name, core, capacity, draining }`,
  `MultiHostSandboxCore implements SandboxCore` (Decisions 6–7): placement in
  `createEnvironment`, sticky routing for exec/fs/ports/destroy with
  rediscovery on miss, `setDraining(name, bool)`, `hostOf(envId)` for
  introspection. Capacity = live routed envs; destroy frees the slot.
- `parseSandboxHosts` / `sandboxHostsFromEnv`: `name=url[|capacity][|drain]`
  comma list; malformed entries throw at boot (config errors fail fast, the
  hardening precedent). Default capacity 8.
- `bootOrchestrator`: fleet mode per Decision 8. `OrchestratorBootConfig`
  gains `sandboxHosts` / `internalToken` overrides (tests inject fakes).
- compose.yaml: commented `SANDBOX_HOSTS` example on the orchestrator.
- Tests: fake-core hosts — least-loaded + tie order; capacity exhaustion and
  all-draining produce distinct `PROVISION_FAILED` messages; drain blocks new
  placements but existing envs still route; cold-miss rediscovery adopts and
  counts toward capacity; destroy frees; parser accept/reject table.

### D. Docs closeout

- roadmap: M8 landed; M9 seeded (NATS, mTLS, warm pools, Forum dashboard —
  rationale restated). Top-risk #1 marked answered by this design.
- architecture.md: the sandbox tier is now 1..N hosts; one paragraph.
- README status paragraph; sandbox-core-svc header comment loses its
  "consumed IN-PROCESS … not exposed over the network" caveat.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above — the remote
  suites run over real loopback HTTP/TCP with real child processes for the
  stream tests (the M1 discipline: transport-agnostic logic exercised for
  real), fakes for the core; multihost over fake cores; parser tables.
- **Live-Docker itest:** unchanged. The remote layer adds no
  container-specific behavior — it transports the same streams the live
  suite already proves against a daemon.
- **Not tested live:** a real two-machine fleet (needs two daemons; the
  loopback suite exercises the identical code path over the identical wire).

## Risks / notes

- **The exec wire is a long-lived connection per agent session.** Same class
  as M7's spliced WS previews: acceptable at current scale, accounted per
  host by the capacity cap (an env is the unit that owns connections).
- **Capacity counts envs, not resources.** cpu/mem-aware placement needs
  host-side accounting that belongs with warm pools (M9+); the cap prevents
  the pathological case (one host absorbing the fleet) today. In-flight
  placements are reserved (a concurrent burst cannot pile onto one host),
  and stale routes are evicted when a host stops knowing an env — but an
  orchestrator RESTART still zeroes the counted load until old envs are
  lazily re-adopted, so a burst right after a restart can over-place onto a
  full host. Host-side capacity enforcement (or a boot-time census) closes
  that window and is seeded to M9 with the rest of resource-aware
  scheduling.
- **Rediscovery trusts host answers.** Two hosts claiming one envId cannot
  happen from this codebase (ids are host-generated UUIDs); first hit wins
  and is sticky, so even then behavior is deterministic.
- **The agent-runtime volume must exist on every sandbox host**
  (`infra/images/agent-runtime/publish.sh` runs per host — same ADR-0003
  mechanics, now ×N). Deployment note, not code.
