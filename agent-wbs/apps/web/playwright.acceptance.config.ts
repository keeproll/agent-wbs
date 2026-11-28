import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

export default defineConfig({
  ...base,
  testDir: 'e2e',
  testIgnore: ['**/api-*.spec.ts'],
  workers: 2,
  retries: 0,
  timeout: 60_000,
  use: { ...base.use, trace: 'retain-on-failure' },
  reporter: [['list'], ['json', { outputFile: process.env.AWBS_ACCEPTANCE_JSON }]],
});
