import { describe, expect, it } from 'vitest';
import { apiHeaders, pullRequestBody, pullRequestUrl } from './github';

describe('GitHub 어댑터 순수 헬퍼', () => {
  it('인증 헤더에 Bearer 토큰과 API 버전을 담는다', () => {
    const headers = apiHeaders('tok');
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('PR 본문은 head=브랜치, base=기본 브랜치로 구성한다', () => {
    const body = JSON.parse(
      pullRequestBody({ repo: 'o/r', branch: 'devspace/x', title: '제목' }, 'main'),
    );
    expect(body).toEqual({ title: '제목', head: 'devspace/x', base: 'main' });
  });

  it('응답에서 html_url을 뽑는다', () => {
    expect(pullRequestUrl({ html_url: 'https://github.com/o/r/pull/1' })).toBe(
      'https://github.com/o/r/pull/1',
    );
  });

  it('html_url이 없으면 조용히 넘기지 않고 던진다', () => {
    expect(() => pullRequestUrl({ message: 'Not Found' })).toThrow();
  });
});
