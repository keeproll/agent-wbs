import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRepository } from '../../git/repository.ts';
import type { HeavySemaphore } from '../../resources/heavy.ts';
import { createRedactor, type Redact } from '../../security/redact.ts';
import { atomicWrite } from '../../state/files.ts';
import { parsePipeline, type PipelineStep } from '../pipeline.ts';
import { flakyRate, parseHistory, recordHistory, type FlakyHistory } from './history.ts';
import { judgeTimingAttempts, type Timing, type TimingJudgement } from './perf.ts';
import type { CiReport, CiStartBody } from './report.ts';
import { pruneEvidence } from './retention.ts';
import { nightDue } from './schedule.ts';
import { Evidence, excerpt, type CiExecute, type StepAttempt } from './steps.ts';
import { judgeTests, type TestOutcome } from './tests.ts';
import { BASELINE_RENDER, baselineImage, prototypePath, type BaselineRenderer } from './baseline.ts';
import { compareImages, decodePng } from './visual.ts';

export interface NightOptions {
  repo: Pick<GitRepository, 'mainPipeline' | 'pipelineAt' | 'fileAt' | 'listFiles' | 'createTaskCheckWorktree' | 'taskCheckPath' | 'removeWorktree' | 'mainCommitsSince'>;
  heavy: HeavySemaphore;
  execute: CiExecute;
  report: CiReport;
  /** AWBS_HOME. 근거는 runs/<실행 ID>/, 야간 상태는 ci/night/state.json에 둔다. */
  home: string;
  /** 격리된 테스트 이름. 실패해도 통과를 막지 않는다. */
  quarantined: ReadonlySet<string>;
  /** 정책의 「실패 테스트 재시도」 횟수(ci.retry, 기본 1). */
  retry: number;
  /** Runner 소유 기준 화면 렌더러(조정자 결정 8). M7-06이 Playwright 렌더러를 연결한다. 없으면 화면 비교는 「비교 불가」다. */
  renderBaseline?: BaselineRenderer;
  now?: () => number;
  redact?: Redact;
  signal?: AbortSignal;
}
/** same=같음, diff=차이(기록만), missing=기준이 있는데 비교 못 함(실패), unchecked=정의에 기준이 없는 화면(기록만). */
export interface ScreenResult { name: string; status: 'same' | 'diff' | 'missing' | 'unchecked'; ratio: number | null }
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
interface NightState {
  version: 1; lastDate: string | null; runId: string | null; lastPassSha: string | null; history: FlakyHistory;
  /** 시작을 보내기 전에 저장한 본문. 응답을 잃어도 같은 날짜 키로 같은 본문을 다시 보낸다(원칙 D). */
  pending: { date: string; body: CiStartBody } | null;
  /** 서버에 불안정 테스트로 알린 테스트와 실제 마지막 실패 시각. 회복한 뒤에도 낮아진 비율을 보낸다. */
  tracked: Record<string, string>;
}

const EMPTY: NightState = { version: 1, lastDate: null, runId: null, lastPassSha: null, history: {}, pending: null, tracked: {} };
/** Runner가 붙이는 단계 이름 접두어. 정의의 단계 이름(영소문자·숫자·-)에는 `:`이 없어 겹치지 않는다. */
export const RUNNER_STEP = 'runner:';
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
  const value = { ...EMPTY, ...JSON.parse(raw) as Partial<NightState> };
  const pending = value.pending;
  if (value.version !== 1 || ![value.lastDate, value.runId].every(v => v === null || typeof v === 'string') ||
    !(value.lastPassSha === null || SHA.test(value.lastPassSha)) ||
    !(pending === null || pending && typeof pending.date === 'string' && pending.body && typeof pending.body.baseSha === 'string' && SHA.test(pending.body.baseSha)) ||
    !value.tracked || typeof value.tracked !== 'object' || Object.values(value.tracked).some(v => typeof v !== 'string')) {
    throw new Error('야간 상태가 손상되었습니다. 원본을 보존하고 확인하세요.');
  }
  return { ...value, history: parseHistory(value.history) };
}

/**
 * 정책의 격리 목록(`GET /runner/policy`의 `ci.quarantined[]`, 조정자 결정 1)을 판정용 집합으로 바꾼다.
 * 값은 `flaky_tests.test_key`로, 단계 보고서의 `tests[].key`와 같은 이름이다. 필수 필드라 없거나 형식이 틀리면 추정하지 않고 거부한다.
 */
export function policyQuarantine(ci: { quarantined?: unknown }): Set<string> {
  if (!Array.isArray(ci.quarantined) || !ci.quarantined.every(k => typeof k === 'string' && k !== '')) throw new TypeError('격리 목록 형식이 올바르지 않습니다.');
  return new Set(ci.quarantined as string[]);
}

/**
 * 원인 후보를 CI 보고 계약 형식(`causeCandidates[{commit}]`, 조정자 결정 5)으로 바꾼다.
 * Runner는 커밋만 보낸다. commit→Task 연결은 서버가 병합 기록으로 한다(M7-04 14b60db).
 */
