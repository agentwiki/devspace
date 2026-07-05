/**
 * AgentPort 구현 — 샌드박스 안에서 Codex CLI를 돌린다.
 * (README 구성요소: 코딩 에이전트 = Codex CLI, 구독 계정, 샌드박스 안에서 실행)
 *
 * 진짜 검증은 CI의 골든패스 E2E다(구독 인증 auth.json 필요, docs/decisions.md §2).
 * 샌드박스 접근은 주입받은 SandboxPort로만 한다 — 어댑터가 devcontainer 세부를
 * 다시 알 필요가 없다(조립 루트가 같은 SandboxPort를 codex/github에 함께 준다).
 */
import type { AgentPort, SandboxPort } from '@devspace/core';

export function createCodexAgent(sandbox: SandboxPort): AgentPort {
  return {
    async run(sandboxId, instruction, onActivity) {
      // devcontainer가 곧 샌드박스다. codex 자체 샌드박스(workspace-write)는
      // bubblewrap을 쓰는데, 컨테이너 안에서는 네임스페이스를 못 만들어
      // (`bwrap: No permissions to create new namespace`) 파일 편집이 막힌다.
      // 이미 외부에서 격리됐으므로 codex 자체 샌드박스를 끈다 — 이 플래그의
      // 공식 용도가 "외부에서 샌드박스된 환경에서 실행"이다.
      // 진행 출력을 줄 단위로 그대로 UI에 흘린다.
      const result = await sandbox.execStream(
        sandboxId,
        ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', instruction],
        onActivity,
      );
      if (result.code !== 0) {
        throw new Error(`codex 실행 실패 (code ${result.code}): ${result.stderr || result.stdout}`);
      }
    },
  };
}
