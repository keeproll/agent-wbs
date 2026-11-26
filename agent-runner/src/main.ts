import { createApiClient } from './api/client.ts';
import { Runner } from './api/runner.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { createRedactor } from './security/redact.ts';
import { State } from './state/state.ts';

try {
  const config = loadConfig(process.env);
  const log = createLogger(config.logLevel, createRedactor([config.token.reveal()]));

  const controller = new AbortController();
  let signal: string | undefined;
  const interrupt = () => { signal = 'SIGINT'; controller.abort(); };
  const terminate = () => { signal = 'SIGTERM'; controller.abort(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const state = await State.open(config.home);
    const runner = new Runner({ state, api: createApiClient({ baseUrl: config.wbsUrl, token: config.token }), version: '0.0.0', warn: (message) => log.warn(message) });
    log.info({ wbsUrl: config.wbsUrl, home: config.home }, 'Runner 시작');
    await runner.run(controller.signal);
    await runner.stop('manual');
    log.info({ signal }, '종료');
  } catch {
    log.error('Runner가 중지되었습니다. 인증과 로컬 상태 파일을 확인하세요.');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`설정 오류\n${error.message}`);
  process.exitCode = 2;
}
