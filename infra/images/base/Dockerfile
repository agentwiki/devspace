# Default sandbox base image. Deliberately agent-agnostic: it ships a general
# dev toolchain only. The agent runtime is mounted in at provision time (see
# infra/images/agent-runtime) — it is NOT baked here.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

# `gh` CLI for the GitHub work-cycle (clone/PR status), used with the user's PAT.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
