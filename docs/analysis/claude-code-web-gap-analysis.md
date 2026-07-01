# Claude Code 웹 대비 devspace 갭 (M1 기준)

Claude Code on the web(CCW)의 기능 표면 대비 현재 구현 상태와 채워야 할 항목.
UI 표면 결정은 [`chat-platform-ui-parity.md`](./chat-platform-ui-parity.md) 참조.

범례: ✅ 구현·테스트 · 🟡 계약/설계만 · 🟠 부분 · ❌ 부재

## 기능별 상태

| 기능                                                      | 상태                              |
| --------------------------------------------------------- | --------------------------------- |
| 세션별 격리 환경 + repo clone (`DevcontainerProvisioner`) | ✅                                |
| 리소스 상한 cpu/mem/disk (`ResourceLimitsSchema`)         | ✅                                |
| 에이전트 in-container 실행 (ACP over exec)                | 🟡                                |
| 승인 게이트 (`GuardedOp`, `PermissionDecision`)           | 🟡                                |
| 드라이버 가드레일 (`guardrails.ts`)                       | 🟠                                |
| PR 생성/브랜치 push (FSM `PRE_PR`→`PR_OPEN`)              | 🟡                                |
| 멀티테넌트 authZ + 감사로그                               | 🟡                                |
| 격리 VM (gVisor/Kata)                                     | 🟡                                |
| 재사용 Environment 설정 객체 (세션/설정 분리)             | ❌ 요청이 1회성                   |
| 환경 변수(.env) 설정 (비밀 아닌)                          | 🟠 `SecretSpec`만                 |
| 셋업 스크립트 (root, 에이전트 前)                         | ❌                                |
| 환경 캐싱/스냅샷                                          | ❌                                |
| 네트워크 접근 레벨 (none/trusted/full/custom)             | ❌ 계약에 필드 없음               |
| 기본 allowlist + egress 프록시                            | ❌                                |
| GitHub 스코프-크리덴셜 프록시                             | 🟠 clone/read 토큰 + push wrapper |
| 빌트인 GitHub 툴 (issue/PR/diff/comment)                  | ❌                                |
| PR Auto-fix 루프                                          | ❌                                |
| 채팅 표면 (Slack/Discord)                                 | 🟡 계약만                         |
| diff 뷰 + 라인 코멘트                                     | ❌ GitHub PR 위임                 |
| 세션 공유/아카이브/삭제                                   | ❌                                |
| 대화 트랜스크립트 영속/복원                               | ❌ message 테이블 없음            |
| 유휴 회수(GC)                                             | ❌                                |
| 웹↔CLI 핸드오프 (--remote/teleport)                       | ❌                                |
| 루틴/트리거 (schedule/API/GitHub event)                   | ❌                                |

sandbox 실행 엔진과 FSM·계약은 견고하다. 비어 있는 축은 재사용 환경·셋업·캐싱(B),
네트워크 제어(C), 트랜스크립트 영속(A), GitHub 프록시·Auto-fix(D)다.

## 채워야 할 것

**계약 단계에서 지금** (나중에 바꾸기 비쌈):

- **Environment를 재사용 설정 객체로 분리** — `network`/`env`/`setupScript`/`baseImage`/
  `cache`를 소유하는 `EnvironmentConfig` + `environments` 테이블. 세션 인스턴스와 구분.
  F(웹UI 대체)·H(루틴)·캐싱이 모두 이 위에 얹힌다.
- **네트워크 접근 레벨 필드 + 기본 allowlist 데이터** — `networkAccess` +
  `allowedDomains[]`. 구현(egress 프록시)은 이후, 필드·데이터는 지금 확정.
- **셋업 스크립트 + 스냅샷 캐싱** — `setupScript` 필드 + 실행 후 컨테이너 커밋 재사용
  (`docker commit`/이미지 태깅). 콜드스타트의 최대 레버.
- **대화 트랜스크립트 영속** — `conversationId`별 message/AgentEvent 테이블.
  `events`(버스)와 별개. 세션 재개 시 히스토리 복원 조건.

**구현과 함께**:

- 채팅 표면 — parity 문서 참조. 공용 게이트웨이 계층(코얼레싱/레이트큐/페이지네이션)
  먼저, Slack(1차)·Discord 렌더러 순.
- GitHub 스코프-크리덴셜 프록시 (M3 secrets와 함께).
- PR Auto-fix 루프 (웹훅 구독 → 조사 → push/질문/스킵).

**이후**: 루틴/트리거, 웹↔CLI 핸드오프, 유휴 GC, gVisor/Kata·감사로그.

## 에이전트 종속 기능 (복제 대상 아님)

`CLAUDE.md`, `.claude/*` 훅·스킬·서브에이전트, `/compact`·`/context`, plugins/marketplace,
server-managed settings는 선택한 ACP 에이전트(codex 등)에 종속이다. `AgentBackend` 경계
뒤로 격리하며, devspace 플랫폼의 요구사항이 아니다. devspace가 복제하는 것은 플랫폼
기능(환경·네트워크·캐싱·채팅표면·GitHub프록시·Auto-fix)이다.

## 유지할 토대

agent-agnostic ACP 경계, 계약-우선(zod) 단일 진실원, 사이클 없는 DAG + 단일 상태
writer(orchestrator), air-gap 친화 Drizzle, 백프레셔 검증 full-duplex exec.
