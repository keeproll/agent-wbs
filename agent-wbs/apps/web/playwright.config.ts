import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// 시각 비교·측정 결과의 기본 폴더: 저장소 밖, 실행마다 새 임시 폴더(e2e/support/visual.ts visualOut).
// worker는 이 환경 변수를 물려받아 같은 실행 폴더를 쓴다. 봇 보관 폴더는 시험별 환경 변수로 명시할 때만 쓴다.
process.env.AWBS_VISUAL_RUN_DIR ??= mkdtempSync(join(tmpdir(), 'awbs-visual-'));

const port = Number(process.env.AWBS_E2E_PORT ?? 5183);
const baseURL = `http://127.0.0.1:${String(port)}`;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: true,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL, locale: 'ko-KR', timezoneId: 'Asia/Seoul' },
  webServer: {
    // e2e 모드 빌드에는 공통 컴포넌트 견본(/_states)이 들어간다(src/app/router.tsx).
    command: `pnpm run build --mode e2e && pnpm run preview --port ${String(port)}`,
    url: baseURL,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
