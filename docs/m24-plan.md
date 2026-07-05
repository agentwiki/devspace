# M24 — Expansion XIX: tenant env vars + setup scripts (implementation plan)

Design of record for M24. The gap analysis has carried one remaining
contract-stage axis since M1: reusable environments — an `EnvironmentConfig`
that owns `network`/`env`/`setupScript`/`baseImage`/`cache`. M22/M23 landed
the network member; M24 lands the next two: **a request may carry non-secret
environment variables and a one-shot setup script, both part of the
environment's shape** — CCW's "environment variables" and "setup script"
features, request-first. One contract extension (two optional fields), one
host knob, one migration, two modal inputs. The reusable config OBJECT and
snapshot caching stay seeded: a config store resolves INTO this request
shape later, which is exactly why the request fields must land first.

> Prereqs already landed: per-exec secret injection + file secrets (M1),
> policy containerEnv merged over repo config (M5/M22), warm pools keyed on
> the canonical request (M9/M10), the durable host env table (M11), work-unit
> persistence for resume parity (M22 pattern, migration 0007), and both
> repo-picker modals with the composed-text pipeline (M6/M7/M23).

## What M24 fixes

1. **A tenant cannot shape their environment's process env.** Non-secret
   configuration (feature flags, registry mirrors, `NODE_OPTIONS`) has no
   request surface — the only env injection is `SecretSpec`, which drags
   plain config through the envelope store and redaction machinery built
   for credentials. The gap analysis has this 🟠 ("`SecretSpec`만") since M1.
2. **A tenant cannot prepare their environment before the agent starts.**
   `devcontainer.json` covers repo-side setup, but the REQUEST has no hook:
   "clone, then `pnpm install`, then hand me the agent" needs a fork of the
   repo config. CCW ships this as the setup script; the gap analysis has it
   ❌. Worse, without a request-side hook the warm-pool fill can never
   pre-run tenant setup — the cold-start lever the roadmap priced stays
   half-pulled.

## Scope

In:

- **Contract: `env` + `setupScript` on `CreateEnvironmentRequest`** (and
  `RepoChoice`, `WorkUnit`). Both optional-ABSENT (the M22 pool-key
  discipline: pre-M24 canonical keys stay byte-identical). `env` is a
  non-empty record of POSIX-named variables (`[A-Za-z_][A-Za-z0-9_]*` — a
  name cannot smuggle `=` into `docker exec -e` or containerEnv);
  `setupScript` is a non-empty bounded string (16 KiB — modal inputs cap
  far lower; the bound is a wire-sanity guard, not UX).
- **Tenant env merges UNDER policy, and collisions refuse.** Merge order in
  the synthesized devcontainer config: repo config < tenant env < policy
  env (the egress-proxy vars). A tenant key that case-insensitively
  collides with a policy key refuses at provision naming the keys — policy
  silently winning would break the tenant's mental model, and the tenant
  silently winning would break the operator's (m22-plan "never a silent
  intersection", applied to env).
- **Setup as part of provisioning.** With `setupScript` set, the host runs
  `sh -c <script>` inside the fresh container — as root, cwd the container
  workspace, NO secret injection — after `devcontainer up` succeeds and
  BEFORE the env is durably `ready` (M11: a crash mid-setup is a crashed
  transition and is discarded at recovery, never re-adopted half-setup).
  Failure or timeout (`SANDBOX_SETUP_TIMEOUT_MS`, default 10 min — the
  `up` timeout's sibling) destroys the container + network + scope and the
  create fails with the script's stderr tail: an env that didn't finish its
  setup never reaches a tenant (the warm-claim hand-out discipline, applied
  at birth).
- **Warm pools compose for free — and get the latency win.** Both fields
  join the canonical request key automatically (`canonicalRequestKey` only
  strips secrets + poolKey), so a pool whose template carries a setup
  script pre-runs it at FILL time and a matching claim skips it entirely —
  setup latency moves off the tenant's first message. Requests that don't
  match fall through cold, per M9 Decision 5.
- **Tenant surface + resume parity.** `env=K=V;K2=V2` on both adapters
  (command form; semicolon-separated because values may contain commas,
  whitespace-free because the command line is space-tokenized). Both
  repo-picker modals gain an "Env vars" input and a multi-line "Setup
  script" input; the script is modal-only (a multi-line script cannot ride
  a space-tokenized command — the secrets-modal precedent). Both fields
  persist on the work unit (migration 0008), so the M19 resume
  re-provision rebuilds the SAME environment — env, setup and all.

