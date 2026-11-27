import { describe, expect, it } from 'vitest';
import {
  attemptCiRef, baselineActive, detailSteps, mergeLine, retryHeld, formatDuration, githubLabel, lastDeploy, mainStatus, openFailures, position, queueRows, resultLabel, runDurationMs,
  runRows, stageCounts, summaryLine, tabBadges,
  type CiRun, type QueueItem,
} from '../src/features/ci/model.ts';

const run = (o: Partial<CiRun> & Pick<CiRun, 'id' | 'stage' | 'status'>): CiRun => ({
  runKey: o.id.toUpperCase(), taskKey: null, attemptId: null, ref: 'main', pr: null, trigger: null, baseSha: null, headSha: null,
  mergeSha: null, treeSha: null, pipelineSha: null, steps: [], failStep: null, failScope: null, logExcerpt: null, artifacts: [], url: null,
  startedAt: '2026-11-03T00:00:00.000Z', ...o,
} as CiRun);
const sha = (c: string) => c.repeat(40);

// 서버 순서(최근 먼저: created_at desc, run_no desc)
const runs: CiRun[] = [
  run({ id: 'r6', stage: 'night', status: 'pass', headSha: sha('c'), startedAt: '2026-11-02T17:00:00.000Z' }),
  run({ id: 'r5', stage: 'task', status: 'pass', taskKey: 'TASK-0004', pr: 9, startedAt: '2026-11-03T08:47:00.000Z' }),
  run({ id: 'r4', stage: 'task', status: 'fail', taskKey: 'TASK-0004', pr: 9, failStep: 'contract', startedAt: '2026-11-03T08:40:00.000Z' }),
  run({ id: 'r3', stage: 'deploy', status: 'pass', url: 'http://localhost:8080', startedAt: '2026-11-02T09:05:00.000Z' }),
  run({ id: 'r2', stage: 'int', status: 'fail', taskKey: 'TASK-0002', pr: 5, startedAt: '2026-10-29T08:02:00.000Z' }),
  run({ id: 'r1', stage: 'task', status: 'pass', taskKey: 'TASK-0001', pr: 3, startedAt: '2026-10-28T06:11:00.000Z' }),
];

