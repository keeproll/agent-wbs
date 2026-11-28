import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// 실제 DB와 가짜 외부 서비스를 쓴다. 실제 GitHub에는 쓰지 않는다.
export default defineConfig({
  ...base,
  test: {
    include: [
      'apps/api/test/{secrets,log,security,validation,mail,pdf-html,pdf-render,reset}.test.ts',
      'apps/api/test/{secrets,security,security-review,validation,reset,github-credential}.db.test.ts',
      'e2e/fakes/test/{telegram,mail,pdf}.scenario.test.ts',
      'packages/db/test/snapshot.test.ts',
      'scripts/test/env-init.test.ts',
    ],
    globalSetup: './scripts/test-db-setup.ts',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
