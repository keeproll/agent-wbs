import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// 워크스페이스 패키지를 dist가 아닌 소스로 읽는다.
const conditions = ['awbs-source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.test.ts', '**/*.scenario.test.ts'],
  },
});
