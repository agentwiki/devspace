/**
 * 어댑터 — core가 정의한 포트의 구현이 사는 곳.
 *   devcontainer.ts → SandboxPort (@devcontainers/cli)
 *   codex.ts        → AgentPort  (Codex CLI, 샌드박스 안에서 실행)
 *   github.ts       → GitHostPort (GitHub REST + 샌드박스 git)
 *
 * 규칙(.dependency-cruiser.cjs가 강제): core에만 의존할 수 있고,
 * server를 알아서는 안 된다. 이 패키지를 import할 수 있는 곳은 server뿐.
 */
export type { SandboxPort, AgentPort, GitHostPort } from '@devspace/core';
export { createDevcontainerSandbox, type DevcontainerOptions } from './devcontainer';
export { createCodexAgent } from './codex';
export { createGitHubHost, type GitHubOptions } from './github';
