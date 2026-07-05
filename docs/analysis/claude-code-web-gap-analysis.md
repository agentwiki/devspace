# Claude Code 웹 대비 devspace 갭 (M1 기준)

Claude Code on the web(CCW)의 기능 표면 대비 현재 구현 상태와 채워야 할 항목.
UI 표면 결정은 [`chat-platform-ui-parity.md`](./chat-platform-ui-parity.md) 참조.

범례: ✅ 구현·테스트 · 🟡 계약/설계만 · 🟠 부분 · ❌ 부재

## 기능별 상태

| 기능                                                      | 상태                                         |
| --------------------------------------------------------- | -------------------------------------------- |
| 세션별 격리 환경 + repo clone (`DevcontainerProvisioner`) | ✅                                           |
| 리소스 상한 cpu/mem/disk (`ResourceLimitsSchema`)         | ✅                                           |
| 에이전트 in-container 실행 (ACP over exec)                | 🟡                                           |
| 승인 게이트 (`GuardedOp`, `PermissionDecision`)           | 🟡                                           |
| 드라이버 가드레일 (`guardrails.ts`)                       | 🟠                                           |
| PR 생성/브랜치 push (FSM `PRE_PR`→`PR_OPEN`)              | 🟡                                           |
| 멀티테넌트 authZ + 감사로그                               | 🟡                                           |
| 격리 VM (gVisor/Kata)                                     | 🟡                                           |
| 재사용 Environment 설정 객체 (세션/설정 분리)             | ❌ 요청이 1회성                              |
| 환경 변수(.env) 설정 (비밀 아닌)                          | ✅ M24 `env` (repo<tenant<policy, 충돌 거부) |
| 셋업 스크립트 (root, 에이전트 前)                         | ✅ M24 `setupScript` (durable-ready 前 1회)  |
| 환경 캐싱/스냅샷                                          | ❌ (웜풀 fill-time setup이 절반 대체)        |
| 네트워크 접근 레벨 (none/trusted/full/custom)             | ✅ M22 none/custom + M23 extend(운영자 상한) |
| 기본 allowlist + egress 프록시                            | ✅ M5 프록시 + M22 환경별 스코프             |
| GitHub 스코프-크리덴셜 프록시                             | 🟠 clone/read 토큰 + push wrapper            |
| 빌트인 GitHub 툴 (issue/PR/diff/comment)                  | ❌                                           |
| PR Auto-fix 루프                                          | ❌                                           |
| 채팅 표면 (Slack/Discord)                                 | 🟡 계약만                                    |
| diff 뷰 + 라인 코멘트                                     | ❌ GitHub PR 위임                            |
| 세션 공유/아카이브/삭제                                   | 🟠 M21 보존 정책(자동 삭제)만                |
| 대화 트랜스크립트 영속/복원                               | ✅ M20 영속 + M21 `!history` 재생            |
| 유휴 회수(GC)                                             | ✅ M17-M19 reaper/경고/resume                |
| 웹↔CLI 핸드오프 (--remote/teleport)                       | ❌                                           |
| 루틴/트리거 (schedule/API/GitHub event)                   | ❌                                           |

sandbox 실행 엔진과 FSM·계약은 견고하다. 트랜스크립트 영속(A)은 M20이 채웠다
(redact-at-write `transcripts` 테이블 + resume 첫 턴 주입). 네트워크 제어(C)는
M5(egress 프록시) + M22(환경별 접근 레벨) + M23(운영자 상한 아래 테넌트
확장 — CCW custom domains 등가)으로 닫혔다. 재사용 환경 축(B)은 M24가
요청 형상 절반을 닫았다(`env` + `setupScript`, 웜풀 키 합류·resume 패리티);
남은 것은 재사용 `EnvironmentConfig` 객체·스냅샷 캐싱(M25+ 시드)과 GitHub
프록시·Auto-fix(D)다.

## 채워야 할 것

**계약 단계에서 지금** (나중에 바꾸기 비쌈):

- **Environment를 재사용 설정 객체로 분리** — `network`/`env`/`setupScript`/`baseImage`/
  `cache`를 소유하는 `EnvironmentConfig` + `environments` 테이블. 세션 인스턴스와 구분.
  F(웹UI 대체)·H(루틴)·캐싱이 모두 이 위에 얹힌다. M24로 요청 필드
  (`env`/`setupScript`)는 계약에 확정 — 설정 객체는 이 요청 형상으로
  resolve되는 컨트롤플레인 기능으로 M25+ 시드.
- ~~**네트워크 접근 레벨 필드 + 기본 allowlist 데이터**~~ — M22 완료:
  `networkAccess`(none/custom) + `allowedHosts[]`가 계약에 확정, M5 egress
  프록시의 환경별(게이트웨이별) 스코프로 강제까지. M23이 확장(widening)을
  완결: `SANDBOX_TENANT_HOSTS` 운영자 상한 아래에서만 `'extend'`
  (기본 allowlist ∪ 추가 호스트, `net=+host` / 모달 Network 필드) 허용 —
  CCW custom domains 등가. 사용자별 상한은 M24+ 시드.
- ~~**셋업 스크립트**~~ — M24 완료: `setupScript`가 clone 후·durable-ready 전에
  root로 1회 실행(시크릿 미주입 — 웜풀 fill과 동일 실행), 실패/타임아웃 시
  env 파기. 웜풀 키에 합류하므로 풀 템플릿이 스크립트를 실으면 fill 시점에
  선실행된다. **스냅샷 캐싱**(실행 후 `docker commit`/이미지 태깅)은 남은
  절반 — 테넌트 간 이미지 재사용 보안 리뷰와 함께 M25+.
- ~~**대화 트랜스크립트 영속**~~ — M20 완료: `conversationId`별 `transcripts`
  테이블(`events` 버스와 별개), resume 첫 턴 히스토리 주입까지. M21이 인챗
  `!history` 재생과 트랜스크립트/감사 보존 정책(연령 기반 prune)을 얹었다.

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
