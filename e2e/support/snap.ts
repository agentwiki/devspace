import type { Page, TestInfo } from '@playwright/test';

/**
 * 시나리오의 주요 장면을 스크린샷으로 남긴다.
 * CI는 test-results 아래의 scenes 디렉토리 PNG를 수집해 PR 댓글로 첨부한다
 * (.github/scripts/pr-screenshots.sh). 파일명이 곧 댓글의 제목이 되므로
 * "01-chat-screen"처럼 시나리오 단계 번호 + ASCII 슬러그로 짓는다.
 */
export async function snap(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath('scenes', `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(`scene:${name}`, { path, contentType: 'image/png' });
}
