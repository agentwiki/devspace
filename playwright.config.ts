import { defineConfig } from '@playwright/test';

const devspaceUrl = process.env.DEVSPACE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: 'e2e',
  // 시나리오는 실제 샌드박스/GitHub 상태를 공유하므로 순차 실행한다.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // devspace 서버를 띄우고 준비될 때까지 기다린다. 이미 그 주소에 서버가
  // 떠 있으면(로컬 개발) 재사용한다. CI에서는 항상 새로 띄운다.
  webServer: {
    command: 'pnpm dev',
    url: `${devspaceUrl}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60 * 1000,
  },
  use: {
    baseURL: process.env.DEVSPACE_URL ?? 'http://localhost:3000',
    // 표준 설치 대신 시스템 Chromium을 써야 하는 환경용 (미설정이면 무시됨)
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // 실패한 순간도 하나의 "장면"이다 — PR 댓글 첨부에 함께 수집된다.
    screenshot: 'only-on-failure',
  },
});
