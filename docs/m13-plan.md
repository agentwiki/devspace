# M13 — Expansion VIII: per-service identity on the internal API (implementation plan)

Design of record for M13. The deployment-identity seed the roadmap has carried
since M8 lands: the shared `DEVSPACE_INTERNAL_TOKEN` bearer — one secret,
identical on every box, proving only "I am inside the deployment" — is replaced
by mutual TLS with per-service identity. Every internal hop (gateway ⇄
orchestrator split API, orchestrator → sandbox hosts, exec upgrade included)
can now be authenticated by WHO is calling, not by possession of a string that
any compromised service could replay against any other. Zero new dependencies
(`node:tls`/`node:https`), zero contract changes; everything is transport
configuration plus the auth check each server already had.

> Prereqs already landed: the M6 split API and its loopback test discipline,
> the M8 remote sandbox surface + `devspace-exec` upgrade (all pre-flight
> refusals answer BEFORE the 101 — exactly where a transport-auth check slots
> in), and the M9/M10 open-vs-token route split that already forced every
> route to declare its auth posture explicitly.

## Scope

In (per roadmap M13+, the "per-service identity on the internal API" seed):

- **The internal TLS identity.** `DEVSPACE_TLS_CERT`/`KEY`/`CA` (PEM file
  paths, all-or-nothing) give a service its identity: a certificate whose
  subject CN is its service name (`orchestrator`, `chat-gateway`,
  `sandbox-core`), issued by a private internal CA that is the sole trust
  root on both sides of every connection.
- **Servers authenticate and authorize the peer.** Every internal listener
  requires a client certificate signed by the internal CA (handshake-level),
  then checks the peer's service name against the surface's allowlist
  (request-level): sandbox hosts serve the orchestrator; the orchestrator's
  split API serves the chat gateway; the gateway's render endpoint serves
  the orchestrator. The exec upgrade refuses before the 101, like every
  other pre-flight check.
- **Clients verify the server's service identity.** The dialer presents its
  own certificate and verifies the server's certificate names the service it
  meant to reach — instead of hostname verification, which pins deployment
  addresses into certificates for no gain inside a private PKI.
- **The internal surface moves to its own mTLS port.** With TLS configured,
  each svc keeps its plain port for what must stay reachable without a
  client certificate — `/health` probes, and on the orchestrator the GitHub
  webhook ingress (authenticated by HMAC signature since M5) — and serves
  the internal API on `DEVSPACE_TLS_PORT` (default plain port + 1).

Out (seeded to M14+, with rationale):

- **Multi-controller coordination.** The roadmap parked it alongside mTLS,
  but it is a control-plane-semantics change (M10's pool marks and M11's
  state dir assume one controller per host table), not a transport change.
  mTLS is the deployment-identity half and stands alone.
- **NATS bus.** Rationale unchanged since m8-plan: pays for itself when the
  orchestrator scales out; `EventBus` is the seam.
- **Live-utilization / disk-weighted placement, Forum dashboard.** Unchanged
  from the M12 closeout.
- **Certificate issuance/rotation tooling.** The platform consumes PEM files
  and picks them up on restart; minting and rotating them is the operator's
  PKI (step-ca, smallstep, openssl makefiles — deployment-layer, like the
  gVisor install has been since M5).

## Decisions

1. **Transport identity REPLACES the shared secret — one auth regime per
   deployment.** With mTLS configured the bearer check is gone, not layered:
   two half-enforced schemes are weaker than one fully-enforced one, and a
   token that still unlocks everything would nullify the per-service story.
   Configuring both `DEVSPACE_INTERNAL_TOKEN` and `DEVSPACE_TLS_*` on one
   process is refused loudly at boot, on every entrypoint. Unset both and
   the zero-config local/demo posture is byte-for-byte unchanged.
2. **Identity is the certificate subject CN = service name.** Three names,
   fixed by the architecture: `orchestrator`, `chat-gateway`,
   `sandbox-core`. Authorization is an allowlist of names per surface, so a
   compromised gateway certificate cannot claim an env on a sandbox host —
   the exact replay the shared token permitted.
3. **Clients verify service identity, not hostname.** `checkServerIdentity`
   is overridden to require the server certificate's CN to equal the service
   the client meant to dial; chain validation against the pinned internal CA
   is unchanged (and system roots are never consulted). Addresses are
   deployment detail; inside a single-purpose CA the threat is cross-SERVICE
   impersonation, which CN verification kills at both ends. The cost —
   sandbox host A can impersonate host B to the orchestrator — is accepted
   and documented (all hosts share the `sandbox-core` identity; see Risks).
4. **A second listener, not TLS on the existing port.** `requestCert +
   rejectUnauthorized` is the right posture for the internal surface and the
   wrong one for `/health` (a k8s/compose probe has no client cert) and for
   GitHub webhooks (GitHub terminates plain TLS and signs with HMAC — M5's
   verified ingress). Splitting listeners keeps the mTLS surface fail-closed
   with no per-route certificate exceptions. The plain port in TLS mode
   serves ONLY those two things; the open tokenless JSON ops surface does
   not exist on a TLS-mode sandbox host.
5. **Transport auth satisfies the M8 token gates.** `exec`/`applySecrets`
   refuse to serve "tokenless" because secrets ride them; on a TLS listener
   the transport itself authenticates the orchestrator, so they serve. The
   refusal message names both regimes so a misconfigured host stays
   diagnosable.
