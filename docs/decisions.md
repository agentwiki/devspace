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
- **주의 — rate limit:** 구독 요금제의 사용량을 개인 사용과 공유한다.
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

## 5. 헥사고날 모노레포 + 결정론적 경계 강제

**결정: pnpm workspace 3패키지(core/adapters/server) + dependency-cruiser로 경계를 CI에서 강제.**

- **구조:** `packages/core`(순수 도메인 + 포트 인터페이스) ←
  `packages/adapters`(포트 구현: devcontainer/codex/GitHub) ←
  `apps/server`(조립 루트 + 웹 채팅). 화살표 방향으로만 알 수 있다.
  패키지는 필요가 증명될 때만 늘린다 — 지금은 3개면 충분하다.
- **강제 장치 4중 (문서가 아니라 기계가 지킨다):**
  1. **pnpm 엄격 node_modules** — package.json에 선언 안 한 패키지는
     import 자체가 실패한다. core는 dependencies가 없으므로 아무것도 못 가져온다.
  2. **dependency-cruiser** (`pnpm check:arch`) — core 순수성(외부 패키지·node
     내장까지 금지), "adapters는 server만이 조립", "e2e는 앱 내부 import 금지
     (블랙박스)", 순환 의존 금지. 위반 = CI 실패.
  3. **ESLint + tsc strict** (`noUncheckedIndexedAccess`,
     `exactOptionalPropertyTypes`) — 코드 수준 결함.
  4. **유닛테스트** (vitest) — 도메인 로직(예: 세션 상태 머신)은 포트 목 없이
     순수 함수로 테스트된다. E2E가 사용자 진실을, 유닛이 도메인 진실을 지킨다.
- CI의 `checks` 잡이 위 전부를 실행한다. 저성능 에이전트든 사람이든,
  경계를 깨면 머지 전에 기계적으로 걸린다.
- **pnpm 복귀:** 단일 패키지 시절 npm이었으나 모노레포 유지 결정(이 항목)으로
  pnpm workspace로 전환. 엄격 node_modules가 강제 장치 1번을 겸한다.
- **core 내부 세부 경계 (도메인 비대화 대응):** `domain/`(규칙)은 `ports`도
  `usecase/`도 import할 수 없다(`domain-knows-no-ports`). 포트가 필요한
  로직이 domain에 들어오는 순간 CI가 깨지므로, 오케스트레이션은 기계적으로
  usecase로 밀려난다. 여기에 파일 비대화 브레이크(ESLint `max-lines` 400,
  `complexity` 12)를 더했다. 단, **로직의 의미론적 배치 자체(빈약한 유스케이스,
  잘못 놓인 규칙)는 import 그래프로 판별 불가능** — 그 부분은 "domain은 가짜
  포트 없이, usecase는 인메모리 포트로 테스트한다"는 테스트 규약과 리뷰가
  담당한다. 기계가 못 지키는 것을 지킨다고 주장하지 않는다.

## 6. git 훅 — 로컬 빠른 피드백 (게이트는 아님)

**결정: 의존성 0으로 `.githooks/pre-push`에서 `pnpm check` 실행, `prepare`가 설치.**

- 커밋한 `.githooks/` + `pnpm install` 시 도는 `prepare` 스크립트
  (`git config core.hooksPath .githooks`)로 훅을 배포한다. husky 등 추가
  패키지 없이 순수 git + pnpm만 쓴다.
- **역할은 편의이지 게이트가 아니다:** `--no-verify`로 우회되고, 훅이 설치
  안 된 클론/샌드박스에선 아예 안 돈다. 그래서 "함부로 못 깨게 막는" 실제
  관문은 CI의 `checks` 잡 + 브랜치 보호이고, 훅은 CI까지 안 가고 push 전에
  같은 묶음을 로컬에서 몇 초 만에 잡아주는 것뿐이다. 둘은 대체 관계가 아니다.
- **pre-push를 고른 이유:** `pnpm check`는 유닛테스트까지 돌아 커밋마다 걸면
  마찰이 크다. push 직전 한 번이 마지막 로컬 방어선으로 적절하다. 실패 시
  종료코드가 0이 아니면 push가 차단된다(확인함).

