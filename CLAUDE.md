# devspace — 작업 규칙

혼자 쓰는 "Claude Code 웹". 최소 비용, 그러나 코드 품질은 타협하지 않는다.

## 원천 진실

`scenarios/`의 자연어 사용자 시나리오가 이 프로젝트의 원천 진실이다.
- 기능 추가/변경은 시나리오를 먼저 쓰거나 고친 뒤 구현한다.
- 시나리오 1개 = `e2e/` Playwright 테스트 1개, `test.step` 제목은 시나리오
  단계와 1:1. E2E는 목 없이 실제 브라우저·샌드박스·GitHub을 통과한다.
- 버그는 먼저 `scenarios/regressions/`에 실패하는 시나리오로 고정한 뒤 고친다.

## 구조 (헥사고날 — 어기면 CI가 깨진다)

```
packages/core      순수 비즈니스 로직. import 금지: 외부 패키지, node 내장, 다른 패키지 전부.
  src/domain/        규칙·상태 (ports도 모른다 — 포트가 필요하면 그건 유스케이스다)
  src/ports.ts       바깥에 요구하는 계약 (인터페이스만)
  src/usecase/       오케스트레이션 — domain + ports를 엮는다 (포트 구현은 주입받음)
packages/adapters  포트 구현(devcontainer/codex/GitHub). core만 알 수 있다.
apps/server        조립 루트 + 웹 채팅. 유일하게 adapters를 꽂는 곳.
e2e/               블랙박스 — 앱 내부 코드 import 금지.
```

로직 배치 판별: 포트 없이 성립하는 규칙 → domain, 포트를 엮는 순서 → usecase,
도구 호출 방법 → adapters, HTTP/조립 → server. domain이 포트를 import하는
순간 CI가 깨진다 — 그 코드는 usecase로 옮기라는 뜻이다.

경계는 `.dependency-cruiser.cjs`가 강제한다(`pnpm check:arch`).
규칙을 우회하려 하지 말 것 — 경계를 바꿔야 한다면 규칙 파일과
`docs/decisions.md`를 함께 고치고 그 이유를 기록한다.

## 커밋 전 필수

```bash
pnpm check   # typecheck + lint + check:arch + test:unit — 전부 통과해야 커밋
```

`pnpm install`이 pre-push 훅(`.githooks/pre-push`)을 걸어 push 전에 이 묶음을
자동 실행한다. 훅은 로컬 편의일 뿐 우회 가능하다 — 진짜 관문은 CI의 `checks`
잡이다. 훅을 통과 못 하는 코드를 `--no-verify`로 밀지 말 것.

- 도메인 로직은 유닛테스트와 함께 (vitest, 파일 옆 `*.test.ts`).
- 조용한 실패 금지: 에러를 삼키지 말고 던지거나 명확히 보고한다.
- 새 결정(라이브러리 도입, 경계 변경, 외부 서비스)은 `docs/decisions.md`에 한 항목.
- 패키지 추가는 필요가 증명될 때만 — 기본은 기존 3개 안에서 해결.
