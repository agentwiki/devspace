/**
 * GitHostPort 구현 — 샌드박스의 git으로 변경을 커밋·푸시하고 GitHub REST로 PR을 연다.
 * (README 구성요소: GitHub = 레포 클론·브랜치 푸시·PR 생성)
 *
 * 샌드박스 git 조작은 주입받은 SandboxPort로, 원격 API 호출은 fetch로 한다.
 * 순수 부분(URL·헤더·본문 구성, 응답 해석)은 아래에서 함수로 분리해 유닛테스트로 고정한다.
 * 실제 네트워크가 필요한 부분의 진짜 검증은 CI의 골든패스 E2E다.
 */
import type { ExecResult, GitHostPort, OpenPullRequestInput, SandboxPort } from '@devspace/core';

const API = 'https://api.github.com';
const GIT_NAME = 'devspace';
const GIT_EMAIL = 'devspace@users.noreply.github.com';

export interface GitHubOptions {
  token: string;
}

export function apiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'devspace',
  };
}

export function pullRequestBody(input: OpenPullRequestInput, baseBranch: string): string {
  return JSON.stringify({ title: input.title, head: input.branch, base: baseBranch });
}

/** GitHub 응답에서 PR URL을 뽑는다. 실패 응답은 조용히 넘기지 않고 던진다. */
export function pullRequestUrl(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'html_url' in payload) {
    const url = (payload as { html_url: unknown }).html_url;
    if (typeof url === 'string') return url;
  }
  throw new Error(`PR 생성 응답에 html_url이 없습니다: ${JSON.stringify(payload)}`);
}

async function githubJson(url: string, token: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: apiHeaders(token) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${init?.method ?? 'GET'} ${url} 실패 (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function ensureOk(result: ExecResult, what: string): ExecResult {
  if (result.code !== 0) {
    throw new Error(`${what} 실패 (code ${result.code}): ${result.stderr || result.stdout}`);
  }
  return result;
}

export function createGitHubHost(sandbox: SandboxPort, options: GitHubOptions): GitHostPort {
  const sh = (sandboxId: string, script: string): Promise<ExecResult> =>
    sandbox.exec(sandboxId, ['sh', '-c', script]);

  return {
    async diffSummary(sandboxId) {
      // 클론 시점(origin/HEAD)과 비교한다 — codex가 변경을 커밋했든 워킹트리에
      // 남겼든 모두 잡힌다. 추적 안 되는 새 파일까지 보이도록 intent-to-add 후 diff.
      const result = ensureOk(await sh(sandboxId, 'git add -A -N && git diff origin/HEAD'), 'git diff');
      return result.stdout;
    },

    async openPullRequest(sandboxId, input) {
      if (!options.token) {
        throw new Error('GitHub 토큰이 설정되지 않았습니다 (E2E_GITHUB_TOKEN 또는 GITHUB_TOKEN)');
      }
      const defaultBranch = await getDefaultBranch(input.repo, options.token);
      // 브랜치를 만들고 변경을 커밋해 origin(클론 시 토큰 포함 URL)으로 푸시한다.
      ensureOk(
        await sh(
          sandboxId,
          [
            `git config user.email "${GIT_EMAIL}"`,
            `git config user.name "${GIT_NAME}"`,
            `git checkout -b "${input.branch}"`,
            'git add -A',
            // codex가 이미 커밋했으면 추가로 커밋할 게 없다 — 그 경우 커밋을 건너뛴다.
            `(git diff --cached --quiet || git commit -m "${input.title.replace(/"/g, '\\"')}")`,
            `git push -u origin "${input.branch}"`,
          ].join(' && '),
        ),
        'git push',
      );

      const payload = await githubJson(`${API}/repos/${input.repo}/pulls`, options.token, {
        method: 'POST',
        body: pullRequestBody(input, defaultBranch),
      });
      return { url: pullRequestUrl(payload) };
    },
  };
}

async function getDefaultBranch(repo: string, token: string): Promise<string> {
  const payload = await githubJson(`${API}/repos/${repo}`, token);
  if (payload && typeof payload === 'object' && 'default_branch' in payload) {
    const branch = (payload as { default_branch: unknown }).default_branch;
    if (typeof branch === 'string') return branch;
  }
  throw new Error(`레포 기본 브랜치를 알 수 없습니다: ${repo}`);
}
