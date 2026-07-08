#!/usr/bin/env bash
# CI에서 codex를 값싸게 돌리기 위한 config.toml 생성 (docs/decisions.md §12)
#
# ~/.codex 는 devcontainer 어댑터가 샌드박스에 그대로 바인드 마운트하므로
# (packages/adapters/src/devcontainer.ts, target=/home/node/.codex), 여기서 쓴
# config.toml 이 샌드박스 안 codex 실행에 그대로 적용된다 — auth.json 과 같은
# 디렉토리다. 어댑터/로컬 개발엔 손대지 않고 CI에서만 값을 낮춘다.
#
# 시나리오의 에이전트 작업은 "한 줄 추가" 수준이라(docs/decisions.md §2) 낮은
# 추론 강도로 충분하다 — 토큰·실행 시간(=Actions 분)·구독 rate limit을 아낀다.
#
#   CODEX_REASONING_EFFORT — minimal|low|medium|high (기본 low)
#   CODEX_MODEL            — 특정 모델 슬러그(선택). 미설정이면 codex 기본 모델.
set -euo pipefail

CONFIG_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG_FILE="$CONFIG_DIR/config.toml"
EFFORT="${CODEX_REASONING_EFFORT:-low}"

mkdir -p "$CONFIG_DIR"
{
  echo "model_reasoning_effort = \"${EFFORT}\""
  if [ -n "${CODEX_MODEL:-}" ]; then
    echo "model = \"${CODEX_MODEL}\""
  fi
} >"$CONFIG_FILE"

echo "codex config.toml 작성: effort=${EFFORT} model=${CODEX_MODEL:-<codex 기본>}"
