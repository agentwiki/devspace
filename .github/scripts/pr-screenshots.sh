#!/usr/bin/env bash
# E2E 실행의 주요 장면 스크린샷을 PR에 인라인 이미지로 첨부한다.
#
# GitHub에는 PR "첨부파일" API가 없으므로(웹 UI 전용), 표준 우회 패턴을 쓴다:
#   1. 스크린샷을 ci-media 브랜치의 runs/<run_id>/ 에 커밋 (public 레포라
#      raw.githubusercontent.com URL이 댓글에서 그대로 렌더링됨)
#   2. PR에 마커 댓글 하나를 만들고, 이후 실행마다 그 댓글을 갱신
# 자세한 결정: docs/decisions.md §4
set -euo pipefail

: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}" "${PR_NUMBER:?}"

MARKER='<!-- devspace-e2e-screenshots -->'
MEDIA_BRANCH=ci-media
RUN_DIR="runs/${GITHUB_RUN_ID}"
KEEP_RUNS=20 # 이보다 오래된 실행의 이미지는 브랜치에서 정리(과거 댓글 이미지는 깨질 수 있음)

# ── 1. 스크린샷 수집: 명시적 장면(snap) + 실패 시점 자동 캡처 ────────────────
# 장면 파일명은 "<시나리오>__<장면>.png"(snap.ts)라 시나리오별로 정렬·그룹된다.
# 실패 캡처(test-failed-*)는 같은 테스트 출력 디렉토리의 시나리오로 묶는다.
staging=$(mktemp -d)
declare -A DIR_SCENARIO # 테스트 출력 디렉토리 → 시나리오 슬러그
fail_count=0

while IFS= read -r png; do
  base=$(basename "$png" .png) # <시나리오>__<장면>
  rel=${png#test-results/}
  DIR_SCENARIO[${rel%%/*}]=${base%%__*}
  cp "$png" "$staging/${base}.png"
done < <(find test-results -path '*/scenes/*.png' 2>/dev/null | sort)

while IFS= read -r png; do
  rel=${png#test-results/}
  scenario=${DIR_SCENARIO[${rel%%/*}]:-zzz-unknown}
  fail_count=$((fail_count + 1))
  cp "$png" "$staging/${scenario}__zz-failure-${fail_count}.png"
done < <(find test-results -name 'test-failed-*.png' 2>/dev/null | sort)

count=$(find "$staging" -name '*.png' | wc -l)
if [ "$count" -eq 0 ]; then
  echo "스크린샷 없음 — 댓글 생략"
  exit 0
fi

# ── 2. ci-media 브랜치에 커밋 ────────────────────────────────────────────────
remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
media=$(mktemp -d)
if git ls-remote --exit-code "$remote" "refs/heads/${MEDIA_BRANCH}" >/dev/null 2>&1; then
  git clone -q --depth 1 --branch "$MEDIA_BRANCH" "$remote" "$media"
else
  git -C "$media" init -q -b "$MEDIA_BRANCH"
  git -C "$media" remote add origin "$remote"
fi

mkdir -p "$media/$RUN_DIR"
cp "$staging"/*.png "$media/$RUN_DIR/"
if [ -d "$media/runs" ]; then
  ls "$media/runs" | sort -n | head -n -"$KEEP_RUNS" | while IFS= read -r old; do
    rm -rf "$media/runs/$old"
  done
fi

git -C "$media" add -A
git -C "$media" \
  -c user.name='github-actions[bot]' \
  -c user.email='github-actions[bot]@users.noreply.github.com' \
  commit -qm "e2e screenshots: run ${GITHUB_RUN_ID} (PR #${PR_NUMBER})"
# 동시 실행과의 푸시 경합은 한 번 재시도로 흡수한다.
git -C "$media" push -q origin "$MEDIA_BRANCH" ||
  { git -C "$media" pull -q --rebase origin "$MEDIA_BRANCH" && git -C "$media" push -q origin "$MEDIA_BRANCH"; }

# ── 3. 댓글 본문 구성 (시나리오별 섹션) ──────────────────────────────────────
# staging 파일명이 "<시나리오>__<장면>.png"라 glob 정렬이 곧 시나리오별 묶음이다.
raw_base="https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${MEDIA_BRANCH}/${RUN_DIR}"
body_file=$(mktemp)
{
  echo "$MARKER"
  echo "### 📸 E2E 주요 장면 — [run ${GITHUB_RUN_ID}](https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID})"
  echo
  echo "시나리오별 주요 장면입니다 (이 댓글은 실행마다 갱신됩니다)."
  current=""
  for png in "$staging"/*.png; do
    base=$(basename "$png" .png)
    scenario=${base%%__*}
    title=${base#*__}
    if [ "$scenario" != "$current" ]; then
      current=$scenario
      echo
      echo "#### 🎬 \`${scenario}\`"
      echo
    fi
    echo "<details open><summary><b>${title}</b></summary>"
    echo
    echo "<img src=\"${raw_base}/$(basename "$png")\" width=\"600\">"
    echo
    echo "</details>"
  done
} >"$body_file"

# ── 4. 마커 댓글 갱신 (있으면 수정, 없으면 생성) ─────────────────────────────
comment_id=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --paginate \
  --jq '[.[] | select(.body | contains("devspace-e2e-screenshots"))][0].id // empty')
if [ -n "$comment_id" ]; then
  gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" -F body=@"$body_file" >/dev/null
else
  gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" -F body=@"$body_file" >/dev/null
fi
echo "PR #${PR_NUMBER}에 장면 ${count}개 첨부 완료"
