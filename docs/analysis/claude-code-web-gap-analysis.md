# Claude Code 웹 기능 요구사항 분석 & devspace 갭 검토

> 목적: "온프레미스에서 가볍게 띄우는 Claude Code 웹"을 목표로 하는 이 프로젝트가
> **실제 Claude Code on the web의 기능 표면 대비 어디까지 왔고, 무엇이 비어 있는지**를
> 근거 기반으로 정리한다. 기준 문서는 Anthropic 공식 문서
> (`code.claude.com/docs/en/claude-code-on-the-web`, `.../sandboxing`,
> `.../routines`)와 현재 이 세션이 실행 중인 웹 실행 환경의 관측 사실이다.
> 현 코드 상태는 M1(sandbox-core 수직 완성) 기준이며 나머지 서비스는 M0 스텁이다.

---

## 1. 기준: Claude Code 웹의 기능 요구사항 (spec)

관측·문서 기반으로 기능을 9개 영역으로 분해한다. 각 항목은 "이 제품을 복제하려면
반드시 있어야 하는 능력"이다.

### A. 세션 & 환경 수명주기
- 세션마다 **격리된 Anthropic 관리 VM**을 새로 띄우고 레포를 fresh clone.
- 세션은 **브라우저를 닫아도 지속**되고, 모바일 앱에서 이어서 모니터링 가능.
- 유휴 시간이 지나면 환경을 **회수(reclaim)**; 세션을 다시 열면 새 환경을
  프로비저닝하되 **대화 히스토리는 복원**된다.
- 리소스 상한: 4 vCPU / 16 GB RAM / 30 GB disk (근사값).

### B. 환경(Environment) = 재사용 가능한 설정 객체
세션(1회성 실행)과 **환경(재사용 설정)**이 분리되어 있다. 환경은 다음을 소유한다:
- **네트워크 접근 레벨** (아래 C)
- **환경 변수** (`.env` 포맷, `KEY=value`)
- **셋업 스크립트** (Bash, root, Ubuntu 24.04, 에이전트 기동 *전* 실행)
- 이름/아카이브, `--remote` 기본 환경 지정(`/remote-env`)
- **환경 캐싱(스냅샷)**: 셋업 스크립트가 1회 실행된 뒤 파일시스템을 스냅샷하여
  이후 세션은 의존성/도커 이미지가 이미 깔린 상태로 시작(스크립트 스킵).
  스크립트/네트워크 변경 시 또는 ~7일 만료 시 재빌드. **콜드스타트의 핵심 레버.**

### C. 네트워크 접근 제어 (1급 기능)
- 레벨: **None / Trusted / Full / Custom**.
- **Trusted 기본 allowlist**: 패키지 레지스트리(npm/PyPI/crates/…), GitHub,
  컨테이너 레지스트리, 클라우드 SDK 등 방대한 도메인 목록.
- **Custom allowlist**: 도메인/`*.wildcard`, 기본 목록 포함 여부 토글.
- 모든 아웃바운드는 **보안 프록시** 경유(악성요청 차단·레이트리밋·콘텐츠 필터·
  DNS 감사 로그). GitHub은 **별도 프록시**.

### D. GitHub 통합
- **GitHub 프록시**: 컨테이너 안에는 **스코프된 커스텀 크리덴셜**만 존재,
  프록시가 이를 실제 토큰으로 번역. `git push`는 **현재 작업 브랜치로 제한**.
  실토큰이 샌드박스에 들어가지 않음.
- **빌트인 GitHub 툴**: 이슈/PR 읽기, diff, 코멘트 작성 — 별도 셋업 없이.
- **PR 자동수정(Auto-fix)**: PR 웹훅 구독 → CI 실패/리뷰코멘트 이벤트마다
  조사 → 확실하면 fix push, 모호하면 사용자에게 질문, 중복이면 스킵.
  (GitHub App 설치 필요; 웹훅 소스.)
- PR 생성, 브랜치 push.

