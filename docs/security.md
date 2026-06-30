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

## Container isolation (release-blocking before real users — M5)

- Per-env container: rootless/userns-remap, `no-new-privileges`, dropped caps,
  seccomp + AppArmor, read-only root fs where feasible, **no docker socket inside**.
- **Run tenant envs under gVisor (runsc) or Kata** — the single highest-value
  upgrade over plain Docker on a shared host.
- Per-env network namespace + **egress filtering proxy** (allowlist GitHub, the LLM
  endpoint, registries). Deny env↔env and env→control-plane traffic.
- cgroup CPU/mem/pids/disk limits to prevent noisy-neighbor / fork-bomb DoS.

## Multi-tenant authZ & audit

- Every action checked against the requesting `userId ↔ conversation` binding in
  the orchestrator. Per-env named volumes. Audit-log all privileged ops
  (push, PR, denylisted-adjacent commands).

> Plain Docker single-host is acceptable for the demo only. Do not expose to real
> multi-tenant users without the M5 items above.
