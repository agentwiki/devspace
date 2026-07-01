import { describe, expect, it } from 'vitest';
import {
  GitError,
  GitWrapper,
  mapPrState,
  parseOwnerRepo,
  prStateToEvent,
  pushArgv,
  pushRemoteUrl,
  redactRemoteInText,
  type GitHubRestClient,
  type HostGitExec,
  type PullRef,
} from './git.js';

describe('pure builders', () => {
  it('parses owner/repo from https and ssh URLs', () => {
    expect(parseOwnerRepo('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
    expect(parseOwnerRepo('https://github.com/acme/widgets')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
    expect(parseOwnerRepo('git@github.com:acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
    expect(parseOwnerRepo('https://ghe.corp/team/proj')).toEqual({ owner: 'team', repo: 'proj' });
    expect(() => parseOwnerRepo('not-a-url')).toThrow(GitError);
  });

  it('builds an authenticated single-invocation remote', () => {
    expect(pushRemoteUrl('https://github.com/acme/widgets.git', 'ghs_tok')).toBe(
      'https://x-access-token:ghs_tok@github.com/acme/widgets.git',
    );
    expect(pushRemoteUrl('git@ghe.corp:team/proj.git', 'T')).toBe(
      'https://x-access-token:T@ghe.corp/team/proj.git',
    );
  });

  it('builds a push argv with hooks + credential helper disabled', () => {
    expect(pushArgv('https://x-access-token:T@github.com/a/b.git', 'feat/x')).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      'push',
      '--force-with-lease',
      'https://x-access-token:T@github.com/a/b.git',
      'HEAD:refs/heads/feat/x',
    ]);
  });

  it('redacts inline credentials in surfaced text', () => {
    expect(
      redactRemoteInText('fatal: https://x-access-token:secret@github.com/a/b.git denied'),
    ).toBe('fatal: https://***@github.com/a/b.git denied');
  });

  it('maps PR state and events', () => {
    expect(mapPrState({ number: 1, htmlUrl: 'u', state: 'open', merged: false })).toBe('open');
    expect(mapPrState({ number: 1, htmlUrl: 'u', state: 'closed', merged: true })).toBe('merged');
    expect(mapPrState({ number: 1, htmlUrl: 'u', state: 'closed', merged: false })).toBe('closed');
    expect(prStateToEvent('merged')).toBe('prMerged');
    expect(prStateToEvent('closed')).toBe('prClosed');
    expect(prStateToEvent('open')).toBeNull();
  });
});

function fakeGit(code = 0, stderr = ''): HostGitExec & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      return { stdout: '', stderr, code };
    },
  };
}

function fakeRest(overrides: Partial<GitHubRestClient> = {}): GitHubRestClient & {
  created: number;
} {
  const state = { created: 0 };
  const base: GitHubRestClient = {
    async createPull() {
      state.created += 1;
      return {
        number: 42,
        htmlUrl: 'https://github.com/a/b/pull/42',
        state: 'open',
        merged: false,
      };
    },
    async listOpenPullsByHead() {
      return [];
    },
    async getPull(): Promise<PullRef> {
      return {
        number: 42,
        htmlUrl: 'https://github.com/a/b/pull/42',
        state: 'open',
        merged: false,
      };
    },
  };
  return Object.assign({}, base, overrides, {
    get created() {
      return state.created;
    },
  }) as GitHubRestClient & { created: number };
}

describe('GitWrapper', () => {
  const req = {
    repoUrl: 'https://github.com/a/b.git',
    branch: 'feat/x',
    title: 'T',
    body: 'B',
    token: 'ghs_tok',
    workdir: '/work',
  };

  it('pushes then opens a PR', async () => {
    const git = fakeGit();
    const rest = fakeRest();
    const w = new GitWrapper(git, rest);
    const out = await w.pushAndOpenPr(req);
    expect(out).toEqual({ prNumber: 42, prUrl: 'https://github.com/a/b/pull/42', adopted: false });
    // pushed to the authenticated remote with hooks disabled.
    expect(git.calls[0]).toContain('push');
    expect(git.calls[0]).toContain('https://x-access-token:ghs_tok@github.com/a/b.git');
  });

  it('is idempotent by branch: adopts an existing open PR', async () => {
    const existing: PullRef = {
      number: 7,
      htmlUrl: 'https://github.com/a/b/pull/7',
      state: 'open',
      merged: false,
    };
    const rest = fakeRest({
      async listOpenPullsByHead() {
        return [existing];
      },
    });
    const w = new GitWrapper(fakeGit(), rest);
    const out = await w.pushAndOpenPr(req);
    expect(out).toEqual({ prNumber: 7, prUrl: 'https://github.com/a/b/pull/7', adopted: true });
    expect(rest.created).toBe(0); // never created a second PR
  });

  it('throws PUSH_FAILED with credentials redacted', async () => {
    const git = fakeGit(1, 'fatal: https://x-access-token:ghs_tok@github.com/a/b.git rejected');
    const w = new GitWrapper(git, fakeRest());
    await expect(w.pushAndOpenPr(req)).rejects.toMatchObject({ code: 'PUSH_FAILED' });
    await w.pushAndOpenPr(req).catch((e: GitError) => {
      expect(e.message).not.toContain('ghs_tok');
    });
  });

  it('polls PR state through the REST edge', async () => {
    const rest = fakeRest({
      async getPull() {
        return { number: 42, htmlUrl: 'u', state: 'closed', merged: true };
      },
    });
    const w = new GitWrapper(fakeGit(), rest);
    expect(await w.pollPrState({ repoUrl: req.repoUrl, prNumber: 42 })).toBe('merged');
  });
});
