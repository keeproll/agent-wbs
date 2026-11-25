import { createPool, waitForDatabase } from '@awbs/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl, {
  max: config.poolMax,
  onError: (error) => {
    // pg가 붙이는 client 객체(세션 키 포함)를 로그에 남기지 않는다.
    app.log.error({ code: (error as { code?: string }).code, reason: error.message }, 'DB 유휴 연결 오류');
  },
});
const app = buildApp(pool, {
  level: config.logLevel,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.botToken'],
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
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
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, '기동 실패');
  process.exitCode = 1;
  await shutdown();
}
