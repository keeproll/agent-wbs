import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.AWBS_E2E_PORT ?? 5183);
const baseURL = `http://127.0.0.1:${String(port)}`;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: true,
  reporter: 'list',
  outputDir: process.env.AWBS_E2E_OUTPUT_DIR ?? 'test-results',
  use: { ...devices['Desktop Chrome'], baseURL, locale: 'ko-KR', timezoneId: 'Asia/Seoul' },
  webServer: {
    // e2e 모드 빌드에는 공통 컴포넌트 견본(/_states)이 들어간다(src/app/router.tsx).
    command: `pnpm run build --mode e2e && pnpm run preview --port ${String(port)}`,
    url: baseURL,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