Out (seeded to M25+, with rationale):

- **The reusable `EnvironmentConfig` object + store.** The request fields
  are the contract-stage decision; the config object is a control-plane
  feature (an `environments` table, ownership, a picker surface) that
  resolves into this request shape. Landing it later costs nothing now
  that the shape exists.
- **Snapshot caching (`docker commit` after setup).** Now that setup
  exists there is something to cache, but image reuse across tenants is
  its own security review (what does a committed layer leak?), and the
  warm-pool fill already pays setup off the hot path for pooled repos.
- **Secret-bearing setup.** Setup runs secret-less BY DESIGN: it must be
  able to run at warm-pool fill time, before any tenant is known, and a
  script that runs identically warm and cold is the only script whose
  environment shape is honest. Private-registry installs need a
  credential story with its own review (scoped, short-lived, revoked
  after setup) — not an accidental "secrets happen to be there cold".
- **Richer warm-pool templates.** `SANDBOX_WARM_POOLS=repoUrl[#ref]=size`
  cannot express env/setup, so operator-configured pools don't yet carry
  them; a request with setup simply misses the pool and goes cold. The
  fill-time win is real but reachable only via config-object templates —
  the M25+ item above, one more reason it's next.

## Decisions

1. **Request fields, not a config object.** The M22 precedent: land the
   wire shape where enforcement can see it, grow the management surface
   later. A config object shipped first would have forced this exact
   request extension anyway (hosts enforce requests, not references).
2. **`env` is non-secret BY CONTRACT.** It rides the open JSON surface,
   persists plaintext on the work unit, and appears in `docker inspect` —
   exactly like the repo config's own `containerEnv`. The schema comment
   and the modal label both say so; anything sensitive belongs in
   `SecretSpec`/the secrets modal, which redact and encrypt. No redaction
   pass is added for env values — declaring them redactable would imply a
   promise the container config cannot keep.
3. **Setup runs secret-less, as root, once.** Secret-less: fill-time and
   cold-path setup must be the same execution or the pool key would lie
   (Decision — see Out). Root: the container is the tenant's own sandbox;
   package installs are the norm and the M5 isolation boundary is the
   container, not the user. Once: setup is birth shape, not a lifecycle
   hook — a claim's clone refresh does not re-run it (a refresh can make
   installed artifacts one fetch stale; that is a freshness trade, not a
   shape violation).
4. **Setup failure is provision failure.** No half-setup env is ever
   `ready`: in-memory status flips ready only for the setup exec itself,
   and the durable table records `ready` strictly after setup succeeds —
   the persist-failure cleanup path (destroy + clear scope + remove
   network) covers setup failure identically. The error carries the
   stderr tail (no secrets were injected; env values are non-secret by
   Decision 2).
5. **Collision = refusal, both directions visible.** Tenant env under
   policy env, and a collision refuses naming the keys. In demo mode (no
   proxy policy env) there is nothing to collide with and e.g.
   `HTTP_PROXY` is the tenant's to set — the refusal is about never
   letting two writers silently disagree, not about blessing names.
6. **`env=` uses `;` between pairs, and malformed empties the choice.**
   Values may contain commas (`NODE_OPTIONS=--max-old-space-size=4096` may
   not, but lists do); `;` never appears in a POSIX name and rarely in
   values a command line can carry anyway. Any malformed pair (bad name,
   missing `=`) empties the WHOLE choice — the M22 Decision-8 posture: a
   typo costs a retype, never a differently-shaped env.
7. **The modal script/env fields attach, not compose.** The M23
   composed-text pipeline cannot carry multi-line scripts or spaced
   values. The env field still has a single interpreter —
   `parseEnvAssignments`, shared with the `env=` token (the modal field
   additionally accepts newline separators and spaces around pairs) — and
   the script is opaque: there is no syntax to interpret, so attaching it
   verbatim to a non-empty parsed choice adds no second parser. A
   malformed env field empties the whole choice, exactly like the token.
