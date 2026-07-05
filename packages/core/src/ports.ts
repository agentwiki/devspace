/**
 * 포트 — 육각형의 바깥 경계. core는 인터페이스만 정의하고,
 * 구현은 @devspace/adapters, 조립은 apps/server가 한다.
 * 골든패스가 요구하는 최소한만 정의한다. 필요해질 때 넓힌다.
 */

/** devcontainer 샌드박스 (구현: @devcontainers/cli 어댑터) */
export interface SandboxPort {
  /** 레포를 클론한 샌드박스를 만들고 식별자를 돌려준다 */
  create(repo: string): Promise<{ sandboxId: string }>;
  destroy(sandboxId: string): Promise<void>;
}

/** 코딩 에이전트 (구현: codex CLI 어댑터) */
export interface AgentPort {
  /** 샌드박스 안에서 지시를 수행하고, 진행 상황을 콜백으로 흘린다 */
  run(sandboxId: string, instruction: string, onActivity: (line: string) => void): Promise<void>;
}

/** 깃 호스팅 (구현: GitHub API 어댑터) */
export interface GitHostPort {
  /** 샌드박스의 변경을 브랜치로 푸시하고 PR을 연다 */
  openPullRequest(sandboxId: string, repo: string, title: string): Promise<{ url: string }>;
  /** 작업 후 변경 요약(diff)을 얻는다 */
  diffSummary(sandboxId: string): Promise<string>;
}
