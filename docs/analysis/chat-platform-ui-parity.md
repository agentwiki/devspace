# Claude Code 웹 UI 기능을 Discord/Slack으로 대체할 수 있는가

> 배경: 자체 웹 UI는 유지보수 부담이 크다. 대신 Discord/Slack 같은 기존 채팅
> 플랫폼의 **네이티브 기능만으로** Claude Code 웹(CCW)의 UI적 가치를 재현할 수
> 있는지 기능 단위로 철저히 검토한다. 이 문서는
> [`claude-code-web-gap-analysis.md`](./claude-code-web-gap-analysis.md)의 F(웹 UI)
> 축에 대한 후속 의사결정 문서다.

## 요약 결론

**대부분 재현 가능하며, 일부 항목은 오히려 채팅 플랫폼이 더 낫다.** CCW UI 기능을
플랫폼 원시기능(Block Kit / Discord components·threads·forum·App Home)에 대응시키면:

- ✅ **네이티브로 동등하거나 우수**: 승인 버튼, CI 상태 바, 스트리밍(코얼레싱 전제),
  세션 목록/전환, 세션 공유/아카이브, 리포 선택, 알림(모바일 푸시는 오히려 우위),
  첨부/이미지, 플랜 리뷰.
- 🟠 **워크어라운드로 가능(품질 저하)**: diff 렌더링(길이 제한 → 페이지네이션/스니펫),
  긴 툴 로그(스레드로 접기).
- ❌ **어떤 채팅 플랫폼도 네이티브 불가**: **diff의 특정 라인을 클릭해 그 라인에 코멘트를
  다는** CCW/GitHub식 인라인 코드 리뷰. — 단, 이건 **이미 완벽한 대체 홈이 있다: GitHub PR
  자체**. 아래 3.1 참조.

**핵심 통찰**: devspace는 어차피 결과물을 GitHub에 push한다. 따라서 **라인 단위 코드
리뷰는 채팅에서 흉내낼 게 아니라 GitHub PR의 리뷰 UI에 위임**하면 된다. 채팅은 대화·
승인·상태·알림을 맡고, 정밀 코드 리뷰는 GitHub가 맡는 역할 분담이 자연스럽다. 이렇게
보면 "자체 웹 UI 없음"으로 잃는 것은 사실상 없다.

---

## 1. 기능별 대응 매핑

범례: ✅ 네이티브 · 🟠 워크어라운드 · ❌ 불가 / 위임

| CCW UI 기능 | Discord 대응 | Slack 대응 | 판정 |
|---|---|---|---|
| **승인 게이트(권한 버튼)** | Buttons(행5×5줄) + interaction | `actions` 블록 버튼 + `block_actions` | ✅ 이미 계약에 있음(`post_actions`) |
| **CI 상태 바(라이브)** | 상태 메시지 `edit` + 링크/버튼 | `chat.update` + 버튼 | ✅ 메시지 편집으로 |
| **출력 스트리밍** | 메시지 `edit` 반복 | `chat.update` 반복 | 🟠 **토큰 단위 불가**; ~1/sec 코얼레싱 |
| **세션 목록/전환** | **Forum 채널**(글1=세션) / threads + `/sessions` 슬래시(ephemeral) | **App Home 탭**(세션 대시보드) + threads | ✅ 플랫폼별로 오히려 정돈됨 |
| **세션별 대화 격리** | Thread 또는 Forum post | Thread | ✅ |
| **diff 렌더링** | ` ```diff ` 코드블록(2000자/embed 6000자) → 분할 | ` ```diff ` / 파일 스니펫(syntax) | 🟠 길이 제한→페이지네이션 |
| **diff 라인별 인라인 코멘트** | 불가 → 스레드 라인참조 / GitHub PR | 불가 → 스레드 / GitHub PR | ❌ **GitHub PR에 위임** |
| **툴콜/thought/파일편집 렌더** | Embed(제목·필드) | `section`+`context`+`rich_text` | ✅ 상세는 스레드로 |
| **첨부/스크린샷** | 파일 업로드(≤25MB, 부스트 시 ↑) | `files.upload` | ✅ |
| **세션 공유** | 채널/스레드에 멤버·링크 | 채널 공유 / permalink | ✅ 플랫폼 네이티브 |
| **아카이브/삭제** | 스레드 archive / 메시지 삭제 | 채널 archive / App Home에서 숨김 | ✅ |
| **리포 선택** | String select menu | `static_select` | ✅ 이미 `RepoChoice` |
| **플랜 리뷰·반복(review-and-iterate)** | 플랜 메시지 + [Execute/Edit] 버튼 + 스레드 토론 | 동일 + 모달 편집 | ✅ |
| **transcript/permalink** | 메시지 permalink | 메시지 permalink | ✅ |
| **장기작업 모니터링·모바일 푸시** | 네이티브 모바일 푸시 | 네이티브 모바일 푸시 | ✅ **CCW보다 우위**(자체 앱 불필요) |
| **PR Auto-fix 상태 표시** | 상태 메시지 편집 + 버튼 | `chat.update` + 버튼 | ✅ |

