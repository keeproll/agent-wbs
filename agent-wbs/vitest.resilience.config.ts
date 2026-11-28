import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  ...base,
  test: {
    include: ['e2e/resilience/**/*.resilience.test.ts'],
    globalSetup: './e2e/resilience/setup.ts',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
