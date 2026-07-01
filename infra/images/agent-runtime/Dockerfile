# Agent runtime, owned by agent-runner (NOT by sandbox-core). Built into a
# self-contained tree that is mounted read-only into a sandbox at /opt/agent-runtime.
# It bundles a pinned Node + codex-acp so the sandbox base image needs no Node
# and stays completely agent-agnostic.
#
# Build:   docker build -t devspace/agent-runtime:codex infra/images/agent-runtime
# Export:  the resulting /opt/agent-runtime tree is published as a named volume
#          (or OCI volume) that the orchestrator mounts via the mounts[] primitive.
FROM node:22-slim AS build
WORKDIR /opt/agent-runtime

# Pin the ACP codex adapter; isolated behind AgentBackend so upgrades are local.
RUN npm install --prefix /opt/agent-runtime @agentclientprotocol/codex-acp@latest

# Ship a self-contained node binary + a launcher shim at the fixed path the
# codex backend expects: /opt/agent-runtime/bin/node and /opt/agent-runtime/codex-acp
RUN mkdir -p /opt/agent-runtime/bin \
    && cp "$(command -v node)" /opt/agent-runtime/bin/node \
    && printf '#!/opt/agent-runtime/bin/node\nrequire("/opt/agent-runtime/node_modules/@agentclientprotocol/codex-acp");\n' \
       > /opt/agent-runtime/codex-acp \
    && chmod +x /opt/agent-runtime/codex-acp

# The publish step (M2) copies /opt/agent-runtime into a named volume.
FROM scratch AS runtime
COPY --from=build /opt/agent-runtime /opt/agent-runtime