### E. 에이전트 실행 & 가드레일
- 에이전트가 샌드박스 *안*에서 실행되고 stdout/tool-call을 스트리밍.
- 승인 게이트(권한 요청 → 사용자 allow/deny).
- 샌드박스 자체 경계(OS 레벨 fs/네트워크 격리)로 대부분의 명령을 프롬프트 없이 실행.
- 서브에이전트/에이전트팀, `/compact`·`/context` 컨텍스트 관리(에이전트 종속).

### F. 상호작용 표면 (웹 UI)
- `claude.ai/code` 웹 UI + 모바일 + 데스크톱.
- **Diff 뷰 + 라인별 인라인 코멘트** → 다음 메시지로 에이전트에 전달.
- **CI 상태 바**, 세션 사이드바, 세션 **공유/아카이브/삭제**.
- 세션 링크·transcript URL, 커밋/PR에 세션 URL trailer.

### G. 웹 ↔ 터미널 핸드오프
- `--remote`: 로컬에서 클라우드 세션 생성(현재 브랜치 clone; GitHub 없으면 번들 업로드).
- `--teleport` / `/teleport` / `/tasks`→`t`: 클라우드 세션을 로컬로 끌어와 이어서 작업.
- 병렬 세션: `--remote` 여러 개가 독립 세션으로 동시 실행, `/tasks`로 모니터링.

### H. 루틴 / 트리거 (Routines)
- 작업을 **스케줄**, **API 호출**, 또는 **GitHub 이벤트**에 반응해 자동 실행.
- 환경 + 네트워크 접근을 재사용.

### I. 보안 & 멀티테넌시
- 세션별 격리 VM, 크리덴셜은 샌드박스 밖(프록시 스코프 크리덴셜).
- 조직 정책은 server-managed settings로 별도 전달.
- 네트워크 기본 제한, None에서도 Anthropic API로는 통신 가능(데이터 유출 경로 주의).

---

## 2. 현재 프로젝트 매핑

범례: ✅ 구현(테스트됨) · 🟡 설계/계약만 · 🟠 부분 · ❌ 부재

