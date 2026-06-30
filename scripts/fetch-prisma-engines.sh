#!/usr/bin/env bash
# Fetch Prisma engine binaries via curl into the path Prisma expects.
#
# Why this exists: in restricted/proxied environments Prisma's built-in engine
# downloader (https-proxy-agent) can hit ECONNRESET even though the host and
# large downloads work fine over the egress proxy. curl downloads reliably, so
# we pre-place the binaries and let Prisma skip its own download.
#
# Run after `pnpm install` (engines live in node_modules, which is gitignored):
#   ./scripts/fetch-prisma-engines.sh
# Then validate/generate/migrate work normally, e.g.:
#   pnpm --filter @devspace/db db:validate
#
# Override the platform if you are not on debian-openssl-3.0.x:
#   PRISMA_PLATFORM=linux-musl-openssl-3.0.x ./scripts/fetch-prisma-engines.sh
set -euo pipefail

cd "$(dirname "$0")/.."

PLATFORM="${PRISMA_PLATFORM:-debian-openssl-3.0.x}"
BASE_HOST="${PRISMA_ENGINES_MIRROR:-https://binaries.prisma.sh}"

# Engine commit hash: prefer an explicit override, else resolve the
# @prisma/engines-version package by absolute path (pnpm nests it under .pnpm).
HASH="${PRISMA_ENGINE_HASH:-}"
if [[ -z "$HASH" ]]; then
  EV_DIR="$(find node_modules/.pnpm -maxdepth 4 -type d \
    -path '*@prisma+engines-version*/node_modules/@prisma/engines-version' 2>/dev/null | head -1)"
  if [[ -n "$EV_DIR" ]]; then
    HASH="$(node -e "console.log(require(process.argv[1]).enginesVersion)" "$PWD/$EV_DIR")"
  fi
fi
if [[ -z "$HASH" ]]; then
  echo "error: could not determine engine hash; set PRISMA_ENGINE_HASH or run 'pnpm install' first" >&2
  exit 1
fi

ENG_DIR="$(find node_modules/.pnpm -maxdepth 4 -type d \
  -path '*@prisma+engines@*/node_modules/@prisma/engines' 2>/dev/null | head -1)"

if [[ -z "$ENG_DIR" ]]; then
  echo "error: @prisma/engines not found under node_modules — run 'pnpm install' first" >&2
  exit 1
fi

echo "engines version: $HASH"
echo "platform:        $PLATFORM"
echo "target dir:      $ENG_DIR"

fetch() {
  local remote="$1" dest="$2" mode="$3"
  local url="$BASE_HOST/all_commits/$HASH/$PLATFORM/$remote.gz"
  echo "  downloading $remote ..."
  curl -fsSL -o "/tmp/$remote.gz" "$url"
  gunzip -f "/tmp/$remote.gz"
  install -m "$mode" "/tmp/$remote" "$ENG_DIR/$dest"
}

fetch "schema-engine"          "schema-engine-$PLATFORM"            0755
fetch "libquery_engine.so.node" "libquery_engine-$PLATFORM.so.node" 0644

echo "done. prisma engines are in place for $PLATFORM."