## 7. 웹 서버 — 프레임워크 없이 node:http

**결정: `apps/server`는 node 내장 `http`로 시작한다. 웹 프레임워크는 도입하지 않는다.**

- 골든패스 1단계는 채팅 화면 HTML 하나를 GET `/`로 내려주는 것뿐이다.
  Express/Fastify 같은 프레임워크는 아직 값을 증명하지 못한다("필요가
  증명될 때만" 원칙). 라우팅은 `apps/server/src/server.ts`의 작은 분기로
  충분하고, 화면은 순수 함수 `ui.ts`가 문자열로 그린다(유닛테스트로 고정).
- **에이전트 진행 스트리밍은 SSE로 한다(내장 http만으로).** 서버가 세션
  갱신(`SessionUpdate`)을 `text/event-stream`으로 흘리고, 브라우저는
  `EventSource`로 받는다. 양방향이 필요 없는 단방향 진행 스트림이라
  WebSocket까지 갈 이유가 없다. 늦게 접속한 구독자를 위해 세션별로 지나간
  갱신을 버퍼에 담아 재생한다(`session-hub.ts`).
- **기동 확인용 `/healthz`:** Playwright webServer가 준비를 기다릴 엔드포인트
  (§8). 200 "ok"만 돌려준다.

## 9. 샌드박스·에이전트·GitHub 어댑터 (골든패스 2~7단계)

**결정: 포트(SandboxPort/AgentPort/GitHostPort)를 실제 CLI·API로 구현하고, 샌드박스 접근은 하나의 SandboxPort로 공유한다.**

- **샌드박스 = @devcontainers/cli.** `create`는 레포를 얕은 클론한 임시
  워크스페이스에 devcontainer를 띄운다. 레포에 `.devcontainer`가 없으면 기본
  설정(node 이미지)을 얹고, 있으면 존중한다. `sandboxId`는 워크스페이스 경로
  (devcontainer 서브커맨드가 `--workspace-folder`로 컨테이너를 식별하므로).
  CLI bin은 `createRequire`로 경로를 풀어 `node`로 직접 실행한다 — pnpm이 bin을
  워크스페이스 패키지 `.bin`에만 링크해 서버 PATH엔 없기 때문.
- **codex는 샌드박스 안에서 실행.** 호스트의 `~/.codex`(구독 인증, §2)를
  컨테이너에 바인드 마운트하고, `up` 이후 컨테이너 안에 codex CLI를 설치한다.
  `AgentPort`는 주입받은 `SandboxPort.execStream`으로 codex를 돌려 진행 출력을
  줄 단위로 UI에 흘린다 — 어댑터가 devcontainer 세부를 다시 알 필요가 없다.
- **codex 자체 샌드박스는 끈다(`--dangerously-bypass-approvals-and-sandbox`).**
  codex의 `workspace-write` 샌드박스는 bubblewrap을 쓰는데, devcontainer(중첩
  컨테이너) 안에서는 네임스페이스 생성 권한이 없어 `bwrap: No permissions to
  create new namespace`로 파일 편집이 막힌다. devcontainer가 이미 격리 경계이므로
  codex 자체 샌드박스는 불필요하고, 이 플래그의 공식 용도가 바로 "외부에서
  샌드박스된 환경에서의 실행"이다. (골든패스 E2E 로그로 확인한 실제 실패였다.)
- **GitHub = 샌드박스 git + REST.** `diffSummary`는 샌드박스에서 `git diff`
  (새 파일은 intent-to-add로 포함). `openPullRequest`는 브랜치를 만들어 커밋·
  푸시(클론 시 토큰이 박힌 origin 사용)한 뒤 REST로 PR을 연다. URL/헤더/본문
  구성 같은 순수 부분은 함수로 분리해 유닛테스트로 고정했다.
- **토큰이 없어도 서버는 뜬다.** 채팅 화면(1단계)은 토큰 없이 보이고, 토큰이
  필요한 조작(푸시·PR)만 그 시점에 명확한 에러로 실패한다. 시크릿 미설정이
  1단계를 회귀시키지 않게 하려는 것 — 조용한 실패가 아니라 필요한 자리에서
  큰 소리로 실패한다.
- **진짜 검증은 CI의 시나리오 E2E다.** 이 어댑터들은 Docker·codex 구독 인증·
  실제 GitHub 토큰이 있어야 실제로 돈다(목 금지 원칙). 도메인·유스케이스는
  인메모리 포트 유닛테스트로, 서버·UI·SSE는 브라우저로 검증하지만, 세 외부
  통합의 최종 진실은 여전히 실제 E2E다. CI가 어떤 spec을 도는지는 §11 참고.

## 8. 서버 실행 — 빌드 스텝 없이 tsx로 TS 직접 실행

**결정: `tsx`를 devDependency로 두고 `pnpm dev`(= `tsx apps/server/src/index.ts`)로 서버를 띄운다.**

- 이 레포는 빌드 스텝이 없다(`noEmit`, vitest·playwright 모두 TS를 직접 실행).
  서버도 같은 결을 따라 트랜스파일 산출물 없이 실행한다.
- **node 내장 타입 스트리핑을 못 쓰는 이유:** node 22의
  `--experimental-strip-types`는 `node_modules` 안의 `.ts`를 거부한다
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). 워크스페이스 패키지
  (`@devspace/core` 등)는 심링크로 `node_modules`에 들어오고 `exports`가
  `./src/index.ts`를 가리키므로, 내장 방식으로는 서버가 core를 import하는
  순간 깨진다. `tsx`는 이를 문제없이 처리한다.
