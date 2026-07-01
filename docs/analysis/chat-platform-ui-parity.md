# UI 표면: Slack/Discord (자체 웹 UI 없음)

## 설계

UI 표면은 채팅이다. **1차 플랫폼은 Slack**(App Home = 네이티브 세션 사이드바, Block Kit),
Discord는 Forum 채널 기반으로 동급 지원한다. 자체 웹 UI는 만들지 않는다. 채팅은 대화·
승인·상태·세션관리·알림을 담당하고, **정밀 라인 단위 코드 리뷰는 GitHub PR 리뷰에 위임**한다.
`ChatAdapter`는 플랫폼 중립이다.

## Claude Code 웹 UI 기능의 채팅 구현

범례: ✅ 네이티브 · 🟠 워크어라운드 · ❌ 비네이티브(위임)

| 기능                          | Discord                            | Slack                            | 상태                             |
| ----------------------------- | ---------------------------------- | -------------------------------- | -------------------------------- |
| 승인 버튼(권한 게이트)        | Buttons + interaction              | `actions` 블록 + `block_actions` | ✅                               |
| CI 상태 바(라이브)            | 상태 메시지 `edit`                 | `chat.update`                    | ✅                               |
| 출력 스트리밍                 | 메시지 `edit`                      | `chat.update`                    | 🟠 ~1초 코얼레싱(토큰 단위 불가) |
| 세션 목록/전환                | Forum 채널(글1=세션) + `/sessions` | **App Home 탭**                  | ✅                               |
| 세션별 대화 격리              | Thread / Forum post                | Thread                           | ✅                               |
| diff 렌더링                   | ` ```diff ` 블록 → 분할            | 파일 스니펫(syntax)              | 🟠 길이 제한 페이지네이션        |
| diff 라인 인라인 코멘트       | —                                  | —                                | ❌ GitHub PR 위임                |
| 툴콜/thought/파일편집         | Embed                              | `section`+`context`+`rich_text`  | ✅ 상세는 스레드                 |
| 첨부/스크린샷                 | 파일 업로드(≤25MB)                 | `files.upload`                   | ✅                               |
| 세션 공유/아카이브/삭제       | 스레드·메시지                      | 채널·App Home                    | ✅                               |
| 리포 선택                     | Select menu                        | `static_select`                  | ✅                               |
| 플랜 리뷰·반복                | 메시지 + 버튼 + 스레드             | + 모달                           | ✅                               |
| 장기작업 모니터링·모바일 푸시 | 네이티브 푸시                      | 네이티브 푸시                    | ✅                               |

## 유일한 비네이티브: 라인 인라인 코멘트

채팅 플랫폼엔 라인 앵커 개념이 없다. devspace는 결과물을 GitHub에 push하므로 라인 단위
리뷰는 **GitHub PR 리뷰 UI**에서 하고, 리뷰 코멘트는 **PR Auto-fix 웹훅 루프**로 에이전트에
전달한다. 채팅에는 "리뷰 N건 반영" 요약만 표시한다.
GitHub 미연결(번들) 세션 폴백: 파일별 스레드 + 라인번호 인용(`L42: …`)을 파서가 정규화.

## 설계를 구속하는 플랫폼 제약

| 항목               | Discord                     | Slack                           |
| ------------------ | --------------------------- | ------------------------------- |
| 메시지 본문        | 2000자(Nitro 4000)          | `section` 3000자, 50블록/메시지 |
| 리치 컨테이너      | Embed 10/합 6000자          | 블록 50(모달·Home 100)          |
| 메시지 편집 레이트 | route별 버스트 후 스로틀    | 채널당 ~1 msg/sec               |
| 채널명 편집        | **10분당 2회**              | 제한적                          |
| 인터랙션 응답      | 3초 ack, 토큰 15분          | 3초, `response_url` 30분·5회    |
| 세션 대시보드      | Home 탭 없음 → Forum/thread | **App Home 탭**                 |

이로부터 고정된 구현 규칙:

- **스트림**: 게이트웨이 공용 계층에서 ~1초 코얼레싱 + 채널당 레이트큐 + 길이 초과 자동
  페이지네이션. 어댑터는 렌더만.
- **라이브 상태**: 고정 상태 메시지 편집. 채널명에 진행률을 넣지 않는다(Discord 편집 제한).
- **긴 턴 결과**: 인터랙션 응답이 아니라 이벤트 기반 새 메시지로 보낸다.
- **긴 diff/로그**: 스레드 + 파일 스니펫 + 파일별 펼치기 버튼으로 분할.

## 계약 형태

- `RenderCommand`: `post_message` · `update_status` · `post_actions` · `stream_append` ·
  `post_diff{files, prUrl}` · `upload_file` · `open_thread` · `session_card`(Home/Forum upsert).
- `ChatEvent`: `conversation.created` · `message.posted` · `action.invoked` ·
  `session.action`(archive/share/delete/open) · `review.submitted`(라인참조 폴백).
- 공용 게이트웨이 계층: 코얼레싱 버퍼 · 레이트큐 · 페이지네이션 (어댑터 공통).
