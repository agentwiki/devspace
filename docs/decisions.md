# 결정 기록

새 설계에서 논의가 필요했던 결정들. 각 항목은 짧게, 결정과 이유만.

## 1. 시나리오용 테스트 레포 지정 방식

**결정: 전용 픽스처 레포 하나 + `E2E_REPO` 변수로 지정.**

- **전용 레포를 하나 만든다** (예: `agentwiki/devspace-e2e-playground`).
  README 하나 있는 아주 작은 레포면 충분하다. 시나리오가 마음껏 브랜치를
  만들고 PR을 열고 닫아도 아무도 다치지 않는 곳이어야 하므로, 실제
  프로젝트 레포를 쓰지 않는다.
- **지정 위치:**
  - 로컬: `.env.e2e` 파일의 `E2E_REPO=owner/name` (`.env.e2e.example` 참고)
  - CI: GitHub Actions **repository variable** `E2E_REPO`
    (Settings → Secrets and variables → Actions → Variables — 비밀이 아니므로
    variable로 두어 로그에서 그대로 읽히게 한다)
- **접근 토큰:** `E2E_GITHUB_TOKEN` — 그 테스트 레포 **하나에만** 스코프된
  fine-grained PAT (권한: Contents RW, Pull requests RW). CI에서는 **secret**.
  테스트 검증/정리(PR 확인·닫기·브랜치 삭제)와, 골든패스가 구현되기 전까지는
  devspace 앱이 클론/푸시/PR에 쓰는 토큰으로도 겸용한다.
- **격리 규칙:** 시나리오는 실행마다 고유한 브랜치 이름을 쓰고, 정리 단계에서
  자기가 만든 PR을 닫고 브랜치를 지운다. 남은 쓰레기가 있어도 픽스처 레포
  안이므로 언제든 통째로 리셋 가능.

## 2. Codex 구독 계정을 CI에서 쓰는 방법

**결정: `~/.codex/auth.json` 내용을 `CODEX_AUTH_JSON` secret으로 등록, CI에서 복원.**

- 로컬에서 `codex login`(구독 계정) 후 `~/.codex/auth.json`의 내용 전체를
  GitHub Actions secret `CODEX_AUTH_JSON`에 붙여넣는다. CI는 이를
  `~/.codex/auth.json`으로 써넣기만 하면 codex CLI가 그대로 인증된다.
- **공식 지원 패턴이다:** OpenAI의
  [CI/CD auth 가이드](https://developers.openai.com/codex/auth/ci-cd-auth)가
  권하는 방식이 정확히 이것 — "refresh API를 직접 부르지 말고, codex가
  갱신해 써넣은 auth.json을 다음 실행을 위해 보존하고, secret은 캐시가 없을
  때의 시드로만 써라." 참고로 공식 GitHub Action인
  [`openai/codex-action`](https://github.com/openai/codex-action)도 있지만
  **API key 인증 전용**이라 구독 계정에는 못 쓰고, 러너에서 `codex exec`를
  직접 돌리는 용도라(codex가 devspace 샌드박스 안에서 도는 우리 구조와 다름)
  채택하지 않았다.
- **토큰 갱신 자동화:** 구독 세션은 마지막 갱신 후 ~8일이 지나면 만료된다.
  그래서 (a) codex가 갱신한 auth.json을 **암호화해 Actions 캐시에 보존**하고
  다음 실행은 secret 대신 캐시본을 우선 사용하며(시드는 캐시가 없을 때만),
  (b) 주 1회 `codex-auth-keepalive` 잡이 codex를 아주 짧게 한 번 실행해
  토큰을 갱신·재저장한다. 크론이 도는 한 재로그인이 필요 없다.
  구현: `.github/scripts/codex-auth.sh` (seed/save).
- **캐시를 암호화하는 이유:** Actions 캐시는 secret 저장소가 아니다 — public
  레포에선 fork PR 워크플로가 기본 브랜치 캐시를 복원할 수 있다. 암호화 키를
  secret 내용에서 파생하므로 secret이 없는 fork에게 캐시는 무용지물이고,
  재로그인으로 시드를 교체하면 키가 바뀌어 옛 캐시는 자동 폐기된다.
- **그래도 만료되면:** (예: 크론 8일+ 중단, Actions 캐시 7일 미사용 축출 후
  시드도 이미 stale) 골든패스가 인증 단계에서 명확히 실패한다 — 로컬 재로그인
  후 secret만 다시 올리면 된다. 조용히 썩지 않는다.
- **주의 2 — rate limit:** 구독 요금제의 사용량을 개인 사용과 공유한다.
  시나리오의 에이전트 작업은 "README에 한 줄 추가" 수준으로 작게 유지한다.
- **백업 경로:** 만료가 잦아 성가시면 usage-based `OPENAI_API_KEY`로 전환
  가능(codex는 API key 인증도 지원). 비용이 들지만 만료가 없다.

## 3. 외부 챗 연동 제거, 자체 웹 채팅

Slack/Discord 어댑터는 외부 플랫폼을 통과해야 해서 사용자 시나리오 E2E가
불가능하다. 자체 웹 채팅 UI는 Playwright로 사용자가 하는 그대로 조작할 수
있으므로, 채팅 표면은 자체 웹 UI 하나만 둔다. (README 원칙 4)

## 4. E2E 주요 장면 스크린샷을 PR에 첨부

**결정: `ci-media` 브랜치에 커밋 + PR 마커 댓글에 인라인 이미지, 실행마다 갱신.**

- GitHub에는 PR "첨부파일" 업로드 API가 없다(웹 UI의 드래그&드롭 전용).
  그래서 표준 우회 패턴을 쓴다: 스크린샷을 이 레포의 `ci-media` 브랜치
  `runs/<run_id>/`에 커밋하고, PR 댓글에 `raw.githubusercontent.com` URL로
  인라인 렌더링한다. 이 레포가 **public**이라 가능한 방식이다 (private으로
  바꾸면 raw URL이 댓글에서 렌더링되지 않으므로 아티팩트 링크로 폴백해야 함).
- **무엇이 찍히나:** 시나리오 단계 중 주요 장면(`e2e/support/snap.ts` 호출
  지점, 파일명 = 단계 번호 + 슬러그) + 실패한 순간의 자동 캡처
  (`screenshot: 'only-on-failure'`). 실행 구현: `.github/scripts/pr-screenshots.sh`.
- **스팸 방지:** PR당 댓글 하나(`<!-- devspace-e2e-screenshots -->` 마커)를
  만들고 이후 실행은 그 댓글을 수정한다.
- **청소:** `ci-media`는 최근 20개 실행만 유지한다. 오래된 댓글의 이미지는
  깨질 수 있고, 브랜치 전체를 지워도 다음 실행이 다시 만든다.
