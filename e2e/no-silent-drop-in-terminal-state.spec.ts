/**
 * scenarios/regressions/no-silent-drop-in-terminal-state.md 의 1:1 실행 버전.
 * 각 test.step 제목은 시나리오 "흐름"의 번호와 문장을 그대로 따른다.
 *
 * 종료 상태(pr-opened)에서 입력이 조용히 사라지던 이슈 C 회귀를 고정한다.
 */
import { test, expect } from '@playwright/test';
import { env } from './support/env';
import { snap } from './support/snap';
import { getPullRequestByUrl, cleanupPullRequest, type PullRequest } from './support/github';

// 샌드박스 준비 + 에이전트 작업 + PR 생성까지 포함되므로 넉넉하게 잡는다.
test.setTimeout(20 * 60 * 1000);

test('회귀: 종료 상태에서 입력이 조용히 사라지지 않는다', async ({ page }, testInfo) => {
  let pr: PullRequest | undefined;

  try {
    await test.step('전제: 골든패스를 끝까지 진행해 PR이 열린 상태에 도달한다', async () => {
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
      await expect(page.getByTestId('diff-summary')).toContainText('README.md', {
        timeout: 8 * 60 * 1000,
      });
      await page.getByTestId('create-pr-button').click();
      await expect(page.getByTestId('pr-link')).toBeVisible({ timeout: 2 * 60 * 1000 });
      const prUrl = await page.getByTestId('pr-link').getAttribute('href');
      expect(prUrl).toBeTruthy();
      pr = await getPullRequestByUrl(prUrl!);
      expect(pr.state).toBe('open');
      await snap(page, testInfo, '01-pr-opened');
    });

    await test.step('1. PR이 열린 뒤, 입력창은 비활성이다 (조용히 사라질 메시지를 못 보낸다)', async () => {
      await expect(page.getByTestId('chat-input')).toBeDisabled();
      await expect(page.getByTestId('send-button')).toBeDisabled();
    });

    await test.step('2. PR 만들기 버튼도 클릭 이후 비활성이라 중복 PR 시도가 조용히 실패하지 않는다', async () => {
      await expect(page.getByTestId('create-pr-button')).toBeDisabled();
      await snap(page, testInfo, '02-terminal-controls-locked');
    });
  } finally {
    await test.step('정리: 테스트 PR을 닫고 브랜치를 지운다', async () => {
      if (pr) await cleanupPullRequest(pr);
    });
  }
});
