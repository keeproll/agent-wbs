import { once } from 'node:events';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { createRedactor } from './security/redact.ts';

try {
  const config = loadConfig(process.env);
  const log = createLogger(config.logLevel, createRedactor([config.token.reveal()]));

  // 작업 획득·보고는 M4부터 구현한다. 지금은 설정만 확인하고 종료 신호를 기다린다.
  log.warn({ wbsUrl: config.wbsUrl, home: config.home }, '골격만 구현되어 WBS에 접속하지 않습니다.');

  const alive = setInterval(() => undefined, 60_000);
  const signal = await Promise.race(
    ['SIGINT', 'SIGTERM'].map(async (name) => {
      await once(process, name);
      return name;
    }),
  );
  clearInterval(alive);
  log.info({ signal }, '종료');
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`설정 오류\n${error.message}`);
  process.exitCode = 2;
}
