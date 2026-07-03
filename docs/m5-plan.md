# M5 — Hardening (implementation plan)

Design of record for M5. Turns the demo-grade M0–M4 stack into something that
can face real multi-tenant users: kernel-level tenant isolation (gVisor/Kata),
deny-by-default egress with an allowlist proxy, enforced per-turn budgets with
a **real** auto-abort, guardrail auto-deny at the permission gate, an
append-only audit log of every privileged operation, GitHub webhooks as the PR
source of truth (poll demoted to reconciliation), and pattern-based redaction
as a second defense-in-depth layer. `docs/security.md` calls these items
"release-blocking before real users" — this milestone is that list.

> Prereqs already landed: the M1 provisioner (`mergeDevcontainerConfig` +
> `resourceRunArgs` seams), the M2 ACP client/permission gate + the guardrail
> policy module (checks exist, enforcement deferred), the M3 secret store /
> redaction registry / poll reconciler / bus, and the M4 wiring. M5 hardens
> these paths; it adds **no new product feature** and (deliberately) **zero
> changes to `@devspace/contracts`** — every addition is host-side policy, an
> agent-runner internal, or a db repo.

## Scope

In (per roadmap M5 + explicitly deferred-to-M5 items):

- **gVisor/Kata runtime profile** + the rest of the container hardening list
  from `docs/security.md`: `no-new-privileges`, dropped capabilities, per-env
  network, and the M1-deferred opt-in disk quota (`--storage-opt size=`).
- **Egress allowlist**: per-env `--internal` docker network (no route out) +
  a host-side allowlisting HTTP(S) CONNECT proxy as the only door.
- **Turn budgets + auto-abort** (`maxToolCallsPerTurn`, `turnWallClockMs`),
  honoring the roadmap caveat: abort is in-container termination, never
  `ExecStream.kill()` alone.
- **Guardrail enforcement / auto-deny** at the ACP permission gate (deferred
  from M2/M3): denied commands and protected-path writes never park for a
  human — they are rejected immediately.
- **Audit log**: append-only `audit_log` table; the orchestrator records every
  privileged op (secret resolution, approval decisions, push/PR, teardown,
  webhook ingress, aborted turns).
- **GitHub webhooks**: signature-verified `pull_request` ingress mapped onto
  the existing idempotent bus topics; the poll reconciler stays as the drift
  backstop (top-risk #7: "webhooks as source of truth; gh poll
  reconciliation").
- **Pattern-based redaction**: well-known token shapes (`ghp_…`,
  `github_pat_…`, `sk-…`, `xox…`) scrubbed even when the value was never
  registered.

Out (deferred):

- **Ports preview proxy → M6.** It is a product feature (authenticated preview
  URLs), not release-blocking hardening — and the M5 egress posture makes it a
  genuine design item (ingress must route through the control plane, which is
  exactly the M6 HTTP-split work). `forwardPort` keeps rejecting with a clear
  message. The UI surface stays chat-only regardless
  (docs/analysis/chat-platform-ui-parity.md).
- **seccomp/AppArmor custom profiles.** gVisor intercepts syscalls below the
  default seccomp layer; a bespoke profile on top is tuning, not a boundary.
  Docker's defaults stay on (we never pass `--privileged` or
  `seccomp=unconfined`).
- **rootless dockerd / userns-remap** — a deployment-doc concern
  (daemon-level, not per-container flags we can inject).
- **In-chat secret entry, modal repo picker, Discord, HTTP split** (M6, per
  the M4 deferral list).

## Decisions

1. **Hardening is host policy, not caller choice.** All of it — runtime class,
   caps, network, disk quota, proxy env — lives in a `SandboxHardening` config
   on the _provisioner_ (sourced from service env at boot), never on
   `CreateEnvironmentRequest`. A tenant request cannot weaken its own sandbox;
   a compromised orchestrator caller cannot opt out of gVisor. This is also
   why contracts don't change.
