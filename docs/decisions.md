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
- **주의 1 — 토큰 갱신:** codex는 사용 중 auth.json의 토큰을 갱신(rotate)해서
  다시 써넣는데, CI 안에서 갱신된 값은 secret에 반영되지 않는다. 오래 지나
  refresh token이 만료되면 로컬에서 재로그인 후 secret을 다시 올린다.
  (만료 시 골든패스가 인증 단계에서 명확히 실패하므로 조용히 썩지 않는다.)
- **주의 2 — rate limit:** 구독 요금제의 사용량을 개인 사용과 공유한다.
  시나리오의 에이전트 작업은 "README에 한 줄 추가" 수준으로 작게 유지한다.
- **백업 경로:** 만료가 잦아 성가시면 usage-based `OPENAI_API_KEY`로 전환
  가능(codex는 API key 인증도 지원). 비용이 들지만 만료가 없다.

## 3. 외부 챗 연동 제거, 자체 웹 채팅

Slack/Discord 어댑터는 외부 플랫폼을 통과해야 해서 사용자 시나리오 E2E가
불가능하다. 자체 웹 채팅 UI는 Playwright로 사용자가 하는 그대로 조작할 수
있으므로, 채팅 표면은 자체 웹 UI 하나만 둔다. (README 원칙 4)
