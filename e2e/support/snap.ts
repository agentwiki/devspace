import type { Page, TestInfo } from '@playwright/test';

/**
 * 시나리오의 주요 장면을 스크린샷으로 남긴다.
 * CI는 test-results 아래의 scenes 디렉토리 PNG를 수집해 PR 댓글로 첨부한다
 * (.github/scripts/pr-screenshots.sh). `name`은 곧 댓글의 장면 제목이 되므로
 * "01-chat-screen"처럼 시나리오 단계 번호 + ASCII 슬러그로 짓는다.
 *
 * 파일명 앞엔 시나리오(스펙) 슬러그를 붙인다 — 여러 시나리오가 함께 도는 CI에서
 * 스크린샷이 번호순으로 뒤섞이지 않고 시나리오별로 묶이게 하려는 것. 슬러그는
 * scenarios/의 파일명과 맞춰, 댓글 섹션 제목이 곧 어떤 시나리오인지 드러낸다.
 */
export async function snap(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const specFile = testInfo.file.split(/[\\/]/).pop() ?? 'scenario';
  const scenario = specFile.replace(/\.spec\.ts$/, '');
  const path = testInfo.outputPath('scenes', `${scenario}__${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(`scene:${name}`, { path, contentType: 'image/png' });
}
