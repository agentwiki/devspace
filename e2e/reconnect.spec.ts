/**
 * scenarios/reconnect.md 의 1:1 실행 버전.
 * 각 test.step 제목은 시나리오 "흐름"의 번호와 문장을 그대로 따른다.
 */
import { test, expect } from '@playwright/test';
import { env } from './support/env';
import { snap } from './support/snap';
import {
  getPullRequestByUrl,
  getPullRequestDiff,
  cleanupPullRequest,
  type PullRequest,
} from './support/github';

// 샌드박스 준비 + 에이전트 작업이 포함되므로 넉넉하게 잡는다.
test.setTimeout(20 * 60 * 1000);

test('세션 재접속: 새로고침해도 진행 중 세션이 이어진다', async ({ page }, testInfo) => {
  let pr: PullRequest | undefined;

  try {
    await test.step('1. 레포를 지정해 세션을 시작하고, 샌드박스 준비 후 지시를 보낸다', async () => {
      await page.goto(env.devspaceUrl);
      await page.getByTestId('repo-input').fill(env.e2eRepo);
      await page.getByTestId('start-session-button').click();
      await expect(page.getByTestId('message').filter({ hasText: '샌드박스가 준비되었습니다' })).toBeVisible({
        timeout: 8 * 60 * 1000,
      });
      await page
        .getByTestId('chat-input')
        .fill('README.md 맨 아래에 "Hello from devspace" 한 줄을 추가해줘.');
      await page.getByTestId('send-button').click();
      await expect(page.getByTestId('agent-activity').first()).toBeVisible({
        timeout: 2 * 60 * 1000,
      });
    });

    await test.step('2. 작업이 끝나기 전에 브라우저를 새로고침한다', async () => {
      // 세션 id는 URL 해시에 보존되어 새로고침에도 살아남는다.
      expect(page.url()).toContain('#');
      await page.reload();
    });

    await test.step('3. 새로고침 후에도 같은 세션 화면과 그동안의 진행이 그대로 재생된다', async () => {
      // 서버 버퍼 재생으로 준비 메시지·보낸 지시·에이전트 진행이 되살아난다.
      await expect(page.getByTestId('message').filter({ hasText: '샌드박스가 준비되었습니다' })).toBeVisible({
        timeout: 30 * 1000,
      });
      await expect(page.getByTestId('message').filter({ hasText: 'Hello from devspace' })).toBeVisible();
      await expect(page.getByTestId('agent-activity').first()).toBeVisible();
      await snap(page, testInfo, '03-after-reload-replayed');
    });

    await test.step('4. 작업이 끝나면 변경 요약과 "PR 만들기" 버튼이 정상적으로 나타난다', async () => {
      await expect(page.getByTestId('diff-summary')).toContainText('README.md', {
        timeout: 8 * 60 * 1000,
      });
      await expect(page.getByTestId('create-pr-button')).toBeVisible();
      await snap(page, testInfo, '04-diff-summary');
    });

    await test.step('5. "PR 만들기"를 누르면 PR 링크가 나타나고, 그 PR은 실제로 열려 요청한 diff를 담고 있다', async () => {
      await page.getByTestId('create-pr-button').click();
      await expect(page.getByTestId('pr-link')).toBeVisible({ timeout: 2 * 60 * 1000 });
      await snap(page, testInfo, '05-pr-link');
      const prUrl = await page.getByTestId('pr-link').getAttribute('href');
      expect(prUrl).toBeTruthy();
      pr = await getPullRequestByUrl(prUrl!);
      expect(pr.state).toBe('open');
      const diff = await getPullRequestDiff(pr);
      expect(diff).toContain('README.md');
      expect(diff).toContain('+Hello from devspace');
    });
  } finally {
    await test.step('정리: 테스트 PR을 닫고 브랜치를 지운다', async () => {
      if (pr) await cleanupPullRequest(pr);
    });
  }
});

test('엣지: 존재하지 않는 세션으로 재접속하면 명확히 안내한다', async ({ page }, testInfo) => {
  // 샌드박스·토큰이 필요 없다 — 세션을 만들지 않는 순수 UI 흐름이다.
  await test.step('1. 존재하지 않는 세션 id를 가리키는 주소로 접속한다', async () => {
    await page.goto(`${env.devspaceUrl}#00000000-0000-0000-0000-000000000000`);
    await expect(page.getByTestId('chat-screen')).toBeVisible();
  });

  await test.step('2. "이전 세션을 찾을 수 없습니다"라는 명확한 안내가 보인다', async () => {
    await expect(page.getByTestId('session-status')).toContainText('찾을 수 없습니다', {
      timeout: 30 * 1000,
    });
    await snap(page, testInfo, 'edge-session-not-found');
  });

  await test.step('3. 세션 시작 바가 다시 활성화되어 새 세션을 시작할 수 있다', async () => {
    await expect(page.getByTestId('repo-input')).toBeEnabled();
    await expect(page.getByTestId('start-session-button')).toBeEnabled();
  });
});