- **E2E 연결:** `playwright.config.ts`의 `webServer`가 `pnpm dev`로 서버를
  띄우고 `/healthz` 200을 기다린 뒤 시나리오를 실행한다. 로컬에 이미 서버가
  떠 있으면 재사용하고(`reuseExistingServer`), CI에서는 항상 새로 띄운다.

## 10. 세션 재접속 — URL 해시 + 인메모리 버퍼 재생 (범위 한정)

**결정: 세션 id를 `location.hash`에 보존하고, 재접속은 서버의 인메모리 버퍼 재생만으로 성립시킨다. 지속 저장소는 도입하지 않는다.**

- **왜 해시인가:** 세션 id를 브라우저 JS 변수에만 두면 새로고침에 유실된다.
  `location.hash`에 두면 새로고침·북마크에도 남고, "없는 세션으로 접속"
  엣지도 주소만으로 재현·테스트된다(`sessionStorage`보다 관측 가능). 로드 시
  해시가 있으면 곧바로 `/api/sessions/:id/events`를 재구독하고, 서버가 세션별
  버퍼를 재생하므로(§7) 지나간 진행이 되살아난다.
- **범위를 프로세스 생존 중으로 한정한다:** `SessionHub`는 여전히 인메모리
  맵이다. 프로세스가 살아 있는 한 재접속은 버퍼 재생만으로 완성되므로, 지금은
  여기까지만 구현한다. 프로세스 재시작 후 복원(파일/SQLite 등 지속 저장소)은
  이슈 D(다중 세션)와 함께 다룰 후속 과제다 — 새 외부 의존은 그때 필요가
  증명되면 이 문서에 결정으로 남긴다.
- **없는 세션은 큰 소리로 실패한다(조용한 실패 금지):** 서버는 스트림을 열기
  **전에** 세션 존재를 확인해 없으면 404로 끊는다. 브라우저 `EventSource`는
  이를 CLOSED로 판단해 재시도하지 않고, 클라이언트가 "이전 세션을 찾을 수
  없습니다" 안내를 띄우고 시작 바를 되살린다. (200으로 스트림을 연 뒤 닫으면
  EventSource가 정상 종료로 보고 무한 재접속하므로, 열기 전에 끊는 것이 핵심.)

## 11. CI는 골든패스만이 아니라 전체 시나리오 E2E를 돈다

**결정: CI의 시나리오 잡이 `pnpm e2e`로 `e2e/`의 모든 spec을 순차 실행한다. (이전엔 `pnpm e2e:golden-path` 하나만 돌았다.)**

