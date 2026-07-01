#!/usr/bin/env bash
# Build the agent-runtime image and publish its /opt/agent-runtime tree into a
# named Docker volume. The orchestrator mounts that volume read-only into every
# sandbox at /opt/agent-runtime (ADR-0003) via a generic `mounts[]` entry — see
# `agentRuntimeMount()` in @devspace/agent-runner.
#
# To sandbox-core this volume is opaque; only agent-runner knows it holds a
# pinned Node + codex-acp. Re-run this whenever the pinned codex-acp version
# changes; the volume is the unit of agent-runtime versioning.
#
# Usage: publish.sh [VOLUME_NAME] [IMAGE_TAG]
set -euo pipefail

VOLUME="${1:-devspace-agent-runtime}"
IMAGE="${2:-devspace/agent-runtime:codex}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[agent-runtime] building ${IMAGE}"
docker build -t "${IMAGE}" "${HERE}"

echo "[agent-runtime] (re)creating volume ${VOLUME}"
docker volume rm "${VOLUME}" >/dev/null 2>&1 || true
docker volume create "${VOLUME}" >/dev/null

# The runtime stage is `FROM scratch` (no shell), so it can't run `cp` itself.
# Build a tiny helper that layers the runtime tree onto a shell-bearing base,
# then copy the tree into the volume from that helper.
echo "[agent-runtime] staging copy helper"
docker build -t "${IMAGE}-publish" -f - "${HERE}" <<DOCKERFILE >/dev/null
FROM ${IMAGE} AS rt
FROM node:22-slim
COPY --from=rt /opt/agent-runtime /opt/agent-runtime
DOCKERFILE

echo "[agent-runtime] copying /opt/agent-runtime -> volume ${VOLUME}"
docker run --rm \
  -v "${VOLUME}:/out" \
  "${IMAGE}-publish" \
  sh -c 'rm -rf /out/* && cp -a /opt/agent-runtime/. /out/'

docker image rm "${IMAGE}-publish" >/dev/null 2>&1 || true

echo "[agent-runtime] published to volume '${VOLUME}'"
echo "[agent-runtime] mount with: source=${VOLUME} target=/opt/agent-runtime ro=true"