| # | Claude Code 웹 기능 | devspace 현황 | 근거 |
|---|---|---|---|
| A1 | 세션별 격리 환경 + repo clone | ✅ `DevcontainerProvisioner` (shallow clone → `devcontainer up`) | M1 완료 |
| A2 | 브라우저 닫아도 세션 지속 | 🟡 FSM/WorkUnit은 Postgres 영속 | `stateMachine.ts` |
| A3 | 유휴 회수 + 히스토리 복원 | ❌ 유휴 GC 없음, **대화 트랜스크립트 저장소 자체가 없음** | schema에 message 테이블 부재 |
| A4 | 리소스 상한 | ✅ `ResourceLimitsSchema` (cpu/mem/disk) + runArgs 주입 | contracts, provision |
| B1 | 재사용 가능한 **환경 설정 객체** | ❌ `CreateEnvironmentRequest`는 매 프로비저닝 1회성; 이름/재사용/아카이브 없음 | contracts |
| B2 | 환경 변수(.env) 설정 | 🟠 `SecretSpec`(env 주입)은 있으나 비밀 아닌 **일반 env 설정 개념 없음** | contracts |
| B3 | **셋업 스크립트** (root, 에이전트 前) | ❌ 없음 (`devcontainerOverride`만 존재) | contracts |
| B4 | **환경 캐싱/스냅샷** | ❌ 전무. 로드맵 리스크#4의 warm pool/agent-runtime 캐시와는 별개 | roadmap |
| C1 | 네트워크 접근 레벨(None/Trusted/Full/Custom) | ❌ **계약에 네트워크 필드 없음**; egress는 M5로 지연 | security.md |
| C2 | 기본 allowlist + egress 프록시 | 🟡 문서상 "egress allowlist 프록시"만 언급, 미구현 | security.md M5 |
| D1 | GitHub 스코프-크리덴셜 프록시 | 🟠 설계는 "clone/read는 in-container 토큰, push/PR은 orchestrator wrapper" — CCW의 프록시-번역 모델보다 약함 | security.md |
| D2 | 빌트인 GitHub 툴(issue/PR/diff/comment) | ❌ 미모델 | — |
| D3 | **PR Auto-fix 루프** | ❌ 없음 (M5에 "webhooks" 한 줄) | roadmap |
| D4 | PR 생성/브랜치 push | 🟡 FSM(`PRE_PR`→`PR_OPEN`), create-pr 하이브리드 설계 | architecture |
| E1 | 에이전트 in-container 실행(ACP over exec) | 🟡 설계·계약 완비, 미구현(M2) | ADR-0002 |
| E2 | 승인 게이트 | 🟡 `GuardedOp`, `PermissionDecision`, approve 버튼 계약 | contracts |
| E3 | 드라이버 가드레일(allow/deny, 경로 보호, redaction) | 🟠 `guardrails.ts` 일부 구현·테스트 | agent-runner |
| E4 | 턴 예산(wall-clock/tool/token) | 🟡 설계만 | architecture |
| F1 | **웹 UI 표면** | ❌ `web` 플랫폼 enum만 존재; 어댑터는 Discord 우선(M4), 웹은 M6 | contracts, roadmap |
| F2 | Diff 뷰 + 인라인 코멘트 | ❌ 없음 | — |
| F3 | 세션 공유/아카이브/삭제 | ❌ 없음 | — |
| G | 웹↔터미널 핸드오프(--remote/teleport) | ❌ 없음(CLI 클라이언트 개념 자체 없음) | — |
| H | 루틴/트리거(schedule/API/GitHub event) | ❌ 없음 | — |
| I1 | 격리 VM(gVisor/Kata) | 🟡 M5 계획 | roadmap/security |
| I2 | 멀티테넌트 authZ + 감사로그 | 🟡 설계(userId↔conversation 바인딩) | security.md |

**정리**: sandbox 실행 엔진(A1/A4/E1 기반)은 실제로 잘 만들어져 있고, 오케스트레이션
FSM·계약도 견고하다. 그러나 **CCW를 "웹 제품"으로 만드는 상위 절반** — 재사용 환경
+ 셋업스크립트 + 캐싱(B), 네트워크 접근 제어(C), 웹 UI/diff 리뷰(F), PR Auto-fix(D3),
대화 영속/복원(A3) — 은 계약·스키마 수준에서도 대부분 비어 있다.

---

## 3. 이 프로젝트에 필요한 것 (우선순위별 권고)

로드맵의 M2→M3→M4 임계경로는 유효하다. 아래는 **그 경로에 끼워 넣거나 계약을
지금 확장해야 하는 항목**을, "CCW 제품성"에 대한 기여도와 나중에 바꾸기 어려운
정도(계약 파급) 기준으로 정렬한 것이다.

### 지금(계약 단계에서) 반영해야 — 나중에 바꾸기 비쌈

1. **환경(Environment) 설정을 1급 도메인으로 분리** (B1/B2/B3)
   현재 `CreateEnvironmentRequest`는 세션 인스턴스와 재사용 설정을 뒤섞고 있다.
   CCW는 `environment(재사용: network/env/setupScript/baseImage/cache)` ↔
   `session(1회 실행)`을 분리한다. `environments` 테이블 + `EnvironmentConfig`
   스키마를 지금 도입하지 않으면 F/H/캐싱이 전부 이 위에 얹히므로 파급이 커진다.

2. **네트워크 접근 레벨을 계약에 추가** (C1)
   `networkAccess: 'none' | 'trusted' | 'full' | 'custom'` + `allowedDomains[]`를
   `EnvironmentConfig`에 넣는다. 구현(egress 프록시)은 M5로 미뤄도, **필드와 기본
   allowlist 데이터는 지금 확정**해야 오케스트레이터·프로비저너 인터페이스가 안 흔들린다.

