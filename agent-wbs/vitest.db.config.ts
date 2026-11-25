import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  ...base,
  test: {
    include: ['**/test/**/*.db.test.ts'],
    globalSetup: './scripts/test-db-setup.ts',
    // 한 테스트 DB를 공유한다.
    fileParallelism: false,
  },
});
