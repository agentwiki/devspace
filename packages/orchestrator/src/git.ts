/**
 * Deterministic git/PR wrapper — runs ENTIRELY on the host (Decision 1).
 *
 * No writable token ever enters the container: the orchestrator pushes from the
 * host over an HTTPS remote carrying a single-invocation credential (repo hooks
 * and credential helpers disabled so nothing persists it), then opens the PR via
 * the GitHub REST API. The container, at most, holds a read-only clone token.
 *
 * Everything here is either a pure builder (argv / URL / owner-repo parsing —
 * side-effect-free and unit-tested) or a thin call over two injected edges
 * (`HostGitExec`, `GitHubRestClient`) so the whole wrapper is testable with no
 * live git and no live GitHub.
 */
import type { WorkEvent } from '@devspace/contracts';

export class GitError extends Error {
  constructor(
    readonly code: 'BAD_REPO_URL' | 'PUSH_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/* -------------------------------------------------------------------------- */
/* Injected edges                                                              */
/* -------------------------------------------------------------------------- */

export interface HostGitExec {
  run(
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface PullRef {
  number: number;
  htmlUrl: string;
  /** GitHub 'open' | 'closed'; merged is a separate flag. */
  state: 'open' | 'closed';
  merged: boolean;
}

export interface GitHubRestClient {
  createPull(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRef>;
  /** Open PRs whose head is `branch` (idempotency probe before create). */
  listOpenPullsByHead(input: { owner: string; repo: string; branch: string }): Promise<PullRef[]>;
  getPull(input: { owner: string; repo: string; number: number }): Promise<PullRef>;
}

/* -------------------------------------------------------------------------- */
/* Pure builders (no I/O)                                                      */
/* -------------------------------------------------------------------------- */

/** Parse `owner/repo` from an https or ssh GitHub(-Enterprise) URL. */
export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  // git@host:owner/repo(.git)
  const ssh = /^[^@]+@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/.exec(repoUrl);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  // https://host/owner/repo(.git)
  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (https) return { owner: https[1]!, repo: https[2]! };
  throw new GitError('BAD_REPO_URL', `cannot parse owner/repo from '${repoUrl}'`);
}

/**
 * Authenticated HTTPS remote for a single-invocation push. The token rides in
 * the URL so no credential helper is consulted or asked to persist anything.
 */
export function pushRemoteUrl(repoUrl: string, token: string): string {
  const { owner, repo } = parseOwnerRepo(repoUrl);
  const host = hostOf(repoUrl);
  return `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
}

function hostOf(repoUrl: string): string {
  const ssh = /^[^@]+@([^:]+):/.exec(repoUrl);
  if (ssh) return ssh[1]!;
  const https = /^https?:\/\/([^/]+)\//.exec(repoUrl);
  if (https) return https[1]!;
  return 'github.com';
}

/**
 * `git push` argv with hooks and credential helpers disabled. The remote is
 * passed as an explicit URL (not a named remote) so the credential is used once
 * and never written to `.git/config`.
 */
export function pushArgv(remoteUrl: string, branch: string): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
    'push',
    '--force-with-lease',
    remoteUrl,
    `HEAD:refs/heads/${branch}`,
  ];
}

/** Strip an inline `user:token@` credential from a URL before logging. */
export function redactRemoteInText(text: string): string {
  return text.replace(/https:\/\/[^@\s/]+:[^@\s/]+@/g, 'https://***@');
}

/** Map an observed PR to a coarse lifecycle state. */
export function mapPrState(pull: PullRef): 'open' | 'merged' | 'closed' {
  if (pull.merged) return 'merged';
  return pull.state === 'closed' ? 'closed' : 'open';
}

/** Map a polled PR state to the FSM event that advances a PR_OPEN unit. */
export function prStateToEvent(state: 'open' | 'merged' | 'closed'): WorkEvent | null {
  if (state === 'merged') return 'prMerged';
  if (state === 'closed') return 'prClosed';
  return null; // still open — no transition
}

/* -------------------------------------------------------------------------- */
/* Wrapper                                                                     */
/* -------------------------------------------------------------------------- */

export interface OpenPrRequest {
  repoUrl: string;
  branch: string;
  base?: string;
  title: string;
  body: string;
  /** Host-side, single-invocation push/PR credential. Never enters a container. */
  token: string;
  /** Host checkout dir to push from. */
  workdir: string;
}

export interface OpenPrResult {
  prNumber: number;
  prUrl: string;
  /** true when an existing open PR for the branch was adopted (idempotent). */
  adopted: boolean;
}

export class GitWrapper {
  constructor(
    private readonly git: HostGitExec,
    private readonly rest: GitHubRestClient,
  ) {}

  async pushAndOpenPr(req: OpenPrRequest): Promise<OpenPrResult> {
    const { owner, repo } = parseOwnerRepo(req.repoUrl);
    const base = req.base ?? 'main';

    const remote = pushRemoteUrl(req.repoUrl, req.token);
    const res = await this.git.run(pushArgv(remote, req.branch), { cwd: req.workdir });
    if (res.code !== 0) {
      throw new GitError('PUSH_FAILED', redactRemoteInText(res.stderr || res.stdout));
    }

    // Idempotent create-by-branch: adopt an existing open PR instead of failing
    // on a duplicate (a replayed create-pr must not error).
    const existing = await this.rest.listOpenPullsByHead({ owner, repo, branch: req.branch });
    if (existing.length > 0) {
      const pr = existing[0]!;
      return { prNumber: pr.number, prUrl: pr.htmlUrl, adopted: true };
    }

    const pr = await this.rest.createPull({
      owner,
      repo,
      head: req.branch,
      base,
      title: req.title,
      body: req.body,
    });
    return { prNumber: pr.number, prUrl: pr.htmlUrl, adopted: false };
  }

  async pollPrState(req: {
    repoUrl: string;
    prNumber: number;
  }): Promise<'open' | 'merged' | 'closed'> {
    const { owner, repo } = parseOwnerRepo(req.repoUrl);
    const pull = await this.rest.getPull({ owner, repo, number: req.prNumber });
    return mapPrState(pull);
  }
}

/* -------------------------------------------------------------------------- */
/* Live REST client (host-side fetch; injected+faked in tests)                 */
/* -------------------------------------------------------------------------- */

interface GitHubPullJson {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
}

function toPullRef(j: GitHubPullJson): PullRef {
  return {
    number: j.number,
    htmlUrl: j.html_url,
    state: j.state === 'closed' ? 'closed' : 'open',
    merged: j.merged === true || (j.merged_at != null && j.merged_at !== undefined),
  };
}

/**
 * Real GitHub REST client. `baseUrl` defaults to the public API but is
 * overridable for GitHub Enterprise (on-prem). Constructed per-operation with a
 * freshly resolved host token.
 */
export function createGitHubRestClient(
  token: string,
  baseUrl = 'https://api.github.com',
  fetchImpl: typeof fetch = fetch,
): GitHubRestClient {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };
  async function req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${path} -> ${res.status}`);
    }
    return res.json();
  }
  return {
    async createPull({ owner, repo, head, base, title, body }) {
      const j = (await req('POST', `/repos/${owner}/${repo}/pulls`, {
        title,
        head,
        base,
        body,
      })) as GitHubPullJson;
      return toPullRef(j);
    },
    async listOpenPullsByHead({ owner, repo, branch }) {
      const j = (await req(
        'GET',
        `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      )) as GitHubPullJson[];
      return j.map(toPullRef);
    },
    async getPull({ owner, repo, number }) {
      const j = (await req('GET', `/repos/${owner}/${repo}/pulls/${number}`)) as GitHubPullJson;
      return toPullRef(j);
    },
  };
}
