/**
 * scenarios/iterate-then-pr.md 의 1:1 실행 버전.
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

// 샌드박스 준비 + 에이전트 작업이 두 라운드이므로 넉넉하게 잡는다.
test.setTimeout(25 * 60 * 1000);

test('반복 지시 후 PR: 변경을 다듬은 뒤 PR을 연다', async ({ page }, testInfo) => {
  let pr: PullRequest | undefined;

  try {
    await test.step('전제: 세션을 시작하고 샌드박스가 준비된다', async () => {
      await page.goto(env.devspaceUrl);
      await page.getByTestId('repo-input').fill(env.e2eRepo);
      await page.getByTestId('start-session-button').click();
      await expect(page.getByTestId('message').filter({ hasText: '샌드박스가 준비되었습니다' })).toBeVisible({
        timeout: 8 * 60 * 1000,
      });
    });

    await test.step('1. 첫 지시를 보내면 그 한 줄이 담긴 변경 요약이 나타난다', async () => {
      await page
        .getByTestId('chat-input')
        .fill('README.md 맨 아래에 "First from devspace" 한 줄을 추가해줘.');
      await page.getByTestId('send-button').click();
      await expect(page.getByTestId('diff-summary')).toContainText('First from devspace', {
        timeout: 8 * 60 * 1000,
      });
      await expect(page.getByTestId('create-pr-button')).toBeVisible();
      await snap(page, testInfo, '01-first-diff');
    });

    await test.step('2. PR을 열지 않고 추가 지시를 보낸다', async () => {
      await page
        .getByTestId('chat-input')
        .fill('방금 추가한 줄 바로 아래에 "Second from devspace" 한 줄을 더 추가해줘.');
      await page.getByTestId('send-button').click();
      // 새 라운드 작업 중엔 이전 라운드의 PR 버튼이 잠긴다(옛 요약으로 PR을 못 열게).
      await expect(page.getByTestId('create-pr-button')).toBeDisabled({ timeout: 2 * 60 * 1000 });
    });

    await test.step('3. 갱신된 변경 요약에 첫 줄과 둘째 줄이 모두 담긴다', async () => {
      const diff = page.getByTestId('diff-summary');
      await expect(diff).toContainText('Second from devspace', { timeout: 8 * 60 * 1000 });
      await expect(diff).toContainText('First from devspace');
      // 작업이 끝나 다시 검토 대기가 되면 PR 버튼이 다시 열린다.
      await expect(page.getByTestId('create-pr-button')).toBeEnabled();
      await snap(page, testInfo, '03-accumulated-diff');
    });

    await test.step('4. PR 만들기를 누르면 PR diff에 두 줄이 모두 담겨 열린다', async () => {
      await page.getByTestId('create-pr-button').click();
      await expect(page.getByTestId('pr-link')).toBeVisible({ timeout: 2 * 60 * 1000 });
      await snap(page, testInfo, '04-pr-link');
      const prUrl = await page.getByTestId('pr-link').getAttribute('href');
      expect(prUrl).toBeTruthy();
      pr = await getPullRequestByUrl(prUrl!);
      expect(pr.state).toBe('open');
      const diff = await getPullRequestDiff(pr);
      expect(diff).toContain('README.md');
      expect(diff).toContain('+First from devspace');
      expect(diff).toContain('+Second from devspace');
    });
  } finally {
    await test.step('정리: 테스트 PR을 닫고 브랜치를 지운다', async () => {
      if (pr) await cleanupPullRequest(pr);
    });
  }
});
