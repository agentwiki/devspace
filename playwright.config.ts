import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // 시나리오는 실제 샌드박스/GitHub 상태를 공유하므로 순차 실행한다.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.DEVSPACE_URL ?? 'http://localhost:3000',
    // 표준 설치 대신 시스템 Chromium을 써야 하는 환경용 (미설정이면 무시됨)
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
