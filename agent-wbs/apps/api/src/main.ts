import { createPool, waitForDatabase } from '@awbs/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { loggerOptions } from './log.ts';
import { assertLanPassword } from './platform/security.ts';
import { installProjectRunner } from './project/runner-routes.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl, {
  max: config.poolMax,
  onError: (error) => {
    app.log.error({ err: error }, 'DB 유휴 연결 오류');
  },
});
const app = buildApp(pool, loggerOptions(config.logLevel), config);
installProjectRunner(app, pool);

// 신호와 기동 실패가 겹쳐도 한 번만 종료한다(pool.end는 두 번 부를 수 없다).
let stopping: Promise<void> | undefined;
const shutdown = (): Promise<void> =>
  (stopping ??= (async () => {
    await app.close();
    await pool.end();
  })());
// 신호 처리기가 바꾸므로 await 뒤에 다시 읽는다.
const isStopping = (): boolean => stopping !== undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}

try {
  await waitForDatabase(pool, {
    onRetry: (attempt, error) => {
      app.log.warn({ attempt, err: error }, 'DB 연결 재시도');
    },
  });
  if (!isStopping() && config.lan) await assertLanPassword(pool);
  if (!isStopping() && config.lan && config.origin.startsWith('http:')) {
    app.log.warn('LAN 평문 HTTP에서는 같은 네트워크의 사용자가 비밀번호와 세션을 볼 수 있습니다. HTTPS를 사용하세요.');
  }
  // 연결을 기다리는 동안 종료 신호를 받았으면 열지 않는다.
  if (!isStopping()) await app.listen({ host: config.host, port: config.port });
} catch (error) {
  // 종료 신호 때문에 중단된 것은 실패가 아니다.
  if (!isStopping()) {
    app.log.fatal({ err: error }, '기동 실패');
    process.exitCode = 1;
  }
  await shutdown();
}
