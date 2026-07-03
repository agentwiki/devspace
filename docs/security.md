# Security

On-prem, multi-user, single shared host (MVP). Threat focus: one user's agent
must never reach another user's environment, token, or volume; a prompt-injected
agent must not exfiltrate secrets or escape the container.

## Per-user GitHub auth

- Prefer OAuth / GitHub-App user-to-server tokens (short-lived, refreshable);
  PAT as fallback. Each user acts with their own credentials.
- **Storage:** envelope encryption (Vault Transit, or age/libsodium with a host
  key kept OUT of the DB). DB stores ciphertext + key id only. Never logged.
- Tokens bound to `(userId, conversationId)`; injected only into that user's env;
  revoked on teardown.
- **Token placement:** in-container token for clone/read only; **push/PR-create is
  proxied through the orchestrator wrapper** so the token's exposure inside the
  sandbox is minimized.

## Secret injection

- Orchestrator resolves secrets at provision time; sandbox-core writes them to
  **tmpfs files** (not image layers). `redactSecrets()` strips known secret values
  from any output streamed back to chat.

## Container isolation (release-blocking before real users — landed in M5)

Implemented as the host-side `SandboxHardening` profile (m5-plan Decision 1 —
policy on the provisioner, never on the tenant request):

- Per-env container: `no-new-privileges`, cap-drop ALL + minimal add-back
  (M5-A). Docker's default seccomp/AppArmor stay on; custom profiles are
  deliberately out (gVisor is the boundary). rootless/userns-remap is a
  daemon-level deployment concern (deployment docs), not a per-container flag.
  **No docker socket inside** (nothing ever mounts it).
- **Run tenant envs under gVisor (runsc) or Kata** — `--runtime` from the
  profile, asserted available at boot (fail-fast), pure-builder tested (M5-A).
- Per-env `--internal` network + **egress allowlist proxy** (GitHub, the LLM
  endpoint, registries — `DEFAULT_EGRESS_ALLOWLIST`). No route out except the
  proxy at the env's own bridge gateway; per-env networks deny env↔env
  traffic (M5-A/B).
- cgroup CPU/mem/pids limits (M1) + opt-in disk quota (`--storage-opt`,
  driver-gated; M5-A) against noisy-neighbor / fork-bomb DoS.
- **Turn budgets + real auto-abort** (M5-C): tool-call + wall-clock budgets on
  every turn; breach ⇒ in-container kill (never `ExecStream.kill()`).

## Multi-tenant authZ & audit

- Every action checked against the requesting `userId ↔ conversation` binding
  in the orchestrator (M3). Per-env named volumes.
- **Append-only `audit_log`** of all privileged ops (M5-D): secret
  resolutions (name+purpose, never plaintext), approval decisions, push/PR,
  token revoke/teardown, aborted turns, webhook ingress. Guardrail-denied
  commands are auto-rejected at the permission gate before execution (M5-C).
- Output redaction is two-layer (M3 + M5-F): every resolved plaintext is
  scrubbed from 100% of outbound chat, plus a token-shape pattern pass for
  values never registered. Defense-in-depth only — the egress proxy is the
  exfiltration control.

## Internal service auth + preview ingress (M6)

- The gateway ⇄ orchestrator internal API carries a shared bearer token
  (`DEVSPACE_INTERNAL_TOKEN`), compared timing-safely on both servers; the
  API is disabled entirely while the token is unset, and both services
  refuse to boot in split mode without it. Per-service identity/mTLS is a
  deployment layer on top (M7+).
- **Preview URLs are capability URLs** (M6-B): a 32-byte random token per
  exposed port, shown only in the owner's session thread, route revoked with
  the env. The proxy is a dumb boundary — unknown token ⇒ 404 before any
  upstream dial, no rewriting, no redirect following; the capability token
  never enters the audit log.

> Plain Docker single-host remains acceptable for the demo only. The M5 items
> above are implemented but OFF by default (demo mode); production must set
> `SANDBOX_HARDENED=1` (+ `EGRESS_PROXY_PORT`, `GITHUB_WEBHOOK_SECRET`) — see
> `.env.example`.