---

## 2. 플랫폼 원시기능 제약 (설계 시 반드시 반영)

| 항목 | Discord | Slack |
|---|---|---|
| 메시지 본문 | 2000자(Nitro 4000) | `section` 텍스트 3000자, 메시지 50블록 |
| 리치 컨테이너 | Embed 10개/합 6000자·필드25 | 블록 50개(모달·Home은 100) |
| 버튼 | 행당 5 × 5줄 = 25 | `actions` 블록당 요소 다수 |
| 셀렉트 | string/user/channel/role/mentionable | static/external/users/… + 멀티 |
| 모달 입력 | 컴포넌트 최대 5 | 뷰 100블록, input 다수 |
| 파일 | ≤25MB(부스트↑), 10개 | `files.upload`(스니펫 syntax highlight) |
| **메시지 편집 레이트** | route별 제한, 채널당 버스트 후 스로틀 | **채널당 ~1 msg/sec**(버스트 허용) |
| **채널 이름/설명 편집** | **10분당 2회**(극심) → 상태를 채널명에 넣지 말 것 | 채널명 변경도 제한적 |
| 인터랙션 응답 | 3초 내 ack(defer), 토큰 15분 | 3초 내 응답, `response_url` 30분·5회 |
| 전역 레이트 | 50 req/s | Tier 기반(대략 Tier3 ~50/min류) |
| 세션 대시보드 | Home 탭 **없음**(Forum/thread로 대체) | **App Home 탭 있음**(강점) |

**설계 함의**:
- 스트리밍은 **토큰 단위가 불가능** → agent-runner의 `AgentEvent`를 오케스트레이터에서
  **디바운스/코얼레싱(≈1초, 최종 flush)** 하여 `stream_append`를 편집 1회로 합쳐야 한다.
- 라이브 상태는 **채널명이 아니라 고정(pinned) 상태 메시지 편집**으로. Discord 채널명
  편집 10분/2회 제한 때문에 채널 제목에 진행률을 넣는 설계는 금물.
- 긴 diff/로그는 **본문에 다 넣지 말고** 스레드 + 파일 스니펫 + "N개 파일 변경" 요약 +
  파일별 펼치기 버튼으로 분할.
- 인터랙션 토큰 수명(15~30분)이 짧으므로, 긴 턴의 결과는 인터랙션 응답이 아니라
  **새 메시지(이벤트 기반 RenderCommand)** 로 보낸다. 현 아키텍처(이벤트→RenderCommand)가
  이미 이 패턴이라 잘 맞는다.

---

## 3. 가장 어려운 항목 상세

### 3.1 diff 라인별 인라인 코멘트 → GitHub PR에 위임

CCW의 "diff를 보고 라인을 클릭해 코멘트 → 다음 메시지로 에이전트에 전달"은 채팅
플랫폼에 라인 앵커 개념이 없어 **네이티브 재현이 불가능**하다. 선택지:

1. **(권장) GitHub PR 리뷰 UI에 위임.** devspace는 이미 브랜치를 push하고 PR을 연다.
   라인 단위 리뷰는 GitHub PR에서 하고(사람이 익숙한 최고의 도구), 리뷰 코멘트는
   **PR Auto-fix 웹훅 루프**로 다시 에이전트에 전달된다. 채팅에는 "리뷰 N건 반영함"만.
   → 채팅에서 잃는 게 없고, 라인 리뷰는 더 좋은 도구에서 이뤄진다.
2. **채팅 내 근사치(보조).** 파일별 diff를 스레드로 쪼개 라인번호를 붙여 렌더 →
   사용자가 스레드에서 `L42: …`로 인용 답장 → 파서가 라인 참조로 정규화. 동작하지만
   수동적이고 UX가 열등하다. GitHub 접근이 없는(번들) 세션의 폴백 용도로만.

### 3.2 스트리밍

