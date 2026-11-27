import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRepository } from '../../git/repository.ts';
import type { HeavySemaphore } from '../../resources/heavy.ts';
import { createRedactor, type Redact } from '../../security/redact.ts';
import { atomicWrite } from '../../state/files.ts';
import { parsePipeline, type PipelineStep } from '../pipeline.ts';
import { flakyRate, parseHistory, recordHistory, type FlakyHistory } from './history.ts';
import { judgeTimings, type TimingJudgement } from './perf.ts';
import type { CiReport } from './report.ts';
import { pruneEvidence } from './retention.ts';
import { Evidence, excerpt, type CiExecute, type StepAttempt } from './steps.ts';
import { judgeTests, type TestOutcome } from './tests.ts';
import { compareImages, decodePng } from './visual.ts';

export interface NightOptions {
  repo: Pick<GitRepository, 'mainPipeline' | 'createTaskCheckWorktree' | 'taskCheckPath' | 'removeWorktree' | 'mainCommitsSince'>;
  heavy: HeavySemaphore;
  execute: CiExecute;
  report: CiReport;
  /** AWBS_HOME. 근거는 runs/<실행 ID>/, 야간 상태는 ci/night/state.json에 둔다. */
  home: string;
  /** 격리된 테스트 이름. 실패해도 통과를 막지 않는다. */
  quarantined: ReadonlySet<string>;
  /** 정책의 「실패 테스트 재시도」 횟수(ci.retry, 기본 1). */
  retry: number;
  now?: () => number;
  redact?: Redact;
  signal?: AbortSignal;
}
export interface ScreenResult { name: string; status: 'same' | 'diff' | 'missing'; ratio: number }
export interface NightStepResult { name: string; status: 'pass' | 'fail' | 'skip'; durationMs: number; attempts: number }
export interface NightResult {
  runId: string; status: 'pass' | 'fail'; baseSha: string; pipelineSha: string;
  steps: NightStepResult[]; failStep: string | null;
  e2e: { passed: number; total: number } | null;
  flaky: string[]; quarantinedFailures: string[]; screens: ScreenResult[]; timings: TimingJudgement[];
  /** 실패 때 마지막 통과 이후 main에 들어온 커밋(원인 후보, 오래된 것부터). */
  suspects: string[];
  note: string;
}
interface NightState { version: 1; lastDate: string | null; runId: string | null; lastPassSha: string | null; history: FlakyHistory }

const EMPTY: NightState = { version: 1, lastDate: null, runId: null, lastPassSha: null, history: {} };
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function readNightState(home: string): Promise<NightState> {
  const path = join(home, 'ci', 'night', 'state.json');
  let raw: string;
  try {
    if (!(await lstat(path)).isFile()) throw new Error('야간 상태는 일반 파일이어야 합니다.');
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
    throw error;
  }
  const value = JSON.parse(raw) as NightState;
  if (value.version !== 1 || ![value.lastDate, value.runId].every(v => v === null || typeof v === 'string') ||
    !(value.lastPassSha === null || SHA.test(value.lastPassSha))) throw new Error('야간 상태가 손상되었습니다. 원본을 보존하고 확인하세요.');
  return { ...value, history: parseHistory(value.history) };
}

async function saveNightState(home: string, state: NightState): Promise<void> {
  const directory = join(home, 'ci', 'night');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(directory, 'state.json', `${JSON.stringify(state)}\n`);
}

/**
 * ③ 야간 점검(G L476). main을 고정해 새 사본에서 정의의 night 단계를 실행한다.
 * job 없이 시작하는 유일한 실행이라 fence는 null, 중복은 멱등 키 `night:<date>`로 막는다(contracts §3.2-4·5).
 * 실패 알림·원인 Task 연결은 서버가 실행 결과로 한다(M7-04). Runner는 원인 후보 커밋을 note에 남긴다.
 */
