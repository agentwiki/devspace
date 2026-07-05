/**
 * 포트 조립 — 실제 어댑터를 꽂아 SessionPorts를 만든다. adapters를 import하는
 * 유일한 곳이다(경계 규칙 only-server-composes-adapters).
 *
 * 토큰(E2E_GITHUB_TOKEN/GITHUB_TOKEN)이 없어도 서버 자체는 뜬다 — 채팅 화면은
 * 보이고, 토큰이 필요한 조작(푸시·PR 생성)만 그 시점에 명확한 에러로 실패한다.
 * (조용한 실패 금지: 없는 걸 없다고 그 자리에서 알린다.)
 */
import { createCodexAgent, createDevcontainerSandbox, createGitHubHost } from '@devspace/adapters';
import type { SessionPorts } from '@devspace/core';

export function buildPorts(): SessionPorts {
  const token = process.env.E2E_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  const sandbox = createDevcontainerSandbox(token ? { token } : {});
  const agent = createCodexAgent(sandbox);
  const gitHost = createGitHubHost(sandbox, { token });
  return { sandbox, agent, gitHost };
}
