import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.AWBS_E2E_PORT ?? 5183);
const baseURL = `http://127.0.0.1:${String(port)}`;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: true,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL },
  webServer: {
    command: `pnpm run build && pnpm run preview --port ${String(port)}`,
    url: baseURL,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
