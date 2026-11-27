import { defineConfig } from 'vitest/config';

// 양쪽 계약의 사례·hash 벡터 검사는 별도 명령으로도 확인한다.
export default defineConfig({ test: { include: ['test/contracts/**/*.contract.ts'] } });