2. **Isolation flags are injected runArgs; availability is asserted at boot,
   not at provision time.** `--runtime=runsc` (or `kata-runtime`) is one more
   entry from the existing `resourceRunArgs` seam. CI has no gVisor, so the
   builders are pure/unit-tested and `assertRuntimeAvailable()` (a
   `docker info` parse) runs once at service boot — fail fast with a clear
   message instead of a cryptic `devcontainer up` failure per env. Plain-Docker
   remains the explicit default for the local demo (security.md's "demo only"
   caveat), enabled↔hardened is a config flip.
3. **Egress = no route by default; the proxy is the only door.** Each env gets
   its own `--internal` bridge network (no NAT out, and per-env networks deny
   env↔env traffic). The allowlist proxy is a host process reachable at the
   bridge gateway address; `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` are injected
   via devcontainer `containerEnv` so every process in the env inherits them.
   Enforcement does **not** depend on processes being proxy-polite — a
   non-cooperating process simply has no route. The proxy allowlists by exact
   host or `*.suffix` (github.com, the LLM endpoint, registries; the composed
   default list is exported and documented). It is our own ~150-line Node
   CONNECT/forward proxy: no new runtime dependency, and — unlike a squid
   config — unit-testable over loopback sockets in CI (no external egress
   needed, which CI forbids anyway).
4. **Budgets are enforced where the stream flows (agent-runner), and abort is
   real termination.** `DefaultAgentRunner.runTurn` wraps the session stream
   in a budget guard (injected clock — deterministic tests): breach ⇒ stop
   forwarding, `abortSession` = cancel parked permissions + ACP
   `session/cancel` + **in-container kill** via the backend's new
   `killCommand()` exec'd through the ordinary `ExecProvider`
   (`pkill` on the agent binary path) — per the roadmap caveat,
   `ExecStream.kill()` only signals the local `docker exec` client, so it is
   never the mechanism. The consumer sees a final
   `turn_end { reason: 'aborted' }`; the orchestrator already renders that.
5. **Auto-deny happens at the gate, silently to the human.** The ACP
   `requestPermission` handler consults `checkCommand`/`checkFileWrite`
   _before_ parking. A policy-denied operation resolves as rejected
   immediately and emits a plain `message` AgentEvent explaining the denial —
   **no** `permission_request` is emitted, so no approval buttons appear for
   something no human is allowed to approve anyway.
6. **The audit log is an append-only repo with one writer.** New `audit_log`
   table + `AuditRepo` (`append`, `listByConversation`), mirrored in-memory ↔
   Pg like every other repo. The orchestrator is the only writer and audits at
   the moment of the privileged effect (secret resolved, decision forwarded,
   push+PR executed, teardown/revoke, webhook accepted, turn aborted). Detail
   payloads are constructed from ids and names only — **never** secret
   plaintext, so the log needs no redaction pass.
7. **Webhooks reuse the bus topics; matching needs no new repo surface.** The
   svc endpoint verifies `X-Hub-Signature-256` (HMAC-SHA256 over the **raw**
   body, `timingSafeEqual`) and hands the parsed event to
   `Orchestrator.handleGitHubWebhook`, which maps
   `pull_request closed(+merged)` onto the existing `TOPIC_PR_MERGED/CLOSED`
   bus publishes for the matching unit — found by normalized `repoUrl` +
   `prNumber` over `listByState('PR_OPEN')` (open PR count is small; no new
   index or repo method). Redelivery is already safe: `handleBusEvent` →
   `advance` is idempotent. The poll reconciler is unchanged code-wise and
   demoted to a long-interval reconciliation backstop.

## Contract surface added

- `@devspace/contracts`: **nothing.**
- `packages/db`: `AuditRepo` + `Repositories.audit`; `audit_log` table +
  generated migration. (In-memory + Pg, itest round-trip — M3 discipline.)
- `packages/sandbox-core`: `SandboxHardening` (provisioner option), the pure
  arg/config builders, `assertRuntimeAvailable`, and `EgressProxy`
  (start/stop + allowlist) — all host-side exports, no contract types.
