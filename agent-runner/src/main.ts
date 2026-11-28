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
    const api = createApiClient({ baseUrl: config.wbsUrl, token: config.token });
    // 모든 모듈을 RunnerApp 하나에서 조립한다. 공유 인스턴스(HeavySemaphore·ResourceReporter·세션 목록)는 여기서 하나뿐이다.
    const app = new RunnerApp({
      state,
      api,
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
      // 전용 계정(agentRoot)이면 앱이 준비 점검 뒤·실행 직전마다 래퍼 check와 사용자 scope를 확인해 격리를 고른다. 없으면 실행 거부.
      agentRoot: config.agentRoot,
      cliUpdates: config.cliUpdates,
      planningAuto: config.planningAuto,
      agentCallLimit: config.agentCallLimit,
      agentMaxEffort: config.agentMaxEffort,
      // CI 실행기(integrate·ci_retry, 조정자 결정 1·2·7): GitHub 설정이 있고 AWBS_CI_AUTO=1이면 켠다.
      // 명령·시험 목록은 Execution.command → 격리 계층 command(전용 계정이면 래퍼 ci-run, 사용자 scope)로만 돈다.
      // 격리 계층이 없으면(AWBS_AGENT_USER 미설정·점검 실패) 앱이 CI job을 받지 않는다. 로컬 clone이 생기기 전에도 받지 않는다.
      // 기본 꺼짐(조정자 결정 7): .env에 AWBS_CI_AUTO=1을 적어야 켠다.
      ...(config.github && config.ciAuto && { ciAuto: true }),
      // 시도 흐름(jobs, AttemptFlow): 기본 꺼짐. .env에 AWBS_ATTEMPT_AUTO=1을 적어야 켠다(CI 자동과 같은 방식, M8 실호출 전까지).
      // 켜면 execution.prepare(시도별 작업 폴더)와 jobs(결과 수집·① 공급원·보고 뒤 정리)를 넘긴다(src/jobs/README.md 「연결 지점」).
      // jobs.taskCheck·collect에는 공급원만 넘긴다. 앱이 자기 GitHub 클라이언트·Execution·Runner·API로 묶는다(여기서 따로 만들지 않는다).
      // 격리 계층이 없으면(AWBS_AGENT_USER 미설정·점검 실패) 켜져 있어도 claim하지 않는다(Execution.claim).
      attemptAuto: config.attemptAuto,
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