6. **The auth switch is a discriminated union, not a pair of optionals.**
   Servers take `{ token } | { tlsAllow }`, clients `{ token } | { tls }` —
   the type system makes "both" and "neither" unrepresentable at every seam
   the M6 split cut, and the fail-closed default (TLS handler mounted on a
   plain socket answers 403) covers the one hole types cannot.
7. **Test certificates are minted, never checked in.** A test-support helper
   shells out to `openssl` (present on every CI runner and dev box; the
   suite self-skips without it, the Docker-itest discipline) and mints a
   throwaway CA + service certs per run into a temp dir. No private key
   ever lands in the repo, and nothing expires in a drawer.
8. **Zero new dependencies.** `node:https` servers, `node:https.request`
   clients (global fetch cannot present client certificates), `node:tls`
   for peer-certificate access. The M8 upgrade path is transport-agnostic
   already — a `TLSSocket` is a `Duplex`; the frame pumps, watermark
   channels, and backpressure story do not change.

## Workstreams

### A. sandbox-core: the TLS identity module + the sandbox wire over mTLS

- New `internal-tls.ts`: `InternalTlsIdentity` (PEM contents),
  `internalTlsFromEnv` (`DEVSPACE_TLS_CERT`/`KEY`/`CA` paths,
  all-or-nothing, read at boot), `serverTlsOptions` (require + verify client
  certs against the internal CA only), `peerServiceName`/`peerAllowed`
  (authorized-`TLSSocket` CN extraction; fail-closed on plain sockets),
  `clientTlsOptions` (present identity, `checkServerIdentity` = service-name
  check per Decision 3), and `tlsFetch` (a fetch-shaped `https.request`
  wrapper for the split clients).
- `remote-server.ts`: `SandboxServerOptions.tls?: { allow: string[] }`,
  mutually exclusive with `token` (throws at construction). In TLS mode the
  bearer check becomes the peer check on both the JSON surface and the
  upgrade (still before the 101), and the exec/secrets gates accept
  transport auth (Decision 5).
- `remote-client.ts`: `RemoteSandboxCoreOptions.tls?` dials
  `https.request` with the client identity (JSON and upgrade); requires an
  `https://` base URL; bearer header only in token mode; token-or-tls
  required at construction.
- New `test-tls.ts`: the openssl-minting test harness (Decision 7).
- Tests: identity/env parsing (rejects partial config); loopback mTLS —
  lifecycle + full-duplex exec round-trip over `https.Server`, a
  wrong-service peer refused (403 JSON / pre-101 refusal), a certless
  client refused at handshake, a wrong-named SERVER refused by the client,
  token+tls refused at construction.

### B. orchestrator + apps: the split API over mTLS, boot wiring

- `internal-http.ts`: server auth becomes `{ token } | { tlsAllow }`
  (Decision 6) verified by bearer or peer check; the three clients take
  `{ token } | { tls: identity + expected server name }` and default their
  transport to `tlsFetch` in TLS mode. Semantics of every route unchanged.
- `boot.ts`: fleet mode accepts token OR internal TLS (both → refuse;
  `internalTls` defaults from env like every other knob); sandbox hosts are
  dialed as `sandbox-core` with the orchestrator's identity.
- Entrypoints (the two-listener wiring, Decision 4): sandbox-core-svc
  serves `/health` on the plain port and everything else on
  `DEVSPACE_TLS_PORT` allowing `orchestrator`; orchestrator-svc keeps
  `/health` + webhooks plain and serves the split API on the TLS port
  allowing `chat-gateway`, dialing renders as `chat-gateway`;
  chat-gateway-svc keeps `/health` plain and serves `/render` on the TLS
  port allowing `orchestrator`, dialing the split API as `orchestrator`.
  Every entrypoint refuses token+TLS together (Decision 1).
- Tests: the M6 loopback split re-run over mTLS — chat events and renders
  end to end with the real clients against `https.Server`s, wrong-identity
  peers 403 on both surfaces.
- README: the `DEVSPACE_TLS_*` knobs next to the SANDBOX_HOSTS docs.

### C. Docs closeout

- roadmap: M13 landed; M14+ seeded (NATS, multi-controller coordination,
  live-utilization scheduling, disk budgets, Forum dashboard).
- architecture.md: one paragraph (internal hops authenticate by service
  certificate; the token remains the single-secret alternative).
- README status paragraph.

## Testing strategy

- **Unit (no Docker/DB, `pnpm -r test`, CI):** everything above. TLS suites
  run over real loopback `https.Server`s with per-run minted certs
  (Decision 7) and self-skip without `openssl` — the same
  real-sockets/zero-egress discipline every wire test in this repo follows.
- **Live-Docker itest:** unchanged. mTLS sits between services, not between
  a host and its containers.

## Risks / notes

- **Sandbox hosts share one identity** (Decision 3). Host A's certificate
  passes for host B; per-host identities would buy little until placement
  trusts hosts differently, and the orchestrator still only dials addresses
  it was configured with. Revisit if per-host trust ever differs.
- **No revocation.** A leaked service key means re-issuing the CA or
  rotating the cert it signed; CRL/OCSP plumbing is deliberately out
  (Scope) — at three certs per deployment, rotation IS the revocation
  story, and the files are re-read at restart.
- **The plain port stays plain.** Probes and GitHub webhooks remain
  cleartext-HTTP into the process (webhook payloads are HMAC-verified, M5;
  put a TLS terminator in front for wire privacy — deployment-layer).
- **Operators must mint real certificates** (Scope). The test harness's
  openssl recipe doubles as documentation of the minimum viable PKI: one
  CA, three CN-named certs, no SANs required.