- `packages/agent-runner`: `AgentBackend.killCommand()`; `AgentRunner.
abortTurn(agentSessionId)` (interface + fakes); budget options on
  `AgentRunnerDeps` (policy + injected clock).
- `packages/orchestrator`: `handleGitHubWebhook(evt)`; optional `audit` write
  path threaded through existing handlers; `verifyWebhookSignature` +
  payload mapping as pure exports.

## Workstreams

Shape: A → B are sequential inside sandbox-core (B injects env through A's
config plumbing); C, D, E are independent siblings; F closes docs + the last
redaction layer. Lettered commits, one per workstream, like M4.

### A. sandbox-core — hardened runtime profile

- `hardening.ts`: `SandboxHardening` = `{ runtime?: 'runsc' | 'kata-runtime',
noNewPrivileges, capDrop / capAdd, networkName?, enforceDiskQuota,
extraRunArgs }` with a conservative `HARDENED_DEFAULTS` and a permissive
  `DEMO_DEFAULTS` (plain Docker, default bridge). Pure
  `hardeningRunArgs(hardening, resources)`:
  `--runtime=…`, `--security-opt=no-new-privileges`, `--cap-drop/--cap-add`,
  `--network=…`, and `--storage-opt size=<diskMB>m` **only** when
  `enforceDiskQuota` (driver-dependent — xfs+pquota; documented).
- `mergeDevcontainerConfig` gains `hardening?` + `containerEnv?` inputs;
  injected runArgs append after resource args (same never-clobber rule);
  `containerEnv` merges over the repo config's own.
- `assertRuntimeAvailable(runner, runtime)`: parse `docker info --format
'{{json .Runtimes}}'`; pure parser + injected runner. Called from boot paths
  when a runtime class is configured.
- Per-env network lifecycle: pure `dockerNetworkCreateArgs(name,
{ internal })` / `dockerNetworkRmArgs(name)`; `DevcontainerProvisioner`
  creates the network before `up` when hardening asks for per-env networks and
  removes it on failed provision; `DevcontainerSandboxCore.destroyEnvironment`
  removes it after the container (best-effort).
- Tests: every builder pure-asserted (flag-by-flag); merge precedence incl.
  containerEnv; runtimes-JSON parse (present/absent/malformed); provisioner
  sequences network-create → up and cleans up on failure (fake runner).

### B. sandbox-core — egress allowlist proxy

- `egress-proxy.ts`: `EgressAllowlist` (exact hosts + `*.suffix` wildcard,
  port-agnostic match, pure `isAllowed(host)`), and `EgressProxy`: a Node
  `http` server handling `CONNECT` (TLS passthrough tunnel) and absolute-form
  plain-HTTP forward; anything not allowlisted → `403` and the tunnel never
  opens. No auth header forwarding logic, no caching — ~150 lines, zero deps.
- `DEFAULT_EGRESS_ALLOWLIST` export: GitHub (github.com, api.github.com,
  codeload.github.com, *.githubusercontent.com), LLM endpoints
  (api.openai.com, api.anthropic.com), package registries
  (registry.npmjs.org). Deployment note: the **gateway** host additionally
  needs slack.com + wss-primary.slack.com (the m4-plan note) — that is the
  control plane's egress, not the sandbox's, and is documented rather than
  defaulted into tenant envs.
- `proxyContainerEnv(proxyUrl)` → `{ HTTP_PROXY, HTTPS_PROXY, http_proxy,
https_proxy, NO_PROXY }`, injected through A's `containerEnv` plumbing when
  hardening carries an egress proxy URL.
- Tests (loopback only, CI-safe): allowlist matcher table; CONNECT to an
  allowed host reaches a local upstream TCP server through the tunnel; CONNECT
  to a non-allowlisted host → 403 and no upstream connection; plain-HTTP
  forward allowed/denied; env-map builder.