CCW의 매끄러운 토큰 스트림은 채팅 편집 레이트리밋상 불가. 실용적 목표는
**"살아있는 느낌의 상태 메시지"**: (a) `update_status`로 단계(계획→편집→테스트)를 편집,
(b) 완성된 메시지/파일편집 요약을 새 메시지로, (c) verbose는 스레드. 사용자 체감은
CCW와 큰 차이 없다.

### 3.3 세션 목록 / 사이드바

- **Slack**: **App Home 탭**이 정확한 대응물 — 사용자별로 활성 세션 리스트 + [열기/
  아카이브/PR 보기] 버튼을 100블록까지. 사실상 사이드바를 네이티브로 얻는다.
- **Discord**: Home 탭이 없으므로 **Forum 채널**을 사용 — 포스트 1개 = 세션 1개, 태그로
  상태(WORKING/PR_OPEN) 표시, 목록·검색·아카이브가 포럼 기본기능. 여기에 `/sessions`
  슬래시 커맨드(ephemeral)로 빠른 점프 제공.

---

## 4. 프로젝트 계약에 필요한 변경

현 `@devspace/contracts`의 채팅 계약(`RenderCommand` / `ChatEvent`)은 이 방향과 이미
잘 맞지만, 아래를 추가/보강하면 CCW UI 패리티를 표현할 수 있다.

**`RenderCommand`에 추가 권고**:
- `post_diff` — `{ files: {path, hunks, truncated}[], prUrl? }`: 렌더는 어댑터가
  플랫폼별로(코드블록/스니펫/페이지네이션) 처리, 라인 리뷰는 `prUrl`로 유도.
- `upload_file` — `{ name, mime, bytes|url }`: 스크린샷/생성 파일/대용량 로그.
- `open_thread` / `stream_into: {threadRef}` — verbose 출력을 스레드로 분리.
- `home_upsert`(Slack) / `forum_upsert`(Discord) — 세션 목록 항목 렌더(공용
  `session_card` 추상 + 어댑터 매핑).

**`ChatEvent`에 추가 권고**:
- `review.submitted` — 스레드 라인참조 코멘트(3.1의 폴백) 정규화.
- `session.action`(archive/share/delete/open) — Home/Forum 버튼 인터랙션.

**`ChatAdapter`/`ChatRenderer` 확장**: 위 커맨드의 플랫폼 렌더러. 코얼레싱 버퍼(스트림),
레이트리밋 큐(채널당 ~1/sec), 길이 초과 시 자동 페이지네이션은 **게이트웨이 공용 계층**에
두어 어댑터가 반복 구현하지 않게 한다.

---

## 5. Discord vs Slack, 그리고 최종 판단

| 기준 | Discord | Slack |
|---|---|---|
| 세션 대시보드 | Forum 채널(우수, 태그/검색) | **App Home 탭(정확한 사이드바 대응)** |
| 리치 렌더 | Embed | **Block Kit(더 유연, rich_text/스니펫)** |
| 조직/기업 채택 | 커뮤니티/개발팀 | **엔터프라이즈 표준** |
| 스레드 모델 | 좋음 | 좋음 |
| 상태 편집 제약 | 채널명 편집 극심(주의) | 채널당 1/sec |
| 온프레미스 정합 | 봇 셀프호스트 가능(백엔드) | 봇 셀프호스트 가능(백엔드) |

- **결론**: CCW의 UI적 가치(승인·상태·세션목록·리뷰-반복·알림)는 **Discord/Slack에서
  충분히 재현 가능**하며, 유일한 진짜 손실(라인 인라인 코멘트)은 **GitHub PR 위임**으로
  상쇄된다. 자체 웹 UI를 짓지 않는 결정은 타당하다.
- **플랫폼 권고**: 리치 블록 + App Home(네이티브 세션 사이드바) + 엔터프라이즈 정합성
  때문에 **1차 타깃은 Slack**을 권한다. 단 계약은 이미 플랫폼 중립(`ChatAdapter`)이므로
  Discord(Forum 기반)도 동급으로 지원 가능. 로드맵 M4의 "Discord 우선"을 재검토해
  **어댑터 계층을 먼저 플랫폼-중립으로 굳히고**(코얼레싱/레이트큐/페이지네이션 공용화),
  그 위에 Slack·Discord 렌더러를 병렬로 얹는 순서를 제안한다.
- **버리지 말 것**: 정밀 diff 리뷰는 GitHub PR + Auto-fix 루프로. 이 조합이 "자체 웹
  없는" 이 제품의 리뷰 스토리를 완성한다.
