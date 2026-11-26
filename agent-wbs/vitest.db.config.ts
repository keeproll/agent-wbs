import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  ...base,
  test: {
    include: ['**/test/**/*.db.test.ts'],
    globalSetup: './scripts/test-db-setup.ts',
    // 한 테스트 DB를 공유한다.
    fileParallelism: false,
    // 실제 DB를 만들고 마이그레이션 21개를 적용하는 준비가 PC 부하에 따라 기본 한도(시험 5초·준비 10초)를 넘을 수 있다.
    // M2 통합 메모: schema 업그레이드 시험의 5초 간헐 실패. 결과 판정은 그대로 두고 대기 한도만 늘린다.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
