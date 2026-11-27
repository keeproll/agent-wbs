import { defineConfig } from 'vitest/config';

// 실제 커널 시험은 일반 단위 테스트와 분리하고, 서로 다른 scope를 순서대로 검사한다.
export default defineConfig({ test: { include: ['test/exec/**/*.host.ts'], fileParallelism: false, testTimeout: 20000 } });
