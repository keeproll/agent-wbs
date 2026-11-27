import { ApiError, createApiClient } from './api/client.ts';
import { RunnerApp } from './app.ts';
import { cliEnvironment, createCliRegistry } from './cli-update/registry.ts';
import { AGENT_EXEC, AGENT_USER, agentLoginRun } from './cli/dedicated-user.ts';
import { createRunCommand } from './readiness/command.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { nodeHostSources } from './resources/host.ts';
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
    // 모든 모듈을 RunnerApp 하나에서 조립한다. 공유 인스턴스(HeavySemaphore·ResourceReporter·세션 목록)는 여기서 하나뿐이다.
    const app = new RunnerApp({
      state,
      api: createApiClient({ baseUrl: config.wbsUrl, token: config.token }),
      home: config.home,
      version: '0.0.0',
      env: process.env,
      warn: (message) => log.warn(message),
      hostSources: nodeHostSources(),
      // 전용 계정 격리면 CLI를 Agent 작업 영역(/srv/agentwbs/cli)에 설치하고, 설치 점검의 로그인 확인은 Agent 계정으로 한다.
      cliRegistry: createCliRegistry({
        home: config.agentRoot ?? config.home,
        env: process.env,
        ...(config.agentRoot && {
          run: agentLoginRun({ user: AGENT_USER, root: config.agentRoot, exec: AGENT_EXEC }, createRunCommand({ env: cliEnvironment(process.env), timeoutMs: 120_000 })),
        }),
      }),
      agentRoot: config.agentRoot,
      cliUpdates: config.cliUpdates,
      ...(config.github && { github: config.github }),
    });
    log.info({ wbsUrl: config.wbsUrl, home: config.home }, 'Runner 시작');
    await app.run(controller.signal);
    await app.runner.stop('manual');
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
