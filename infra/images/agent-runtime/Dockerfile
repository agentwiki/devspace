# Agent runtime, owned by agent-runner (NOT by sandbox-core). Built into a
# self-contained tree that is mounted read-only into a sandbox at /opt/agent-runtime.
# It bundles a pinned Node + BOTH ACP adapters (codex-acp and claude-code-acp,
# M6-E) so the sandbox base image needs no Node and stays completely
# agent-agnostic; which one launches is the backend's choice per session.
#
# Build:   docker build -t devspace/agent-runtime infra/images/agent-runtime
# Export:  the resulting /opt/agent-runtime tree is published as a named volume
#          (or OCI volume) that the orchestrator mounts via the mounts[] primitive.
FROM node:22-slim AS build
WORKDIR /opt/agent-runtime

# Pin the ACP adapters; isolated behind AgentBackend so upgrades are local.
RUN npm install --prefix /opt/agent-runtime \
    @agentclientprotocol/codex-acp@latest \
    @zed-industries/claude-code-acp@latest

# Ship a self-contained node binary + one launcher shim per backend at the
# fixed paths the backends expect: /opt/agent-runtime/{codex-acp,claude-code-acp}
RUN mkdir -p /opt/agent-runtime/bin \
    && cp "$(command -v node)" /opt/agent-runtime/bin/node \
    && printf '#!/opt/agent-runtime/bin/node\nrequire("/opt/agent-runtime/node_modules/@agentclientprotocol/codex-acp");\n' \
       > /opt/agent-runtime/codex-acp \
    && printf '#!/opt/agent-runtime/bin/node\nrequire("/opt/agent-runtime/node_modules/@zed-industries/claude-code-acp");\n' \
       > /opt/agent-runtime/claude-code-acp \
    && chmod +x /opt/agent-runtime/codex-acp /opt/agent-runtime/claude-code-acp

# `publish.sh` copies this /opt/agent-runtime tree into a named Docker volume
# that the orchestrator mounts read-only into each sandbox (ADR-0003).
FROM scratch AS runtime
COPY --from=build /opt/agent-runtime /opt/agent-runtime
