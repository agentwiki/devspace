/**
 * 어댑터 — core가 정의한 포트의 구현이 사는 곳.
 * 골든패스 구현이 진행되며 채워진다:
 *   devcontainer.ts → SandboxPort (@devcontainers/cli)
 *   codex.ts        → AgentPort  (codex CLI)
 *   github.ts       → GitHostPort (GitHub REST API)
 *
 * 규칙(.dependency-cruiser.cjs가 강제): core에만 의존할 수 있고,
 * server를 알아서는 안 된다. 이 패키지를 import할 수 있는 곳은 server뿐.
 */
export type { SandboxPort, AgentPort, GitHostPort } from '@devspace/core';