export function causeCandidates(result: Pick<NightResult, 'suspects'>): { commit: string }[] {
  return result.suspects.map(commit => ({ commit }));
}

/** 지금 야간 점검을 시작해야 하면 그 날짜를 준다. 마지막으로 시작한 날짜는 Runner를 다시 켜도 남아 있다. */
export async function dueNight(home: string, now: number, nightAt: string): Promise<string | null> {
  return nightDue(now, nightAt, (await readNightState(home)).lastDate);
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
  let state = await readNightState(home);
  // 같은 날짜의 시작 본문이 남아 있으면(응답 유실·중단) main이 움직였어도 그 기준과 본문을 그대로 쓴다.
  let body: CiStartBody;
  let basis: { baseSha: string; pipelineSha: string; source: string };
  if (state.pending?.date === date) {
    body = state.pending.body;
    const baseSha = body.baseSha ?? '';
    basis = { baseSha, ...await repo.pipelineAt(baseSha) };
    if (basis.pipelineSha !== body.pipelineSha) throw new Error('저장한 야간 점검 기준과 정의가 다릅니다. 원본을 보존하고 확인하세요.');
  } else {
    basis = await repo.mainPipeline();
    body = { stage: 'night', ref: 'main', trigger: '야간 일정', baseSha: basis.baseSha, headSha: basis.baseSha, pipelineSha: basis.pipelineSha };
    state = { ...state, pending: { date, body } };
    await saveNightState(home, state);
  }
  const pipeline = parsePipeline(basis.source);
  const install = pipeline.stages.task[0];
  if (!install) throw new Error('설치 단계가 없습니다.');
  const commands: { name: string; step: PipelineStep }[] = [
    { name: `${RUNNER_STEP}${install.name}`, step: install }, ...pipeline.stages.night.map(step => ({ name: step.name, step }))];
  const started = await report.start(body, `night:${date}`);
  state = { ...state, lastDate: date, runId: started.id };
  await saveNightState(home, state);
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
  // 앱 화면도 기준 이미지와 같은 크기로 찍도록 알려 준다.
  const screenEnv = { AWBS_SCREEN_WIDTH: String(BASELINE_RENDER.viewport.width), AWBS_SCREEN_HEIGHT: String(BASELINE_RENDER.viewport.height) };
  const prototypeSource = {
    read: async (file: string) => repo.fileAt(basis.baseSha, prototypePath(file)),
    files: async () => repo.listFiles(basis.baseSha, 'prototype/uiux/'),
  };
  const release = await heavy.acquire(`ci-night:${date}`, signal);
  const id = `night-${randomUUID()}`;
  let created = false;
  try {
    const path = await repo.createTaskCheckWorktree(id, basis.baseSha); created = true;
    for (const [index, { name, step: command }] of commands.entries()) {
      const step = result.steps[index];
      if (!step) throw new Error('검사 단계가 없습니다.');
      const begin = performance.now();
      const attempts: StepAttempt[] = [];
      const testRuns: TestOutcome[][] = [];
      const timingRuns: (Timing[] | undefined)[] = [];
      let passed = false; let reason: string | null = null;
      // 설치는 재시도하지 않는다. 재시도는 실패 테스트를 위한 것이다(G L482).
      const limit = index === 0 ? 1 : 1 + options.retry;
      while (attempts.length < limit) {
        signal?.throwIfAborted();
        await repo.taskCheckPath(id, basis.baseSha);
        const attempt = await evidence.run(execute, command.argv, path, `${name.replace(':', '.')}-${String(attempts.length + 1)}`, screenEnv, signal);
        attempts.push(attempt);
        // 각 단계 뒤에도 사본이 커밋과 같아야 한다. 다른 파일로 한 검사를 그 커밋의 근거로 남기지 않는다(원칙 C).
        try { await repo.taskCheckPath(id, basis.baseSha); } catch (error) {
          passed = false; reason = `단계가 검사 사본의 커밋 파일을 바꿨습니다: ${error instanceof Error ? error.message : ''}`; break;
        }
        if (attempt.reportError) { reason = attempt.reportError; break; }
        if (attempt.report?.tests) testRuns.push(attempt.report.tests);
        timingRuns.push(attempt.report?.timings);
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
      if (passed && (command.screens || last?.report?.screens)) {
        const reported = new Map((last?.report?.screens ?? []).map(s => [s.name, s.actual]));
        const problems: string[] = [];
        for (const [screen, target] of Object.entries(command.screens ?? {})) {
          try {
            const actual = reported.get(screen);
            if (actual === undefined) throw new Error(`${screen}: 화면 스크린샷이 없습니다.`);
            const app = decodePng(await evidence.file(actual));
            // 기준 이미지는 고정한 main의 HTML을 Runner가 렌더해 만든다. 단계 출력이 기준을 바꿀 수 없다(원칙 A, 결정 8).
            const expected = decodePng(await baselineImage(home, basis.baseSha, screen, target, prototypeSource, options.renderBaseline, signal));
            const diff = compareImages(app, expected);
            result.screens.push({ name: screen, status: diff.sizeMatch && diff.diffPixels === 0 ? 'same' : 'diff', ratio: diff.ratio });
          } catch (error) {
            // 비교할 화면이나 기준을 만들 수 없으면 비교하지 못한 것이다. 「차이 없음」으로 보지 않는다.
            problems.push(`${screen}: ${error instanceof Error ? error.message : '비교 불가'}`);
            result.screens.push({ name: screen, status: 'missing', ratio: null });
          }
        }
        for (const screen of reported.keys()) if (!Object.hasOwn(command.screens ?? {}, screen)) result.screens.push({ name: screen, status: 'unchecked', ratio: null });
        if (problems.length) { passed = false; reason = `화면 비교 불가 — ${problems.join(' / ')}`; }
      }
      if (command.budgetsMs || timingRuns.some(Boolean)) {
        try {
          const judged = judgeTimingAttempts(timingRuns.length ? timingRuns : [undefined], command.budgetsMs);
          result.timings.push(...judged.timings);
          if (passed && judged.missing.length) { passed = false; reason = `기준이 있는 응답 시간 측정이 없습니다: ${judged.missing.join(', ')}`; }
          if (judged.timings.some(t => t.over)) { passed = false; reason = `응답 시간 기준 초과: ${judged.timings.filter(t => t.over).map(t => `${t.name} p95 ${String(t.p95Ms)}ms > ${String(t.budgetMs ?? 0)}ms`).join(', ')}`; }
        } catch (error) { passed = false; reason = error instanceof Error ? error.message : '응답 시간 기준이 올바르지 않습니다.'; }
      }
      step.attempts = attempts.length;
      step.durationMs = Math.max(0, Math.round(performance.now() - begin));
      step.status = passed ? 'pass' : 'fail';
      if (!passed) {
        result.failStep = name;
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
  // 불안정 후보·격리 실패는 추적을 시작한다. 추적 중인 테스트는 이번에 실패했을 때만 마지막 실패 시각을 바꾼다.
  const tracked = { ...state.tracked };
  for (const key of [...result.flaky, ...result.quarantinedFailures]) tracked[key] = finishedAt;
  for (const [key, failed] of Object.entries(failedOnce)) if (failed && Object.hasOwn(tracked, key)) tracked[key] = finishedAt;
  const flakyKeys = Object.keys(failedOnce).filter(key => Object.hasOwn(tracked, key)).sort();
  if (result.status === 'fail' && state.lastPassSha) result.suspects = await repo.mainCommitsSince(state.lastPassSha, basis.baseSha).catch(() => []);
  result.e2e = tests.total ? tests : null;
  const compared = result.screens.filter(s => s.status !== 'unchecked');
  result.note = [
    result.e2e && `E2E ${String(tests.passed)}/${String(tests.total)}`,
    compared.length && `화면 비교 ${String(compared.length)}개 중 ${String(compared.filter(s => s.status !== 'same').length)}개 차이`,
    result.screens.length > compared.length && `기준 없는 화면 ${String(result.screens.length - compared.length)}`,
    result.timings.length && `응답 시간 ${String(result.timings.length)}개 기록 · 기준 없음 ${String(result.timings.filter(t => t.budgetMs === null).length)} · 초과 ${String(result.timings.filter(t => t.over).length)}`,
    result.flaky.length && `불안정 후보 ${String(result.flaky.length)}`,
    result.quarantinedFailures.length && `격리 실패 ${String(result.quarantinedFailures.length)}`,
    result.failStep && `실패 단계: ${result.failStep}`,
    result.suspects.length && `원인 후보 커밋 ${result.suspects.map(s => s.slice(0, 7)).join(', ')}`,
  ].filter(Boolean).join(' · ');
  await evidence.finish({ stage: 'night', date, status: result.status, baseSha: basis.baseSha, finishedAt });
  await saveNightState(home, { ...state, lastDate: date, runId: started.id, history, tracked, pending: null,
    lastPassSha: result.status === 'pass' ? basis.baseSha : state.lastPassSha });
  await report.update(started.id, {
    fence: null, status: result.status, finishedAt,
    steps: result.steps.map(s => ({ name: s.name, status: s.status, durationMs: s.durationMs })),
    ...(result.e2e && { e2e: result.e2e }),
    ...(flakyKeys.length && { flakyTests: flakyKeys.map(testKey => ({ testKey, rate: flakyRate(history, testKey), lastFailedAt: tracked[testKey] ?? finishedAt })) }),
    ...(result.note && { note: result.note }),
    ...(logExcerpt && { logExcerpt }),
    // 새 실행이므로 후보가 없으면 보내지 않는다(서버는 생략을 「이전 값 보존」으로, []를 「비움」으로 본다).
    ...(result.suspects.length && { causeCandidates: causeCandidates(result) }),
    artifacts: evidence.artifacts,
  });
  // 다른 실행(배포 확인 등)이 동시에 돌 수 있어 미완료 폴더는 남긴다.
  await pruneEvidence(join(home, 'runs'), now(), { keep: new Set([started.id]) }).catch(() => undefined);
  return result;
}
