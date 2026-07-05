/**
 * scenarios/golden-path.md 의 1:1 실행 버전.
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

test('골든패스: 채팅으로 코드 수정을 시키고 PR을 받는다', async ({ page }, testInfo) => {
  let pr: PullRequest | undefined;

  try {
    await test.step('1. 접속하면 채팅 화면이 보인다', async () => {
      await page.goto(env.devspaceUrl);
      await expect(page.getByTestId('chat-screen')).toBeVisible();
      await snap(page, testInfo, '01-chat-screen');
    });

    await test.step('2. 작업할 레포를 지정하고 새 세션을 시작한다', async () => {
      await page.getByTestId('repo-input').fill(env.e2eRepo);
      await page.getByTestId('start-session-button').click();
    });

    await test.step('3. 샌드박스가 준비되었다는 메시지가 나타난다', async () => {
      await expect(page.getByTestId('session-status')).toContainText('준비 중');
      await expect(page.getByTestId('message').filter({ hasText: '샌드박스가 준비되었습니다' })).toBeVisible({
        timeout: 8 * 60 * 1000,
      });
      await snap(page, testInfo, '03-sandbox-ready');
    });

    await test.step('4. 코드 수정을 요청하는 메시지를 보낸다', async () => {
      await page
        .getByTestId('chat-input')
        .fill('README.md 맨 아래에 "Hello from devspace" 한 줄을 추가해줘.');
      await page.getByTestId('send-button').click();
    });

    await test.step('5. 에이전트 진행 상황이 채팅에 나타난다', async () => {
      await expect(page.getByTestId('agent-activity').first()).toBeVisible({
        timeout: 2 * 60 * 1000,
      });
      await snap(page, testInfo, '05-agent-activity');
    });

    await test.step('6. 작업이 끝나면 변경 요약과 "PR 만들기" 버튼이 나타난다', async () => {
      await expect(page.getByTestId('diff-summary')).toContainText('README.md', {
        timeout: 8 * 60 * 1000,
      });
      await expect(page.getByTestId('create-pr-button')).toBeVisible();
      await snap(page, testInfo, '06-diff-summary');
    });

    await test.step('7. "PR 만들기"를 누르면 PR 링크가 나타난다', async () => {
      await page.getByTestId('create-pr-button').click();
      await expect(page.getByTestId('pr-link')).toBeVisible({ timeout: 2 * 60 * 1000 });
      await snap(page, testInfo, '07-pr-link');
    });

    await test.step('8. 그 PR은 실제로 테스트 레포에 열려 있고 요청한 diff를 담고 있다', async () => {
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