### C. agent-runner — budgets, real abort, auto-deny

- `budget.ts`: `guardTurn(stream, policy, clock, onBreach)` — an async
  generator wrapper counting `tool_call` events and checking wall-clock at
  each event; on breach invoke `onBreach(reason)` once, stop forwarding, and
  emit `turn_end { reason: 'aborted' }`. Injected `clock()` so tests never
  sleep.
- `DefaultAgentRunner`: sessions remember their `envId` + backend already;
  `abortTurn(id)` = `session.abort()` (cancel parked permissions + ACP
  `session/cancel`) **then** `exec(envId, backend.killCommand())` — the
  in-container `pkill` the roadmap caveat demands. `runTurn` returns the
  guarded stream with `onBreach = abortTurn`. Budget policy defaults to
  `DEFAULT_POLICY`, overridable via deps.
- `codexBackend.killCommand()`: `pkill -f '<AGENT_RUNTIME_PATH>/codex-acp'`
  (matches the launch argv; SIGTERM, `|| true` so an already-dead agent is a
  no-op).
- `AcpSession.abort()`: like `close()` minus stdin teardown (the session may
  outlive an aborted turn only long enough for the kill to land; a subsequent
  `runTurn` on an aborted session fails cleanly).
- Auto-deny: `DevspaceAcpClient.requestPermission` runs
  `checkCommand`/`checkFileWrite` (by `opForToolKind` + tool-call title)
  against the injected `GuardrailPolicy` first; denied ⇒ resolve
  `reject_once`/`cancelled` immediately + emit a `message` AgentEvent with the
  policy reason (Decision 5). Allowed-but-approval-required parks exactly as
  today.
- Tests: budget breach by tool-call count and by fake wall-clock (breach emits
  exactly one aborted `turn_end`, `onBreach` called once); `abortTurn` execs
  the backend kill command into the right env (fake ExecProvider) and cancels
  parked permissions (loopback agent); auto-deny per denied command/protected
  path (no `permission_request` emitted, agent receives the rejection);
  allowed ops still park.

### D. db + orchestrator — audit log

- Schema: `audit_log(id, at, user_id?, conversation_id?, work_unit_id?,
action, detail jsonb)` + indexes on conversation and action; regenerate the
  drizzle migration.
- `AuditRepo`: `append(entry)` / `listByConversation(conversationId)`;
  in-memory + Pg impls; `pg.itest.ts` round-trip extension.
