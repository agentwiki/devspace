# M23 — Expansion XVIII: tenant egress widening under an operator ceiling (implementation plan)

Design of record for M23. M22 landed per-environment egress policy as
narrowing-only — deliberately: under the M5 trust model ("a tenant request
cannot weaken its own sandbox"), widening is an operator decision, not a
request field. The M22 closeout seeded the other half as its own policy
feature: CCW's "custom domains" — a tenant may ADD hosts to their env's
egress, but only hosts the operator has pre-approved for tenant use. M23
lands exactly that: **`SANDBOX_TENANT_HOSTS` is an operator ceiling of
tenant-addable hosts; a request may name extra hosts only under it** — plus
the repo-picker modal `net` field both adapters deferred (the command form
stays the canonical ergonomics). One additive enum value, one registrar
field, one knob, one modal input. Zero migrations: `network_access` is a
plain text column, and `allowedHosts` already rides jsonb.

> Prereqs already landed: the per-env scope machinery end to end (M22 —
> validation at provision, enforcement at the proxy per gateway, persistence
> in the M11 table, resume parity via the work unit), the shared
> `parseRepoChoice` both adapters use, and both repo-picker modals (M6/M7).

## What M23 fixes

1. **A tenant cannot reach a host the operator would happily allow them.**
   The M22 posture is narrow-only: `custom` entries must be covered by the
   operator allowlist, so "GitHub + my company's package mirror" needs the
   operator to widen `EGRESS_ALLOWLIST` for EVERY env on the host — the
   blunt instrument M22's Scope section explicitly deferred sharpening.
   CCW ships this as custom domains; devspace has the seed, not the feature.
2. **The repo-picker modal cannot express a network choice.** `net=` exists
   only in the command form; a tenant who starts from the bare-`/devspace`
   modal always gets default egress. The M22 deferral ("additive UI for the
   milestone that wants it") comes due with the widening feature — the modal
   otherwise cannot reach what M23 adds.

## Scope

In:

- **The ceiling: `SANDBOX_TENANT_HOSTS`.** Comma-separated allowlist entries
  (exact hosts or `*.suffix` — the `EGRESS_ALLOWLIST` syntax), parsed where
  the proxy boots (sandbox-core-svc, `bootOrchestrator`'s local branch) and
  carried on the registrar (`EgressScopeRegistrar.tenantHosts`). It is a
  VALIDATION ceiling only — never added to the proxy's default allowlist:
  an env that doesn't ask reaches exactly what it reached before, and a
  ceiling entry becomes reachable only inside an env whose request named it.
- **Contract: `networkAccess: 'extend'`.** Additive third enum value on
  `CreateEnvironmentRequest`/`RepoChoice`/`WorkUnit`: effective egress =
  the operator allowlist ∪ `allowedHosts`. Same superRefine posture as
  `custom` (non-empty `allowedHosts` required; `allowedHosts` meaningful
  only with `custom`/`extend`). Absent/`none`/`custom` semantics unchanged.
- **One admissibility rule.** A requested entry is admissible iff covered by
  the operator allowlist OR the tenant ceiling — for `custom` and `extend`
  alike (if a tenant may EXTEND to a host, a custom list naming it — a
  strictly narrower env — must be legal too). Coverage stays
  `coveredByAllowlist` (exact by match, wildcard only by equal-or-broader
  wildcard); an inadmissible entry still refuses at provision naming the
  entries, now also naming the ceiling knob.
- **Tenant surface.** `net=+host1,+host2` = extend (the `+` marks "on top of
  the default"); plain `net=host1,host2` stays custom; mixing marked and
  unmarked entries empties the whole choice (ambiguity costs a retype, never
  a guess — the M22 Decision 8 posture, extended). Both repo-picker modals
  gain an optional "Network" input whose value is the `net=` value syntax
  (`none`, `host1,host2`, `+extra.host`); the submission parser composes it
  onto the existing "<repo> [ref]" text so `parseRepoChoice` stays the single
  interpreter.

Out (seeded to M24+, with rationale):

- **Per-tenant/per-user ceilings.** `SANDBOX_TENANT_HOSTS` is per HOST — all
  tenants on the host share one ceiling. Per-user policy needs an identity-
  keyed policy store on the control plane and a way to ship it to hosts;
  that is its own feature with its own review (and today's deployments are
  single-team).
- **Mid-session widening.** The scope is still fixed at provisioning; "add a
  host to my live env" is applySecrets-like surface with a real authz
  question (who may widen a running workload?). A tenant re-creates the
  session with the wider `net=` instead.
- **Ceiling entries in the modal as a picker.** The modal input is free
  text; enumerating the ceiling as checkboxes means shipping host policy to
  the gateway (which deliberately knows nothing about sandbox hosts). The
  provision-time refusal names what was inadmissible — the feedback loop
  exists, one step later.

## Decisions

1. **The ceiling lives on the registrar, not in the contract.** Requests
   name hosts; whether a host is tenant-addable is the sandbox HOST's
   policy, evaluated where enforcement lives (the M22 shape: the registrar
   already carries the operator allowlist for `custom` validation). Fleet
   mode inherits for free — each host validates against its own ceiling,
   and a fleet with per-host ceilings refuses on hosts that can't honor the
   request (the M8 placement error surfaces it) rather than averaging
   policy.
2. **`'extend'` is a third value, not a `custom` flag.** The M22 pool-key
   discipline holds: all three fields stay optional-absent, so every
   pre-M23 canonical key is byte-identical. A boolean rider on `custom`
   would overload "exactly these hosts" with "these hosts plus an implicit
   set" behind one value — the enum name IS the semantics.
3. **The resolved scope embeds the operator allowlist at birth.** An
   `extend` env's persisted scope is the union RESOLVED at provisioning
   (M22 Decision 5, unchanged): operator allowlist changes never silently
   retune a live env, and recovery re-registers exactly what was granted.
   The union is deduped (case/trailing-dot normalized) so the persisted
   slice stays small and diff-able.
4. **Admissibility spans both levels; reachability spans neither.** The
   ceiling admits REQUESTS; it never admits TRAFFIC by itself. Only a
   resolved per-env scope makes a ceiling host reachable, and only for that
   env. `hostAllowed` at the proxy is untouched — the enforcement path has
   no new inputs, exactly why the whole milestone is a validation change.
5. **`+` marks extend entries; mixing marks empties the choice.** A single
   marker on the first entry ("net=+a,b" meaning extend-all) would make
   "net=a,+b" ambiguous-but-parseable — and a guessed parse that lands on
   `custom` silently DROPS the default allowlist the tenant thought they
   were keeping, while a guess landing on `extend` silently widens a list
   the tenant thought was exact. Both wrong-guess costs are egress-shaped,
   so neither is acceptable: all entries marked, or the choice is empty and
   the user retypes.
6. **The modal input rides the existing text pipeline.** The submission
   parser appends `net=<value>` (whitespace stripped, one leading `net=`
   forgiven) to the composed "<repo> [ref]" string rather than building a
   RepoChoice of its own — `parseRepoChoice` remains the single place `net`
   syntax is interpreted, and every Decision-8 guarantee (empty/ambiguous →
   empty choice) applies to the modal for free. A malformed modal value can
   only ever yield an EMPTY choice (nothing created), never a wider env.
7. **Cross-version posture: refuse, never degrade.** A pre-M23 host
   receiving `'extend'` fails schema validation at the JSON surface and the
   provision refuses loudly — the M22 honor-or-refuse discipline covers the
   upgrade window with no new code. (A pre-M23 ORCHESTRATOR simply cannot
   emit `'extend'`; old units resume with their persisted `none`/`custom`
   policies, both of which every M22 host honors.)

## Workstreams

### A. Widening ceiling (contracts + sandbox-core + boots)

- contracts: `'extend'` joins the three `networkAccess` enums; superRefine
  covers it (non-empty `allowedHosts`; `allowedHosts` with `custom|extend`
  only).
- egress-proxy.ts: `EgressScopeRegistrar.tenantHosts?` (readonly, default
  none); `EgressProxyOptions.tenantHosts`; the proxy carries it verbatim —
  no enforcement change.
- provision.ts: `effectiveEgressAllowlist(req, operatorAllowlist,
tenantHosts?)` — admissibility = covered by operator ∪ ceiling for
  `custom` AND `extend`; `extend` resolves to the deduped union; refusal
  messages name the ceiling knob. Provisioner passes
  `this.egress.tenantHosts`.
- wiring: `SANDBOX_TENANT_HOSTS` parsed next to `EGRESS_ALLOWLIST` in
  sandbox-core-svc and bootOrchestrator's local branch; boot log line.
- Tests: effective-allowlist table grows extend + ceiling cases (custom
  under ceiling, extend union + dedupe, inadmissible refusal naming
  entries, empty ceiling = byte-for-byte M22); contract superRefine cases;
  provisioner passes the ceiling through (fake registrar).

### B. Tenant surface (chat-gateway)

- adapters/slack.ts: `parseRepoChoice` learns `+` entries (all-marked →
  `extend` with stripped hosts; mixed → empty choice; Slack auto-link
  unwrapping still applies per entry after the marker is read).
- slack/blocks.ts + discord/modals.ts: optional `network` input on both
  repo-picker modals; both `parseRepoPickerSubmission`s compose
  `net=<value>` (whitespace stripped, leading `net=` forgiven) onto the
  text when the field is filled.
- Tests: parser table (+ forms, mixed-marker emptiness, `net=+` alone,
  auto-linked marked entries); both modal builders carry the field; both
  submission parsers compose it (filled/empty/spaced/`net=`-prefixed);
  adapter flow test: modal submission with a network value reaches
  `conversation.created` with the parsed choice.

### C. Docs closeout

- roadmap: M23 landed; M24+ seeded (per-tenant ceilings, mid-session
  widening, carried seeds).
- architecture.md "Since M23"; security.md egress paragraph (ceiling is
  validation-only); README status + `net=` forms; gap analysis: 네트워크
  접근 레벨 항목에 widening 반영.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above — the
  milestone is validation + parsing, exactly the layers the M22 suites
  already pin; extend cases slot into the same tables. The proxy loopback
  suite is untouched (no enforcement change) except a registrar-shape
  assertion.
- **Pg itest:** the M22 work-unit round trip gains an `extend` row (text
  column — no migration to prove, just the enum surviving the mapping).
- **Live-Docker itest:** untouched — scope registration/enforcement
  machinery is byte-identical; only WHAT gets resolved into a scope grew.

## Risks / notes

- **The ceiling is a widening lever — scoped deliberately.** It widens only
  envs that ASK, only to hosts the operator pre-approved, and only via the
  same resolved-scope machinery M22 shipped; the default posture of every
  other env is untouched. An operator who sets no ceiling runs byte-for-byte
  M22.
- **Ceiling changes don't retro-apply** (Decision 3): tightening
  `SANDBOX_TENANT_HOSTS` narrows future provisions only — live `extend`
  envs keep their birth scope until reprovisioned (suspend/resume
  re-provisions re-validate, so a resume AFTER a tightening can refuse; the
  in-thread error names the entries, and the unit stays PR_OPEN — the M19
  failed-resume posture already covers it).
- **Warm-pool keys:** templates using `extend` key on it like any other
  field (Decision 2 keeps non-users stable). The standing cross-version
  posture applies to operators who adopt it in pool templates.
- **`+` collides with nothing:** `+` is not valid in hostnames, no Slack
  auto-link form starts with it, and pre-M23 parsers never accepted it —
  old gateways treat `net=+a` as a custom host `+a`, which no allowlist
  covers, so the worst cross-version outcome is a loud provision refusal.
