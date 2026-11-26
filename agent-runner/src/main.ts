import { ApiError, createApiClient } from './api/client.ts';
import { Runner } from './api/runner.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { createRedactor } from './security/redact.ts';
import { State, StateLockError, StateStorageError } from './state/state.ts';

try {
  const config = loadConfig(process.env);
  const log = createLogger(config.logLevel, createRedactor([config.token.reveal()]));

  const controller = new AbortController();
  let signal: string | undefined;
  const interrupt = () => { signal = 'SIGINT'; controller.abort(); };
  const terminate = () => { signal = 'SIGTERM'; controller.abort(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  let state: State | undefined;
  try {
    state = await State.open(config.home);
    const runner = new Runner({ state, api: createApiClient({ baseUrl: config.wbsUrl, token: config.token }), version: '0.0.0', warn: (message) => log.warn(message) });
    log.info({ wbsUrl: config.wbsUrl, home: config.home }, 'Runner 시작');
    await runner.run(controller.signal);
    await runner.stop('manual');
    log.info({ signal }, '종료');
  } catch (error) {
    const kind = error instanceof ApiError ? 'API_ERROR' : error instanceof StateLockError ? 'STATE_LOCKED'
      : error instanceof SyntaxError ? 'STATE_CORRUPT' : error instanceof StateStorageError ? 'STATE_STORAGE' : 'RUNNER_ERROR';
    log.error({ kind, ...(error instanceof ApiError && { status: error.status, code: error.error?.code }) }, 'Runner가 중지되었습니다. 오류 종류를 확인하세요.');
    process.exitCode = 1;
  } finally {
    await state?.close();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`설정 오류\n${error.message}`);
  process.exitCode = 2;
}