export async function runNightCheck(options: NightOptions, date: string): Promise<NightResult> {
  const { repo, heavy, execute, report, home, quarantined, signal } = options;
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new TypeError('야간 점검 날짜가 올바르지 않습니다.');
  if (!Number.isSafeInteger(options.retry) || options.retry < 0) throw new RangeError('재시도 횟수가 올바르지 않습니다.');
  const now = options.now ?? Date.now;
  const redact = options.redact ?? createRedactor();
  const state = await readNightState(home);
  const basis = await repo.mainPipeline();
  const pipeline = parsePipeline(basis.source);
  const install = pipeline.stages.task[0];
  if (!install) throw new Error('설치 단계가 없습니다.');
  const commands: PipelineStep[] = [install, ...pipeline.stages.night];
  const started = await report.start({ stage: 'night', ref: 'main', trigger: '야간 일정', baseSha: basis.baseSha, headSha: basis.baseSha, pipelineSha: basis.pipelineSha }, `night:${date}`);
  // 시작을 서버가 받은 뒤 날짜를 남긴다. 그 사이에 죽으면 같은 키로 다시 시작해 서버가 같은 실행을 돌려준다.
  await saveNightState(home, { ...state, lastDate: date, runId: started.id });
  await report.update(started.id, { fence: null, status: 'run' });
  const evidence = await Evidence.open(home, started.id, redact);

  const result: NightResult = {
    runId: started.id, status: 'fail', baseSha: basis.baseSha, pipelineSha: basis.pipelineSha,
    steps: commands.map(c => ({ name: c.name, status: 'skip', durationMs: 0, attempts: 0 })), failStep: null,
    e2e: null, flaky: [], quarantinedFailures: [], screens: [], timings: [], suspects: [], note: '',
  };
  const tests = { passed: 0, total: 0 };
  const failedOnce: Record<string, boolean> = {};
  let logExcerpt: string | null = null;
  const release = await heavy.acquire(`ci-night:${date}`, signal);
  const id = `night-${randomUUID()}`;
  let created = false;
  try {
    const path = await repo.createTaskCheckWorktree(id, basis.baseSha); created = true;
    for (const [index, command] of commands.entries()) {
      const step = result.steps[index];
      if (!step) throw new Error('검사 단계가 없습니다.');
      const begin = performance.now();
      const attempts: StepAttempt[] = [];
      const testRuns: TestOutcome[][] = [];
      let passed = false; let reason: string | null = null;
      // 설치는 재시도하지 않는다. 재시도는 실패 테스트를 위한 것이다(G L482).
      const limit = index === 0 ? 1 : 1 + options.retry;
      while (attempts.length < limit) {
        signal?.throwIfAborted();
        await repo.taskCheckPath(id, basis.baseSha);
        const attempt = await evidence.run(execute, command.argv, path, `${command.name}-${String(attempts.length + 1)}`, {}, signal);
        attempts.push(attempt);
        await repo.taskCheckPath(id, basis.baseSha);
        if (attempt.reportError) { reason = attempt.reportError; break; }
        if (attempt.report?.tests) testRuns.push(attempt.report.tests);
        const judged = testRuns.length ? judgeTests(testRuns, quarantined) : null;
        const code = attempt.result.code;
        // 종료 코드가 실패여도 실패 테스트가 모두 격리된 것이면 통과다. 다른 이유의 실패는 격리로 덮지 않는다.
        passed = code === 0 ? !judged?.blocking : Boolean(judged && !judged.blocking && attempt.report?.tests?.some(t => t.status === 'fail'));
        if (passed || code === null) break;
      }
      const last = attempts.at(-1);
      if (testRuns.length) {
        const judged = judgeTests(testRuns, quarantined);
        tests.passed += judged.passed; tests.total += judged.total;
        result.flaky.push(...judged.flaky); result.quarantinedFailures.push(...judged.quarantinedFailures);
        for (const run of testRuns) for (const t of run) failedOnce[t.key] = (failedOnce[t.key] ?? false) || t.status === 'fail';
      }
      if (passed && last?.report?.screens) {
        for (const screen of last.report.screens) {
          try {
            const diff = compareImages(decodePng(await evidence.file(screen.actual)), decodePng(await evidence.file(screen.expected)));
            result.screens.push({ name: screen.name, status: diff.sizeMatch && diff.diffPixels === 0 ? 'same' : 'diff', ratio: diff.ratio });
          } catch {
            // 비교할 화면이 없거나 읽을 수 없으면 비교하지 못한 것이다. 「차이 없음」으로 보지 않는다.
            result.screens.push({ name: screen.name, status: 'missing', ratio: 1 });
          }
        }
        if (result.screens.some(s => s.status === 'missing')) { passed = false; reason = '비교할 화면 스크린샷이 없습니다.'; }
      }
      if (passed && last?.report?.timings) {
        try {
          const judged = judgeTimings(last.report.timings);
          result.timings.push(...judged);
          if (judged.some(t => t.over)) { passed = false; reason = `응답 시간 기준 초과: ${judged.filter(t => t.over).map(t => `${t.name} p95 ${String(t.p95Ms)}ms > ${String(t.budgetMs)}ms`).join(', ')}`; }
        } catch (error) { passed = false; reason = error instanceof Error ? error.message : '응답 시간 기준이 올바르지 않습니다.'; }
      }
      step.attempts = attempts.length;
      step.durationMs = Math.max(0, Math.round(performance.now() - begin));
      step.status = passed ? 'pass' : 'fail';
      if (!passed) {
        result.failStep = command.name;
        logExcerpt = last ? excerpt(last.result, reason) : reason;
        break;
      }
    }
    if (!result.failStep) result.status = 'pass';
  } catch (error) {
    const current = result.steps.find(s => s.status === 'skip') ?? result.steps[0];
    if (current) { current.status = 'fail'; result.failStep = current.name; }
    logExcerpt = redact(error instanceof Error ? error.message : '야간 점검을 실행하지 못했습니다.');
  } finally {
    try { if (created) await repo.removeWorktree(id); }
    finally { release(); }
  }

  const finishedAt = new Date(now()).toISOString();
  const history = recordHistory(state.history, failedOnce);
  const flakyKeys = [...new Set([...result.flaky, ...result.quarantinedFailures])].sort();
  if (result.status === 'fail' && state.lastPassSha) result.suspects = await repo.mainCommitsSince(state.lastPassSha, basis.baseSha).catch(() => []);
  result.e2e = tests.total ? tests : null;
  const diffs = result.screens.filter(s => s.status !== 'same').length;
  result.note = [
    result.e2e && `E2E ${String(tests.passed)}/${String(tests.total)}`,
    result.screens.length && `화면 비교 ${String(result.screens.length)}개 중 ${String(diffs)}개 차이`,
    result.timings.length && `응답 시간 초과 ${String(result.timings.filter(t => t.over).length)}`,
    result.flaky.length && `불안정 후보 ${String(result.flaky.length)}`,
    result.quarantinedFailures.length && `격리 실패 ${String(result.quarantinedFailures.length)}`,
    result.failStep && `실패 단계: ${result.failStep}`,
    result.suspects.length && `원인 후보 커밋 ${result.suspects.map(s => s.slice(0, 7)).join(', ')}`,
  ].filter(Boolean).join(' · ');
  await evidence.finish({ stage: 'night', date, status: result.status, baseSha: basis.baseSha, finishedAt });
  await saveNightState(home, { version: 1, lastDate: date, runId: started.id, history,
    lastPassSha: result.status === 'pass' ? basis.baseSha : state.lastPassSha });
  await report.update(started.id, {
    fence: null, status: result.status, finishedAt,
    steps: result.steps.map(s => ({ name: s.name, status: s.status, durationMs: s.durationMs })),
    ...(result.e2e && { e2e: result.e2e }),
    ...(flakyKeys.length && { flakyTests: flakyKeys.map(testKey => ({ testKey, rate: flakyRate(history, testKey), lastFailedAt: finishedAt })) }),
    ...(result.note && { note: result.note }),
    ...(logExcerpt && { logExcerpt }),
    artifacts: evidence.artifacts,
  });
  await pruneEvidence(join(home, 'runs'), now(), { keep: new Set([started.id]) }).catch(() => undefined);
  return result;
}