describe('빌드·통합 화면 계산(UI-08, P ciVM L4765–4801)', () => {
  it('단계 필터: 전체는 서버 순서 그대로, 단계별 건수는 필터와 무관하게 전체에서 센다', () => {
    expect(runRows(runs, '').map((r) => r.id)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
    expect(runRows(runs, 'task').map((r) => r.id)).toEqual(['r5', 'r4', 'r1']);
    expect(stageCounts(runs)).toEqual({ '': 6, task: 3, int: 1, night: 1, deploy: 1 });
  });

  it('결과 표시: Task 탓 실패와 기준선(main) 실패를 다르게 보인다(조정자 결정: failScope=baseline)', () => {
    expect(resultLabel(run({ id: 'a', stage: 'task', status: 'pass' }))).toEqual({ l: '통과', c: 'vf v-pass' });
    expect(resultLabel(run({ id: 'a', stage: 'task', status: 'fail', failScope: 'task' }))).toEqual({ l: '실패', c: 'vf v-fail' });
    expect(resultLabel(run({ id: 'a', stage: 'task', status: 'fail', failScope: 'baseline' }))).toEqual({ l: '기준선 실패', c: 'sc sc-warn' });
    expect(resultLabel(run({ id: 'a', stage: 'task', status: 'skip' })).l).toBe('건너뜀');
    expect(resultLabel(run({ id: 'a', stage: 'task', status: 'run' })).l).toBe('실행 중');
  });

  it('소요 시간: 끝난 시각이 있으면 시작~끝, 없으면 보고된 단계 시간의 합', () => {
    expect(runDurationMs(run({ id: 'a', stage: 'night', status: 'pass', startedAt: '2026-11-02T17:00:00.000Z', finishedAt: '2026-11-02T17:14:02.000Z', steps: [{ name: 'x', status: 'pass', durationMs: 1000 }] }))).toBe(842_000);
  });

  it('소요 시간은 보고된 단계 시간의 합. 단계가 없으면 「—」', () => {
    const r = run({ id: 'a', stage: 'task', status: 'pass', steps: [{ name: 'a', status: 'pass', durationMs: 120_000 }, { name: 'b', status: 'pass', durationMs: 2_400 }] });
    expect(runDurationMs(r)).toBe(122_400);
    expect(formatDuration(122_400)).toBe('2분 02초');
    expect(formatDuration(45_000)).toBe('45초');
    expect(formatDuration(null)).toBe('—');
  });

  it('실패 뒤 실행하지 않은 단계는 「건너뜀」(UAT-CI-01 d). 실패 단계는 실패, 앞 단계는 보고값', () => {
    const r = run({
      id: 'a', stage: 'task', status: 'fail', failStep: 'lint',
      steps: [
        { name: 'install', status: 'pass', durationMs: 1000 }, { name: 'lint', status: 'fail', durationMs: 136_000 },
        { name: 'test', status: 'queued', durationMs: 0 }, { name: 'build', status: 'run', durationMs: 0 },
      ],
    });
    expect(detailSteps(r).map((s) => [s.name, s.l])).toEqual([['install', '통과'], ['lint', '실패'], ['test', '건너뜀'], ['build', '건너뜀']]);
    expect(detailSteps(r).map((s) => s.dur)).toEqual(['1초', '136초', '—', '—']);
  });

  it('실패 단계가 단계 목록에 보고되지 않았으면 맨 뒤에 실패로 더한다(어느 단계에서 멈췄는지 잃지 않기)', () => {
    const r = run({ id: 'a', stage: 'task', status: 'fail', failStep: 'protected-paths', steps: [{ name: 'install', status: 'pass', durationMs: 1000 }] });
    expect(detailSteps(r).map((s) => [s.name, s.l])).toEqual([['install', '통과'], ['protected-paths', '실패']]);
  });

  it('이전·다음 위치: 목록 안이면 「i / n」, 필터 때문에 목록 밖이면 「목록 밖」', () => {
    const ids = ['r5', 'r4', 'r1'];
    expect(position(ids, 'r4')).toEqual({ label: '2 / 3', prev: 'r5', next: 'r1' });
    expect(position(ids, 'r5')).toEqual({ label: '1 / 3', prev: null, next: 'r4' });
    expect(position(ids, 'r6')).toEqual({ label: '목록 밖', prev: null, next: null });
  });

  it('미해결 실패: 같은 단계·같은 Task(PR)의 더 최근 통과가 없는 실패만 센다', () => {
    // r4(TASK-0004 task 실패)는 r5가 뒤에 통과 → 해결. r2(int 실패)는 미해결.
    expect(openFailures(runs)).toBe(1);
  });

  it('main 상태: 가장 최근 야간 점검·병합된 통합 확인·기준선 실패로 정한다', () => {
    expect(mainStatus(runs)).toEqual({ l: `main 정상 · ${'c'.repeat(7)} · 2026-11-03 02:00`, c: 'vf v-pass' });
    // Runner가 E2E 수와 끝난 시각을 보고하면 원본처럼 「E2E 12 / 12 · 끝난 시각」
    const withE2e = [run({ id: 'n', stage: 'night', status: 'pass', headSha: sha('c'), e2e: { passed: 12, total: 12 }, startedAt: '2026-11-02T17:00:00.000Z', finishedAt: '2026-11-02T17:14:00.000Z' })];
    expect(mainStatus(withE2e).l).toBe(`main 정상 · ${'c'.repeat(7)} · E2E 12 / 12 · 2026-11-03 02:14`);
    const broken = [run({ id: 'b', stage: 'task', status: 'fail', failScope: 'baseline', baseSha: sha('d'), startedAt: '2026-11-04T00:00:00.000Z' }), ...runs];
    expect(mainStatus(broken)).toEqual({ l: `main 깨짐 · 기준선 검사 실패 · ${'d'.repeat(7)} · 2026-11-04 09:00`, c: 'vf v-fail' });
    expect(mainStatus([])).toEqual({ l: 'main 빌드 기록 없음', c: 'vf v-none' });
    // 통합 확인 실패는 병합되지 않았으므로 main을 깨지 않는다
    expect(mainStatus([run({ id: 'x', stage: 'int', status: 'fail', pr: 1 })]).l).toBe('main 빌드 기록 없음');
  });

  it('GitHub 칸: Runner가 실제로 보고한 상태만 「보고」로 보인다. 보고가 없으면 확인 전(PASS로 꾸미지 않음)', () => {
    const gh = { headSha: sha('a'), context: 'agentwbs/int', state: 'failure' as const, reportedAt: '2026-10-29T08:12:00.000Z' };
    expect(githubLabel(run({ id: 'a', stage: 'int', status: 'fail', pr: 5, githubStatus: gh }))).toBe('GitHub PR #5 검사 상태 보고: agentwbs/int — failure · 2026-10-29 17:12');
    expect(githubLabel(run({ id: 'a', stage: 'task', status: 'pass', pr: 9 }))).toBe('GitHub PR #9 검사 상태 보고 확인 전 (agentwbs/task)');
    expect(githubLabel(run({ id: 'a', stage: 'night', status: 'pass' }))).toBe('main 대상 — PR 없음');
    expect(githubLabel(run({ id: 'a', stage: 'night', status: 'pass', githubStatus: { ...gh, context: 'agentwbs/night', state: 'success' } }))).toBe('main 커밋 검사 상태 보고: agentwbs/night — success · 2026-10-29 17:12');
  });

  it('병합 대기열: 상태 이름·색, 실제 병합 SHA가 있는데 병합됨이 아니면 MERGE_MISMATCH 경고(완료 보류)', () => {
    const q = (o: Partial<QueueItem> & Pick<QueueItem, 'id' | 'status'>): QueueItem => ({
      pr: 9, taskKey: 'TASK-0004', position: 1, qaHeadSha: null, syncedHeadSha: null, baseSha: null, ciRunId: null, actualMergeSha: null, ...o,
    } as QueueItem);
    const rows = queueRows([
      q({ id: 'q1', status: 'merged', ciRunId: 'r2', actualMergeSha: sha('e'), queuedAt: '2026-10-29T07:00:00.000Z', mergedAt: '2026-10-29T08:11:00.000Z' }),
      q({ id: 'q2', status: 'checking', queuedAt: '2026-11-03T09:22:00.000Z' }),
      q({ id: 'q3', status: 'failed' }),
      q({ id: 'q4', status: 'checking', actualMergeSha: sha('f') }),
      q({ id: 'q5', status: 'waiting_verify' }),
      q({ id: 'q6', status: 'merged', actualMergeSha: sha('e') }),
      q({ id: 'q7', status: 'failed', ciRunId: 'rb' }),
    ], new Map([['TASK-0004', 'Drizzle Schema 설계']]), [...runs, run({ id: 'rb', stage: 'task', status: 'fail', failScope: 'baseline', runKey: 'RB' })]);
    expect(rows.map((r) => [r.st, r.c])).toEqual([
      ['병합됨', 'vf v-pass'], ['통합 확인 중', 'vf v-run'], ['통합 실패 — 병합 보류', 'vf v-fail'], ['통합 확인 중', 'vf v-run'], ['검증 대기', 'vf v-none'],
      ['병합됨', 'vf v-pass'],
      // 기준선 실패로 끝난 통합: Task 탓이 아니다. 같은 Task에 병합 불일치(q4)가 걸려 있어 자동 재통합 대상은 아니다(아래 P2-3)
      ['기준선 실패', 'sc sc-warn'],
    ]);
    expect(rows.map((r) => r.mismatch)).toEqual([false, false, false, true, false, false, false]);
    // 시각: 병합됨은 실제 병합 시각, 그 밖은 대기열에 들어온 시각. 병합 시각을 모르면 꾸미지 않는다.
    expect(rows[0]?.at).toBe('2026-10-29 17:11');
    expect(rows[1]?.at).toBe('2026-11-03 18:22');
    expect(rows[4]?.at).toBe('—');
    expect(rows[5]?.at).toBe('병합 시각 미확인');
    expect(rows[0]?.title).toBe('Drizzle Schema 설계');
    expect(rows[0]?.ciRunKey).toBe('R2');
    expect(rows[1]?.ciRunKey).toBeNull();
  });

  it('요약 한 줄과 탭 배지(실행=미해결 실패, 대기열=병합 전, 불안정=격리 수)', () => {
    const queue = [{ status: 'merged' }, { status: 'queued' }, { status: 'removed' }] as QueueItem[];
    expect(summaryLine(runs, queue)).toBe('실행 6 · 실패 미해결 1 · 병합 대기 1 · 마지막 배포 확인 2026-11-02 18:05 통과');
    expect(summaryLine([], [])).toBe('실행 0 · 실패 미해결 0 · 병합 대기 0 · 마지막 배포 확인 없음');
    expect(tabBadges(runs, queue, [{ quarantined: true }, { quarantined: false }] as never)).toEqual({ runs: 1, queue: 1, flaky: 1 });
    expect(lastDeploy(runs)?.id).toBe('r3');
  });

  it('시도의 CI 참조(UAT-TASK-10-CI): 그 시도의 가장 최근 Task 검사. 다른 단계·다른 시도는 참조가 아니다', () => {
    const list = [
      run({ id: 'n', stage: 'int', status: 'fail', attemptId: 'a1', runKey: 'CI-9' }),
      run({ id: 'p', stage: 'task', status: 'pass', attemptId: 'a1', runKey: 'CI-8' }),
      run({ id: 'f', stage: 'task', status: 'fail', attemptId: 'a1', runKey: 'CI-7' }),
      run({ id: 'b', stage: 'task', status: 'fail', attemptId: 'a2', runKey: 'CI-6', failScope: 'baseline' }),
    ];
    expect(attemptCiRef(list, 'a1')).toEqual({ id: 'p', l: 'Task 검사 통과 · CI-8', c: 'sc sc-ok' });
    expect(attemptCiRef(list.slice(2), 'a1')).toEqual({ id: 'f', l: 'Task 검사 실패 · CI-7', c: 'sc sc-bad' });
    expect(attemptCiRef(list, 'a2')).toEqual({ id: 'b', l: 'Task 검사 기준선 실패 · CI-6', c: 'sc sc-warn' });
    expect(attemptCiRef(list, 'a3')).toBeNull();
  });

  describe('리뷰 fix1(Codex P2)', () => {
    const qi = (o: Partial<QueueItem> & Pick<QueueItem, 'id' | 'status'>): QueueItem => ({
      pr: 11, taskKey: 'TASK-0006', position: 1, qaHeadSha: null, syncedHeadSha: null, baseSha: null, ciRunId: null, actualMergeSha: null, ...o,
    } as QueueItem);

    it('P2-1: ② PASS의 mergeSha만으로 main 정상이라 하지 않는다. 연결 대기열이 병합됨일 때만, 병합 불일치면 확인 필요', () => {
      const intPass = run({ id: 'i', stage: 'int', status: 'pass', pr: 11, mergeSha: sha('e'), startedAt: '2026-11-04T00:00:00.000Z' });
      expect(mainStatus([intPass], [qi({ id: 'q', status: 'merged', ciRunId: 'i', actualMergeSha: sha('e') })]).l).toBe(`main 정상 · ${'e'.repeat(7)} · 2026-11-04 09:00`);
      expect(mainStatus([intPass], [qi({ id: 'q', status: 'checking', ciRunId: 'i', actualMergeSha: sha('f') })]))
        .toEqual({ l: `main 확인 필요 · 병합 불일치 · ${'f'.repeat(7)} · 2026-11-04 09:00`, c: 'vf v-fail' });
      // 대기열에서 병합을 확인하지 못한 ② PASS는 근거가 아니다(다음 근거로 넘어간다)
      expect(mainStatus([intPass, ...runs], []).l).toBe(`main 정상 · ${'c'.repeat(7)} · 2026-11-03 02:00`);
    });

    it('P2-2: 같은 기준·같은 정의의 더 나중 ① PASS가 있으면 기준선 실패는 해소(서버 경보 해소 규칙)', () => {
      const fail = run({ id: 'b', stage: 'task', status: 'fail', failScope: 'baseline', baseSha: sha('d'), pipelineSha: sha('9'), startedAt: '2026-11-04T00:00:00.000Z' });
      const pass = (o: Partial<CiRun>) => run({ id: 'p', stage: 'task', status: 'pass', baseSha: sha('d'), pipelineSha: sha('9'), startedAt: '2026-11-04T01:00:00.000Z', ...o });
      expect(baselineActive([pass({}), fail], fail)).toBe(false);
      expect(mainStatus([pass({}), fail, ...runs]).l).toBe(`main 정상 · ${'c'.repeat(7)} · 2026-11-03 02:00`);
      // 다른 정의로 실행한 PASS, 다른 기준의 PASS, 더 먼저 시작한(늦게 끝난) PASS는 해소하지 않는다
      expect(baselineActive([pass({ pipelineSha: sha('8') }), fail], fail)).toBe(true);
      expect(baselineActive([pass({ baseSha: sha('a') }), fail], fail)).toBe(true);
      expect(baselineActive([fail, pass({ startedAt: '2026-11-03T23:00:00.000Z', finishedAt: '2026-11-04T02:00:00.000Z' })], fail)).toBe(true);
    });

    it('P2-3: 「자동 재통합」 안내는 그 Task의 최신 차수·Task가 gate·보류 없음일 때만', () => {
      const b = run({ id: 'rb', stage: 'task', status: 'fail', failScope: 'baseline', runKey: 'RB' });
      const all = [b];
      const gate = new Map([['TASK-0006', 'gate']]);
      const one = queueRows([qi({ id: 'q1', status: 'failed', ciRunId: 'rb', position: 1 })], new Map(), all, gate);
      expect([one[0]?.st, one[0]?.autoReintegrate]).toEqual(['기준선 실패 — main 수정 뒤 자동 재통합', true]);
      // 새 차수가 생겼으면 옛 차수는 과거 결과일 뿐
      const two = queueRows([qi({ id: 'q1', status: 'failed', ciRunId: 'rb', position: 1 }), qi({ id: 'q2', status: 'checking', position: 2 })], new Map(), all, gate);
      expect([two[0]?.st, two[0]?.autoReintegrate]).toEqual(['기준선 실패', false]);
      // 병합 불일치 보류가 걸린 Task, 이미 끝난 Task도 자동 재통합 대상이 아니다
      const held = queueRows([qi({ id: 'q1', status: 'failed', ciRunId: 'rb', position: 1 }), qi({ id: 'q0', status: 'checking', position: 0, actualMergeSha: sha('f') })], new Map(), all, gate);
      expect(held.find((r) => r.id === 'q1')?.st).toBe('기준선 실패');
      expect(queueRows([qi({ id: 'q1', status: 'failed', ciRunId: 'rb' })], new Map(), all, new Map([['TASK-0006', 'done']]))[0]?.st).toBe('기준선 실패');
      expect(queueRows([qi({ id: 'q1', status: 'failed', ciRunId: 'rb' })], new Map(), all, gate)[0]?.c).toBe('sc sc-warn');
    });

    it('P2-4: 보류로 다시 실행을 막는 것은 기준선 실패 실행뿐(서버가 보류를 검사하는 재통합 경로)', () => {
      const holds = new Set(['TASK-0006']);
      expect(retryHeld(run({ id: 'a', stage: 'task', status: 'fail', failScope: 'baseline', taskKey: 'TASK-0006' }), holds)).toBe(true);
      expect(retryHeld(run({ id: 'a', stage: 'task', status: 'fail', failScope: 'task', taskKey: 'TASK-0006' }), holds)).toBe(false);
      expect(retryHeld(run({ id: 'a', stage: 'task', status: 'fail', failScope: 'baseline', taskKey: 'TASK-0001' }), holds)).toBe(false);
    });
  });

  it('재리뷰 P2-1: 상세의 병합 줄은 연결 대기열의 서버 상태 그대로(병합됨일 때만 「병합됨」)', () => {
    const r = run({ id: 'i', stage: 'int', status: 'pass', pr: 7, mergeSha: sha('c') });
    const qi = (o: Partial<QueueItem>): QueueItem => ({ id: 'q', pr: 7, taskKey: 'TASK-0003', position: 1, status: 'merged', qaHeadSha: null, syncedHeadSha: null, baseSha: null, ciRunId: 'i', actualMergeSha: sha('c'), ...o } as QueueItem);
    expect(mergeLine(r, [qi({})])).toBe(`병합됨 → main @ ${'c'.repeat(7)}`);
    expect(mergeLine(r, [qi({ status: 'checking', actualMergeSha: sha('d') })])).toBe(`병합 불일치 — 실제 병합 ${'d'.repeat(7)} · 완료 보류 (검사한 병합본 ${'c'.repeat(7)})`);
    expect(mergeLine(r, [qi({ status: 'checking', actualMergeSha: null })])).toBe(`통합 확인 중 — 병합 전 (검사한 병합본 ${'c'.repeat(7)})`);
    expect(mergeLine(r, [])).toBe(`대기열 기록 없음 — 병합 여부 미확인 (검사한 병합본 ${'c'.repeat(7)})`);
    expect(mergeLine(run({ id: 'x', stage: 'int', status: 'fail' }), [])).toBeNull();
    expect(mergeLine(run({ id: 'y', stage: 'task', status: 'pass', mergeSha: sha('c') }), [])).toBeNull();
  });
});
