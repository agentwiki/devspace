# M22 — Expansion XVII: per-environment egress policy (implementation plan)

Design of record for M22. The gap analysis has carried "네트워크 접근 레벨
(none/trusted/full/custom) — 계약에 필드 없음" as a contract-stage item since
M1 ("필드·데이터는 지금 확정" — expensive to change later), and M5 built the
enforcement machinery it needs: every hardened env sits on its own
`--internal` network whose only door out is the allowlist proxy. What M5 left
uniform, M22 makes per-environment: a `CreateEnvironmentRequest` can now
carry an egress policy of its own — **no egress at all, or an explicit
narrowing of the operator's allowlist** — enforced at the proxy, per
network, for the whole life of the env. One contract extension (two optional
request fields, echoed nowhere), one proxy capability (per-gateway scopes),
one migration (the work unit remembers the choice for resume), and the
`net=` repo-choice ergonomics on both adapters.

> Prereqs already landed: the egress allowlist proxy + `--internal` per-env
> networks with gateway resolution (M5), the durable host env table + boot
> recovery (M11), warm-pool canonical template keys (M9/M10), the M19 resume
> re-provision path, and the shared `parseRepoChoice` both adapters use (M4/M6).

## What M22 fixes

1. **Egress policy is all-or-nothing per deployment.** The M5 proxy holds ONE
   allowlist for every tenant env on the host. A tenant running untrusted or
   analysis-grade work cannot ask for a no-egress env; a security-sensitive
   repo cannot be pinned to "GitHub only, no LLM/npm egress". CCW ships
   network access levels per environment; devspace has no field for it.
2. **The gap is contract-shaped and gets more expensive every milestone.**
   Warm-pool canonical keys, the durable host table, and the resume
   re-provision path all serialize `CreateEnvironmentRequest` — retrofitting
   the field later means re-keying warm stock and re-migrating state files.
   Landing it now, as optional-absent, keeps every existing key byte-stable.

## Scope

In:

- **Contract: the request narrows, never widens.** `networkAccess?: 'none' |
  'custom'` + `allowedHosts?: string[]` on `CreateEnvironmentRequest` (and on
  `RepoChoice`). Absent = the host's full operator allowlist — pre-M22
  behavior, and absent keys keep canonical pool keys byte-identical. `'none'`
  = zero egress. `'custom'` = exactly `allowedHosts`, each of which must be
  **covered by** the operator allowlist; an uncovered entry refuses loudly at
  provision. The M5 principle ("a tenant request cannot weaken its own
  sandbox") extends, not bends: hardening stays off the request, and the new
  fields can only subtract.
- **Enforcement at the proxy, per network gateway.** `EgressProxy` learns
  scopes: `setScope(clientAddr, allowlist)` / `clearScope(clientAddr)`, keyed
  by the LOCAL address a connection arrived on. An `--internal` network
  reaches the host only at its own bridge gateway, so the dialed address
  identifies the env — no headers, no tokens, nothing the container can
  forge. Unscoped connections keep the default allowlist (byte-for-byte M5).
- **The scope lives and dies with the env.** The provisioner registers it
  the moment the gateway resolves (before `up` — the container is never
  alive unscoped) and clears it in the same failure cleanup that removes the
  network; `destroyEnvironment` clears it with the network; the resolved
  scope + gateway join the M11 persisted slice and `recover()` re-registers
  them — a host restart must not degrade a no-egress env to the default
  allowlist.
- **Honor-or-refuse.** A request carrying `networkAccess` provisions only
  where it is enforceable: per-env networks + a gateway-addressed proxy
  (`egressProxyPort`) + a live scope registrar. Demo mode, shared named
  networks, and static `egressProxyUrl` (one gateway for every env — nothing
  to key a scope on) refuse with a clear error. A tenant who asked for
  `none` must never silently get the default.
- **Tenant surface + resume parity.** `/devspace <repo> [ref] [net=none |
  net=host1,host2]` on both adapters (the shared parser); the orchestrator
  passes the choice onto the env request AND persists it on the work unit
  (migration 0007), so the M19 resume re-provision carries the same policy —
  a resume must never silently widen egress.

Out (seeded to M23+, with rationale):

- **Tenant-supplied extra hosts (widening).** CCW's "custom domains" let a
  user ADD hosts; under the M5 trust model that is an operator decision, not
  a request field. An operator widens by extending `EGRESS_ALLOWLIST`; a
  per-tenant widening ceiling (e.g. `SANDBOX_TENANT_HOSTS`) is its own
  policy feature with its own review.
- **Per-env scoping on shared/static-proxy topologies.** Scoping keys on the
  per-env gateway; deployments on one shared network would need proxy
  credentials or source-IP tracking — different machinery, different risks.
  Refusal (never silent fallback) keeps those deployments correct today.
- **Repo-picker modal field.** The bare-`/devspace` modal keeps the default
  egress; a network input on the modal is additive UI for the milestone that
  wants it (chat-platform-ui-parity discipline — the command form is the
  canonical ergonomics, as with `!port`).
- **Mid-session policy changes.** The scope is fixed at provisioning like
  every other env-shaping field; "re-scope a live env" is applySecrets-like
  surface with real security review (who may widen?) — not needed for the
  gap being closed.

## Decisions

1. **Optional-absent fields, not defaulted ones.** Zod `.optional()` without
   `.default()`: a request that doesn't use the feature parses to an object
   WITHOUT the keys, so `canonicalRequestKey` — and therefore every pool key
   stamped on live warm stock — is byte-identical across the upgrade. (A
   defaulted field would orphan all pre-M22 pool marks: the M10 orphan sweep
   only re-adopts keys it can regenerate.)
2. **`'custom'` must be covered, never intersected.** Each `allowedHosts`
   entry must be allowed by the operator allowlist (exact hosts by
   `hostAllowed`; a `*.suffix` request entry only by an equal-or-broader
   wildcard). An uncovered entry throws at provision, naming the entries — a
   silent intersection would hand the tenant a quietly different policy than
   they asked for (the no-silent-caps discipline).
3. **Scopes key on the connection's local address.** The container cannot
   forge which gateway it dialed through — routing on an `--internal`
   network is the kernel's, not the workload's. No per-env proxy
   credentials (secret material in env vars, visible to every process in the
   env), no remote-IP subnet table (NAT-sensitive). IPv4-mapped IPv6 forms
   (`::ffff:a.b.c.d`) are normalized on both set and lookup.
4. **'none' still injects the proxy vars.** A no-egress env keeps
   `HTTP(S)_PROXY` pointed at its gateway: the scope denies everything, so
   proxy-polite tools fail fast with a 403 instead of hanging on a dead
   route, and the enforcement story stays single (the proxy decides;
   the missing route remains the backstop for proxy-ignorant processes).
5. **Recovered scopes are the env's birth policy.** The persisted slice
   stores the RESOLVED allowlist (hostnames — sizes and names, no secrets),
   and recovery re-registers exactly that. Recomputing from the operator's
   current `EGRESS_ALLOWLIST` could silently widen or narrow a live env
   across a restart; policy changes apply to envs provisioned after them. A
   scoped state file recovered on a host with NO registrar (proxy since
   disabled) is discarded like any other unenforceable record — never
   re-adopted unscoped.
6. **The work unit remembers the choice.** `networkAccess`/`allowedHosts`
   persist on the work unit at repo choice (additive migration 0007) and the
   M19 resume re-provision request carries them. Without this, resuming a
   `none` session would silently rebuild it with full default egress — the
   exact failure mode Decision 2 exists to prevent, one hop later.
7. **In-process boots gain the proxy they already pointed at.** With
   `EGRESS_PROXY_PORT` set, `bootOrchestrator`'s local branch now starts the
   `EgressProxy` itself (sandbox-core-svc already did) and wires it as the
   scope registrar — previously the in-process hardened boot injected proxy
   env pointing at a port nobody served. Fleet mode is untouched: hardening,
   proxy, and scopes are each sandbox host's own concern, and the request
   fields ride the existing JSON surface to them.
8. **Invalid `net=` never silently widens.** `net=` with an empty value
   makes the whole repo choice empty (nothing is created; the user retypes)
   — the parser's existing not-a-repo posture. Dropping the token instead
   would provision with WIDER egress than the tenant just asked for.

## Workstreams

### A. Enforcement (contracts + sandbox-core)

- contracts: the two optional fields + a superRefine (`custom` requires a
  non-empty `allowedHosts`; `allowedHosts` requires `custom`).
- egress-proxy.ts: `coveredByAllowlist(entry, allowlist)` (pure);
  `EgressScopeRegistrar` interface; scope map on `EgressProxy` consulted in
  both the CONNECT and absolute-form paths (local-address keyed, normalized).
- provision.ts: pure `effectiveEgressAllowlist(req, operatorAllowlist)`
  (absent → undefined, none → [], custom → validated list, uncovered →
  throws); provisioner takes `egress?: EgressScopeRegistrar`, refuses
  unenforceable requests, registers the scope when the gateway resolves,
  clears it in the failure cleanup; `ProvisionResult` grows
  `egressGateway`/`egressScope`.
- sandbox.ts / env-state.ts: the record + persisted slice carry
  gateway+scope; destroy clears the scope with the network; recover
  re-registers (or discards when unenforceable). Core takes `egress` and
  forwards it to its default provisioner.
- wiring: sandbox-core-svc passes its proxy as the registrar;
  bootOrchestrator's local branch starts one when `egressProxyPort` is set
  (Decision 7) and stops it in `close()`.
- Tests: covered-by table; scoped proxy over loopback (scope enforces, clear
  restores default, second local address isolated); effective-allowlist
  table; provisioner refusal matrix + register/cleanup order; destroy/recover
  scope lifecycle over fakes; state-file roundtrip incl. pre-M22 files;
  canonical-key stability (absent fields) + distinctness (present fields).

### B. Tenant surface (chat-gateway + orchestrator + db)

- chat-gateway: `parseRepoChoice` learns `net=` (`none` | comma list; Slack
  link unwrapping per host; empty value → empty choice per Decision 8); both
  adapters inherit (shared parser).
- contracts: `RepoChoice` + `WorkUnit` gain the two optional fields.
- db: migration 0007 (`network_access` text, `allowed_hosts` jsonb) + the
  patch-column/row mappings; in-memory repo is already generic.
- orchestrator: `onConversationCreated` persists the choice on the unit and
  passes it to `createEnvironment`; `onResumeWork` re-provisions with the
  persisted policy.
- Tests: parser table (both net forms, ref interplay, Slack link syntax,
  empty value); handler passes fields to the sandbox and persists them;
  resume request carries them; Pg mapping in the itest.

### C. Docs closeout

- roadmap: M22 landed; M23+ seeded (carried seeds + widening-ceiling note).
- architecture.md: "Since M22" paragraph; security.md egress section update.
- README status; gap analysis: 네트워크 접근 레벨 항목 갱신.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** proxy scopes over real
  loopback sockets (the M5 discipline — a boundary is tested with sockets,
  not mocks); pure covered-by/effective-allowlist tables; provisioner over a
  fake CommandRunner; core lifecycle over fake provisioner/runtime; parser
  and adapter fixtures; orchestrator handler flows over in-memory repos.
- **Pg itest:** work-unit round trip with the new columns.
- **Live-Docker itest:** untouched — the per-env network + gateway machinery
  it exercises is unchanged; scoping rides the resolved gateway it already
  proves.

## Risks / notes

- **Upgrade drift on warm stock: none by construction** (Decision 1), but
  operators who START using `networkAccess` in pool templates re-key those
  pools — old unmarked-for-that-key stock is foreign to the new key and is
  neither adopted nor destroyed by it (the standing cross-version posture;
  drain or let idle reclamation collect it).
- **A scope is only as per-env as the network topology.** Two envs sharing a
  gateway would share a scope — exactly why non-per-env topologies refuse
  the fields (Decision 3 / Scope). The per-env invariant is M5's, not new.
- **Operator allowlist changes don't retro-apply** (Decision 5): tightening
  `EGRESS_ALLOWLIST` narrows future envs only. Live envs keep birth policy
  until reprovisioned — documented; the alternative (silent live mutation)
  is worse in both directions.
- **`!history`-style discoverability:** `net=` is documented in the README
  and refusals name the accepted forms; a wrong token costs a retype, never
  a wider-than-asked env (Decision 8).