8. **Cross-version posture: new keys are stripped, not refused, by
   pre-M24 hosts.** Unlike M23's enum value (free refusal at parse), an
   optional KEY is silently dropped by an older host's schema. Same
   posture as M22's own new keys: upgrade sandbox hosts before
   controllers. Documented, not mitigated — retrofitting strictness onto
   already-shipped hosts is not possible from here.
9. **Nothing new persists on the host.** The durable env state file
   (M11) is untouched: setup already ran (its effects live in the
   container, which is what recovery verifies), and tenant env is baked
   into the container config (it survives the restart with the
   container). The work unit is the resume-parity store, as with M22.

## Workstreams

### A. Contract + host (contracts + sandbox-core)

- contracts: `env`/`setupScript` on `CreateEnvironmentRequest` (superRefine:
  non-empty record, POSIX names, non-empty bounded script), `RepoChoice`,
  `WorkUnit`.
- provision.ts: `mergeDevcontainerConfig` gains `tenantEnv` (merged between
  repo config and policy); `policyEnvCollisions(tenantEnv, policyEnv)`
  (pure, case-insensitive); the provisioner refuses collisions naming keys
  and passes `remoteWorkspaceFolder` through `ProvisionResult`.
- sandbox.ts: `setupTimeoutMs` option + `setupTimeoutFromEnv`
  (`SANDBOX_SETUP_TIMEOUT_MS`); `createEnvironment` runs the setup exec
  (root, workspace cwd, no secret env) between in-memory ready and the
  durable-ready persist; failure/timeout destroys container + scope +
  network and fails the create with the stderr tail.
- wiring: `setupTimeoutMs` from env in sandbox-core-svc and
  bootOrchestrator's local branch.
- Tests: contract parse tables; merge-order + collision tables; provisioner
  refusal; setup success order (exec before durable-ready), failure
  cleanup, timeout; canonical-key sensitivity to both fields; fake
  container grows a generic `sh -c` recorder.

### B. Tenant surface + persistence (db + orchestrator + chat-gateway)

- db: migration 0008 (`tenant_env` jsonb, `setup_script` text) + schema +
  both repo mappings (`workUnitPatchColumns`, `mapWorkUnit`; the in-memory
  repo spreads patches already).
- orchestrator: `conversation.created` carries `env`/`setupScript` from the
  choice onto the env request AND the unit patch; the M19 resume
  re-provision carries the persisted values (same block as the egress
  policy).
- chat-gateway: `parseEnvAssignments` (shared interpreter) + `env=` token
  in `parseRepoChoice`; both repo-picker modals gain the env + multi-line
  script inputs; both `parseRepoPickerSubmission`s return `{text, env?,
envInvalid?, setupScript?}` and both adapters attach onto the parsed
  choice (envInvalid → empty choice).
- Tests: parser tables (token + assignments, malformed → empty), modal
  builders + submission parsers on both platforms, adapter flow (modal
  submission reaches `conversation.created` with env + script), handler
  tests (created + resume carry both onto the sandbox request and the
  row), Pg itest work-unit round trip.

### C. Docs closeout

- roadmap: M24 landed; M25+ seeded (EnvironmentConfig store, snapshot
  caching, secret-bearing setup, richer pool templates, carried seeds).
- architecture.md "Since M24"; security.md (env is non-secret by contract;
  setup is root inside the existing boundary; collision refusal);
  gap analysis: 환경변수 🟠→✅, 셋업 스크립트 ❌→✅(request-side; caching
  seeded), "채워야 할 것" updated.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above — the
  milestone is schema + merge + one exec sequenced into an existing
  lifecycle, all behind the fakes the M11/M22 suites already use.
- **Pg itest:** the M22 work-unit round trip grows env + script columns.
- **Live-Docker itest (`sandbox.itest.ts`):** one case — a request with a
  setup script provisions, the script's effect is observable in the
  container (a file it wrote), and a failing script fails the create and
  leaves no container behind.

## Risks / notes

- **Setup is arbitrary tenant code — but it already was.** The agent runs
  arbitrary code in the same container one message later; setup adds no
  new capability, only a new TIME (before the agent, at fill for pools).
  Egress/hardening posture is identical either way.
- **A slow setup script delays provisioning, visibly.** The status message
  already says "Provisioning environment…"; the timeout bounds the wait.
  Pool templates (M25+) move it off the hot path entirely.
- **Env values appear in `docker inspect` and process listings inside the
  env** — the reason Decision 2 refuses to pretend they are secret.
