/**
 * 포트 — 육각형의 바깥 경계. core는 인터페이스만 정의하고,
 * 구현은 @devspace/adapters, 조립은 apps/server가 한다.
 * 골든패스가 요구하는 최소한만 정의한다. 필요해질 때 넓힌다.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** devcontainer 샌드박스 (구현: @devcontainers/cli 어댑터) */
export interface SandboxPort {
  /** 레포를 클론한 샌드박스를 만들고 식별자를 돌려준다 */
  create(repo: string): Promise<{ sandboxId: string }>;
  /** 샌드박스 안에서 명령을 실행하고 출력을 모아서 돌려준다 */
  exec(sandboxId: string, command: readonly string[]): Promise<ExecResult>;
  /** exec와 같으나 표준출력을 줄 단위로 흘려보낸다 (에이전트 진행 스트리밍용) */
  execStream(
    sandboxId: string,
    command: readonly string[],
    onLine: (line: string) => void,
  ): Promise<ExecResult>;
  destroy(sandboxId: string): Promise<void>;
}

/** 코딩 에이전트 (구현: codex CLI 어댑터, 샌드박스 안에서 실행) */
export interface AgentPort {
  /** 샌드박스 안에서 지시를 수행하고, 진행 상황을 콜백으로 흘린다 */
  run(sandboxId: string, instruction: string, onActivity: (line: string) => void): Promise<void>;
}

export interface OpenPullRequestInput {
  /** owner/name */
  repo: string;
  /** 변경을 올릴 새 브랜치 이름 */
  branch: string;
  /** 커밋 메시지 겸 PR 제목 */
  title: string;
}

/** 깃 호스팅 (구현: GitHub API + 샌드박스 git 어댑터) */
export interface GitHostPort {
  /** 작업 후 변경 요약(diff)을 얻는다 */
  diffSummary(sandboxId: string): Promise<string>;
  /** 샌드박스의 변경을 브랜치로 푸시하고 PR을 연다 */
  openPullRequest(sandboxId: string, input: OpenPullRequestInput): Promise<{ url: string }>;
}