3. **셋업 스크립트 + 환경 스냅샷 캐싱** (B3/B4)
   콜드스타트 UX의 최대 레버. `setupScript` 필드 + "스크립트 실행 후 커밋된 컨테이너를
   베이스로 재사용" 파이프라인. sandbox-core가 이미 devcontainer/docker 수명주기를
   쥐고 있으므로 여기에 `docker commit`/이미지 태깅 기반 스냅샷을 붙이는 게 자연스럽다.

4. **대화 트랜스크립트 영속** (A3)
   `messages`(또는 `turns`) 테이블 부재는 "세션을 다시 열면 히스토리 복원"을
   불가능하게 만든다. `events` 테이블은 버스용이지 사용자 대화 렌더용이 아니다.
   `conversationId`별 정규화된 message/AgentEvent 저장을 추가.

### M2~M4 구현과 함께

5. **웹 챗 어댑터를 Discord와 동급 이상으로** (F1/F2)
   목표가 "Claude Code **웹**"이면 1차 표면은 웹이어야 한다. `ChatAdapter`/`RenderCommand`
   추상은 이미 `web`을 포함하니, 최소 웹 UI(세션 목록 + 스트리밍 + **diff 뷰/인라인
   코멘트**)를 M4의 데모 표면으로 승격 권고. Discord는 부가.

6. **GitHub 프록시 모델 강화** (D1)
   현재 "in-container 토큰(read) + wrapper(push)"보다, CCW식 **스코프 크리덴셜 →
   프록시 번역 + push는 작업 브랜치로 제한**이 실토큰 노출을 더 줄인다. M3 secrets
   작업에서 이 모델을 채택할지 결정.

7. **PR Auto-fix 루프** (D3)
   CCW의 대표 차별화. 웹훅 구독 → 이벤트별(조사→push/질문/스킵) 상태머신.
   이 세션 환경 자체가 `subscribe_pr_activity`로 이걸 하고 있으므로 요구사항이 명확.
   M5의 한 줄에서 독립 기능으로 승격 권고.

### 이후(확장)

8. 루틴/트리거(schedule/API/GitHub event) — H.
9. 웹↔CLI 핸드오프(--remote/teleport) — G. 별도 CLI 클라이언트 필요, MVP 범위 밖.
10. 유휴 GC/환경 만료(A3), gVisor/Kata·감사로그(I) — 로드맵 M5대로.

---

## 4. 아키텍처적 주의점: agent-agnostic vs Anthropic-native

CCW의 상당수 기능은 **Anthropic 에이전트에 종속**이다: `CLAUDE.md`, `.claude/*` 훅·
스킬·서브에이전트, `/compact`·`/context`, plugins/marketplace, server-managed settings.
이 프로젝트는 **ACP로 에이전트를 추상화(codex-acp 우선)**하므로 이런 기능은
"선택한 ACP 에이전트가 지원할 때만" 성립한다. 따라서:

- **복제 대상에서 제외/조건부로 명시**할 것: 위 에이전트-종속 기능은 devspace의
  요구사항이 아니라 "에이전트 백엔드의 기능"으로 취급. `AgentBackend` 경계 뒤로 격리.
- **반드시 복제할 것은 플랫폼 기능**: 환경/네트워크/캐싱/웹UI/GitHub프록시/Auto-fix.
  이것들이 "가벼운 온프레미스 CCW"의 실제 정체성이다.

프로젝트가 이미 잘 한 것(유지·강화 권고): agent-agnostic ACP 경계, 계약-우선(zod)
단일 진실원, 사이클 없는 DAG + 단일 상태 writer(orchestrator), air-gap 친화 Drizzle,
백프레셔가 검증된 full-duplex exec. 이 토대 위에 위 3장의 **환경/네트워크/캐싱/웹UI**
네 축을 계약 단계에서 지금 반영하는 것이 이 프로젝트에 가장 필요한 다음 스텝이다.
