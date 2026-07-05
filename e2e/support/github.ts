/** 시나리오 검증·정리용 최소 GitHub API 클라이언트 (테스트 레포 전용). */
import { env } from './env';

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? undefined : res.json();
}

export interface PullRequest {
  number: number;
  state: string;
  html_url: string;
  head: { ref: string };
}

/** PR URL(예: https://github.com/o/r/pull/123)로 PR 정보를 조회한다. */
export async function getPullRequestByUrl(prUrl: string): Promise<PullRequest> {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error(`PR 링크 형식이 아닙니다: ${prUrl}`);
  const [, owner, repo, number] = match;
  if (`${owner}/${repo}` !== env.e2eRepo) {
    throw new Error(`PR이 테스트 레포(${env.e2eRepo})가 아닌 ${owner}/${repo}에 열렸습니다.`);
  }
  return (await api(`/repos/${owner}/${repo}/pulls/${number}`)) as PullRequest;
}

/** PR의 unified diff 본문을 가져온다. */
export async function getPullRequestDiff(pr: PullRequest): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${env.e2eRepo}/pulls/${pr.number}`, {
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      Accept: 'application/vnd.github.diff',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`diff 조회 실패: ${res.status}`);
  return res.text();
}

/** 정리: PR을 닫고 head 브랜치를 삭제한다. 실패해도 테스트를 깨지 않는다. */
export async function cleanupPullRequest(pr: PullRequest): Promise<void> {
  try {
    await api(`/repos/${env.e2eRepo}/pulls/${pr.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
    await api(`/repos/${env.e2eRepo}/git/refs/heads/${pr.head.ref}`, { method: 'DELETE' });
  } catch (error) {
    console.warn(`테스트 PR 정리 실패 (수동 정리 필요할 수 있음): ${error}`);
  }
}
