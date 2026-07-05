#!/usr/bin/env bash
# Codex 구독 인증(auth.json)의 CI 수명주기 관리 (docs/decisions.md §2)
#
# 공식 가이드(developers.openai.com/codex/auth/ci-cd-auth)의 supported 패턴:
# "refresh API를 직접 부르지 말고, codex가 갱신해 써넣은 auth.json을
#  다음 실행을 위해 보존하라. secret은 캐시가 없을 때의 시드로만 쓴다."
#
#   seed — 캐시(암호화)에 갱신본이 있으면 복호화해 사용, 없으면 secret 시드
#   save — codex 실행으로 갱신된 auth.json을 암호화해 캐시 디렉토리에 저장
#
# 캐시는 암호화한다: GitHub Actions 캐시는 secret 저장소가 아니라서 public
# 레포에선 fork PR의 워크플로가 기본 브랜치 캐시를 복원할 수 있다. 암호화
# 키를 secret(시드 내용)에서 파생하므로 secret이 없는 fork PR에게 캐시는
# 무용지물이다. 시드를 교체(재로그인)하면 키가 바뀌어 옛 캐시는 자동 폐기.
set -euo pipefail

CACHE_DIR="${CODEX_AUTH_CACHE_DIR:-$HOME/.codex-auth-cache}"
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
ENC_FILE="$CACHE_DIR/auth.json.enc"

if [ -z "${CODEX_AUTH_JSON:-}" ]; then
  echo "::warning::CODEX_AUTH_JSON secret이 비어 있음 — codex 인증 없이 진행"
  exit 0
fi
ENC_KEY=$(printf '%s' "$CODEX_AUTH_JSON" | sha256sum | cut -d' ' -f1)
export ENC_KEY

case "${1:?usage: codex-auth.sh seed|save}" in
  seed)
    mkdir -p "$(dirname "$AUTH_FILE")"
    if [ -f "$ENC_FILE" ] &&
      openssl enc -d -aes-256-cbc -pbkdf2 -pass env:ENC_KEY -in "$ENC_FILE" -out "$AUTH_FILE" 2>/dev/null; then
      echo "캐시된(갱신된) auth.json 사용"
    else
      printf '%s' "$CODEX_AUTH_JSON" >"$AUTH_FILE"
      echo "secret 시드로 auth.json 생성"
    fi
    chmod 600 "$AUTH_FILE"
    ;;
  save)
    if [ ! -f "$AUTH_FILE" ]; then
      echo "auth.json 없음 — 저장 생략"
      exit 0
    fi
    mkdir -p "$CACHE_DIR"
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:ENC_KEY -in "$AUTH_FILE" -out "$ENC_FILE"
    echo "갱신된 auth.json을 암호화해 캐시에 저장"
    ;;
  *)
    echo "usage: codex-auth.sh seed|save" >&2
    exit 1
    ;;
esac