- **왜 바꾸나:** CLAUDE.md의 원천 진실 규약은 "시나리오 1개 = e2e 1개, 목 없이
  실제 통과"다. 그런데 골든패스 하나만 CI에 태우니 재접속(§10)·종료 상태 회귀·
  반복 지시 후 PR 시나리오는 머지돼도 자동 검증되지 않았다 — spec은 있는데
  관문이 없어, 회귀가 CI를 통과해버릴 수 있었다.
- **비용 판단:** 각 시나리오는 실제 샌드박스·codex·GitHub을 통과하는 ~20분짜리
  이고 `workers:1`로 순차 실행이라 실행 시간이 합산된다("최소 비용" 원칙과의
  긴장). 그럼에도 **"실제로 통과하는가"의 최종 진실은 실제 E2E뿐**이라는 원칙이
  우선한다 — 에이전트 작업을 "한 줄 추가"로 작게 유지해(§2) 회당 codex 시간을
  줄이는 것으로 비용을 통제하고, 커버리지는 포기하지 않는다.
- **타임아웃:** 잡 `timeout-minutes`를 40 → 120으로 올렸다. per-test 타임아웃
  합(20~25분 × spec 수)에 여유를 둔 상한일 뿐, 실제 소요는 codex가 빨리 끝나면
  훨씬 짧다. 상한이라 정상 실행을 자르지 않으면서 무한 행은 막는다.
- **되돌릴 조건:** 시나리오가 많아져 CI 시간이 아프면, 라벨/`paths` 필터로
  변경 영역만 돌리거나 야간 크론으로 분리하는 선택지를 그때 이 문서에 남긴다.

## 12. CI codex는 낮은 추론 강도로 값싸게 돈다

**결정: CI에서 `~/.codex/config.toml`에 `model_reasoning_effort = "low"`(기본)를 써서 codex를 값싸게 돌린다. 모델 슬러그는 `vars.CODEX_MODEL`로 선택 지정, 미설정이면 codex 기본 모델. (`.github/scripts/codex-config.sh`)**

- **왜 config.toml인가:** codex는 샌드박스(devcontainer) 안에서 돈다. 그런데
  devcontainer 어댑터가 호스트의 `~/.codex`를 컨테이너에 그대로 바인드 마운트
  하므로(§9, `target=/home/node/.codex`), 러너의 `~/.codex/config.toml`이 auth.json
  과 함께 샌드박스 안 codex에 그대로 적용된다. 어댑터·로컬 개발에 손대지 않고
  **CI에서만** 값을 낮출 수 있다 — CLI 플래그를 adapters에 박아 로컬까지 바꾸는
  것보다 경계를 덜 건드린다.
- **왜 추론 강도인가(모델이 아니라):** codex 비용을 지배하는 건 추론 토큰이다.
  시나리오 작업은 "README에 한 줄 추가" 수준(§2)이라 `low`로 충분하고, 모델
  선택보다 효과가 크며 플랜별 모델 슬러그를 추측하지 않아도 된다. 특정 모델이
  필요하면 `CODEX_MODEL` 저장소 변수로 지정한다.
- **무엇을 아끼나(구독은 토큰당 과금이 아니다):** §2대로 인증은 ChatGPT 구독
  이라 토큰당 청구가 없다 — 낮춘 강도가 아끼는 건 (a) E2E가 빨리 끝나 줄어드는
  **GitHub Actions 분**, (b) §11로 4배가 된 codex 사용이 주간/시간당 **rate limit**
  을 치는 위험. 둘 다 CI가 4개 시나리오를 도는 지금 실질적이다.
- **신뢰성 한계:** 너무 낮추면(예: `minimal`) 사소한 편집도 실패해 E2E가
  불안정해질 수 있다. `low`는 "한 줄 추가"엔 안전한 선. 값은 `CODEX_REASONING_EFFORT`
  변수로 조정 가능하고, config.toml 한 줄이라 되돌리기 쉽다. codex가 이 키를
  실제로 존중하는지는 첫 CI 실행 로그로 확인한다.
