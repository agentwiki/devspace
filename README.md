# devspace

개인 서버에 빠르게 설치해 혼자 쓰는, devcontainer 기반 샌드박스 에이전트 코딩 도구.
**"나 혼자 쓰는 Claude Code 웹"** — 최소 비용으로 그 경험을 재현하는 것이 목표다.

## 원칙

1. **단일 사용자, 단일 서버.** 멀티 테넌트, 플릿 배치, warm pool, mTLS 같은
   운영 규모의 고민은 하지 않는다. 필요해지면 그때 한다.
2. **사용자 시나리오가 원천 진실이다.** 모든 기능은 `scenarios/`의 자연어
   시나리오로 기술되고, 각 시나리오는 실제 브라우저·실제 샌드박스·실제
   GitHub을 통과하는 E2E 테스트로 1:1 검증된다. 시나리오로 설명할 수 없는
   기능은 만들지 않는다.
3. **골든패스 우선.** 처음에 실패하는 골든패스 시나리오 테스트를 목표로
   기능을 쌓고, 도중에 발견되는 회귀 이슈는 회귀 시나리오로 고정한다.
4. **자체 웹 채팅.** E2E 테스트 가능성을 위해 외부 챗 플랫폼(Slack/Discord)
   연동 대신 자체 웹 채팅 UI를 쓴다.

## 구성 요소 (최소한)

- 웹 채팅 UI + 세션 관리 — 단일 프로세스 서버
- 샌드박스 — [`@devcontainers/cli`](https://github.com/devcontainers/cli)
- 코딩 에이전트 — Codex CLI (구독 계정, 샌드박스 안에서 실행)
- GitHub — 레포 클론, 브랜치 푸시, PR 생성

## 레포 구조 (헥사고날 — 경계는 CI가 강제)

```
scenarios/           자연어 사용자 시나리오 — 원천 진실 (scenarios/README.md)
e2e/                 시나리오와 1:1 대응하는 Playwright 테스트 (앱 내부 import 금지)
packages/core/       순수 도메인 + 포트 인터페이스 (의존성 0 — 강제됨)
packages/adapters/   포트 구현: devcontainer, codex, GitHub (core만 안다)
apps/server/         조립 루트 + 웹 채팅 UI
docs/                결정 기록 (docs/decisions.md)
```

경계 규칙은 `.dependency-cruiser.cjs`에 있고 `pnpm check:arch`가 검사한다.
자세한 근거: [`docs/decisions.md`](docs/decisions.md) §5.

## 검사와 테스트

```bash
pnpm install
pnpm check             # typecheck + lint + 아키텍처 경계 + 유닛테스트 (커밋 전 필수)

# 시나리오 E2E:
pnpm exec playwright install chromium
cp .env.e2e.example .env.e2e   # E2E_REPO, E2E_GITHUB_TOKEN 채우기
pnpm e2e:golden-path
```

CI(`.github/workflows/scenarios.yml`)는 push/PR마다 골든패스를 실행한다.
**골든패스가 구현될 때까지 이 잡은 의도적으로 빨간불이다** — 그것이 현재
목표 지점이다. 테스트 레포 지정과 Codex 인증 방식은
[`docs/decisions.md`](docs/decisions.md) 참고.

## 이전 코드베이스

2026-07 이전의 멀티테넌트 플랫폼 구현(M1–M24)은
[`legacy/multi-tenant-platform`](https://github.com/agentwiki/devspace/tree/legacy/multi-tenant-platform)
브랜치에 보존되어 있다. 기술적 참고는 가능하지만, 이 브랜치는 새 설계의
출발점이 아니다.