- Orchestrator: private `audit(action, ctx)` helper (best-effort — an audit
  write failure logs and never fails the user path… **no**: audit of a
  _privileged_ op must not silently vanish; it awaits normally and only
  teardown's best-effort blocks stay best-effort). Audited actions:
  `secret.resolved` (name + purpose, never plaintext), `approval.decided`,
  `pr.pushed`+`pr.opened`, `teardown` (+`token.revoked`), `webhook.received`
  (E), `turn.aborted` (on seeing `turn_end aborted`). Handler tests assert the
  entries; a dedicated test proves no audit `detail` contains a registered
  secret plaintext.

### E. orchestrator(+svc) — GitHub webhooks

- `webhooks.ts` (orchestrator): `verifyWebhookSignature(secret, rawBody,
header)` (pure; `sha256=`-prefixed HMAC, `timingSafeEqual`, length-safe);
  `mapPullRequestWebhook(eventName, payload)` → `{ repoUrl, prNumber,
outcome: 'merged' | 'closed' } | null` (zod-parsed; everything else null,
  never throw).
- `Orchestrator.handleGitHubWebhook(mapped, publish)`: match `PR_OPEN` units
  by normalized repoUrl + prNumber (same normalizer as git.ts), publish the
  existing idempotent topics, audit `webhook.received`. Unmatched → no-op.
- `orchestrator-svc`: `POST /webhooks/github` — **raw body** captured for
  HMAC before JSON parse; secret from `GITHUB_WEBHOOK_SECRET` (endpoint
  disabled with a boot log when unset); bad signature → 401 (audited), valid → 202. Reconciler stays wired as the backstop (default interval lengthened).
- Tests: signature verify (valid/invalid/malformed/length-mismatch); payload
  mapping table (merged, closed-unmerged, opened→null, junk→null); handler
  publishes the right topic for the matching unit only + audits; svc endpoint
  401/202 paths with a fixture payload signed by the test secret.

### F. redaction patterns + docs

- `SecretRegistry.redact` gains a static pattern pass: `ghp_…`,
  `github_pat_…`, `gho_…`, `sk-…`, `xox[abps]-…` (well-known token shapes) →
  `«redacted»` even when never registered. Documented as best-effort
  defense-in-depth on top of value redaction — false positives (token-shaped
  strings in chat) are acceptable; the M5 egress proxy is the real
  exfiltration control.
- Docs: roadmap M5 section marked landed (with the ports-proxy → M6 deferral
  - rationale), M6 gains the preview proxy; security.md items ticked against
    their workstreams; `.env.example`/README notes for the new env
    (`SANDBOX_RUNTIME`, `EGRESS_PROXY_*`, `GITHUB_WEBHOOK_SECRET`).
- Tests: each pattern redacts inside surrounding text; non-matching text
  untouched; combined value+pattern pass.

## Testing strategy

- **Unit (no Docker/DB/network, `pnpm -r test` + CI):** every pure builder
  (hardening args, network args, runtimes parse, allowlist match, signature
  verify, webhook mapping, budget guard with fake clock, kill argv,
  redaction patterns), plus behavior seams over fakes (provisioner network
  sequencing, abort exec, auto-deny, audit writes, webhook handler).
- **Loopback integration (in `test`, CI-safe):** the egress proxy suite runs
  real sockets on 127.0.0.1 — genuine CONNECT tunneling, zero external egress.
- **Live-Docker itest (`sandbox.itest.ts`, self-skip + must-not-skip in CI):**
  extend with a hardened-flags provision (no-new-privileges + per-env internal
  network asserted via `docker inspect`; **not** gVisor — CI has no runsc) and
  an in-container kill round-trip (launch `sleep`, exec `pkill`, observe
  exit) proving the abort mechanism against a real daemon.
- **Postgres itest (`pg.itest.ts`):** audit repo round-trip; unchanged
  must-not-skip discipline.
- **Not tested live:** gVisor/Kata themselves (no runsc in CI) — covered by
  the boot assertion + pure builders; a real GitHub webhook delivery — covered
  by signed fixtures (same rationale as M4's recorded Slack payloads).

## Risks / notes

- **gVisor compatibility** (top-risk #6 adjacent): some dev workloads
  misbehave under runsc (ptrace, io_uring, exotic syscalls). Mitigation:
  runtime class is per-deployment config with fail-fast boot detection;
  plain-Docker demo mode stays a flip away; incompatibilities surface as
  provision/exec failures already mapped to FAILED.
- **`--storage-opt` is driver-gated** — that is _why_ it stayed deferred from
  M1; it ships opt-in (`enforceDiskQuota`) and documented (overlay2-on-xfs
  with pquota), never default-on.
- **The proxy is a boundary, so it must stay dumb.** No request rewriting, no
  header injection, no response buffering — allow or refuse, then splice
  sockets. Complexity here is attack surface.
- **Abort is not graceful** — by design. Budget breach means the agent is no
  longer trusted; `pkill` inside the container is the point (the caveat).
  The session is dead afterwards; the next message opens a fresh one (the
  orchestrator already tolerates `createSession` on demand).
- **Audit detail hygiene**: entries are built from ids/names/enums only.
  The "no plaintext in audit" test makes this a regression guard, not a
  convention.
- **Webhook ↔ poll double-delivery is normal**, not a bug: both paths publish
  the same idempotent topics and `advance` no-ops the second one — exactly
  the M3 redelivery discipline.
