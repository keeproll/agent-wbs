import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  ...base,
  test: {
    include: ['e2e/fakes/test/**/*.scenario.test.ts'],
    globalSetup: './scripts/test-db-setup.ts',
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
