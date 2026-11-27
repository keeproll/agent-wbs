import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parsePipeline } from '../../src/ci/pipeline.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { causeCandidates, policyQuarantine, runNightCheck } from '../../src/ci/night/run.ts';
import { commit, definition, file, git } from './int-fixture.ts';
import { ciFixture } from './night-fixture.ts';

const night = (step: Record<string, unknown>) => JSON.stringify({ ...definition, stages: { ...definition.stages, night: [{ name: 'perf', argv: ['fake', 'night-perf'], ...step }] } });

test('응답 시간 기준은 main 정의의 night 단계 선택 필드 budgetsMs로 받는다', () => {
  expect(parsePipeline(night({ budgetsMs: { 'GET /api/tasks': 300 } })).stages.night[0]).toEqual({ name: 'perf', argv: ['fake', 'night-perf'], budgetsMs: { 'GET /api/tasks': 300 } });
  expect(parsePipeline(night({})).stages.night[0]).toEqual({ name: 'perf', argv: ['fake', 'night-perf'] });
});

test.each([
  [{ budgetsMs: { 'GET /x': 0 } }], [{ budgetsMs: { 'GET /x': -1 } }], [{ budgetsMs: { 'GET /x': 1.5 } }],
  [{ budgetsMs: { 'GET /x': '300' } }], [{ budgetsMs: { '': 300 } }], [{ budgetsMs: {} }], [{ budgetsMs: [300] }],
  [{ budgetsMs: { 'GET /x': 600_001 } }],
])('잘못된 기준은 거부한다 %#', (step) => {
  expect(() => parsePipeline(night(step))).toThrow();
});

test.each(['task', 'int', 'deploy'] as const)('night 밖(%s) 단계의 기준은 거부한다', (stage) => {
  const stages = structuredClone(definition.stages) as Record<string, Record<string, unknown>[]>;
  const first = stages[stage]?.[0];
  if (first) first.budgetsMs = { 'GET /x': 1 };
  expect(() => parsePipeline(JSON.stringify({ ...definition, stages }))).toThrow();
});

async function perfFixture(budgets?: Record<string, number>) {
  const f = await ciFixture({ night: ['perf'] });
  if (!budgets) return f;
  const stages = { ...f.pipeline.stages, night: [{ name: 'perf', argv: ['fake', 'night-perf'], budgetsMs: budgets }] };
  await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify({ ...f.pipeline, stages }));
  commit(f.source); git(f.source, 'push', f.remote, 'main');
  return f;
}
const options = (f: Awaited<ReturnType<typeof ciFixture>>) => ({
  repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report: f.report, home: f.home,
  quarantined: new Set<string>(), retry: 1, now: () => Date.parse('2026-11-26T17:00:30Z'),
});

test('기준은 정의에서 읽어 p95와 비교한다', async () => {
  const f = await perfFixture({ 'GET /api/tasks': 300 });
  try {
    f.script(async ({ name }) => name !== 'perf' ? { code: 0 } : { code: 0, report: { timings: [{ name: 'GET /api/tasks', samplesMs: [100, 900] }] } });
    expect(await runNightCheck(options(f), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'perf',
      timings: [{ name: 'GET /api/tasks', p95Ms: 900, budgetMs: 300, over: true }] });
  } finally { await f.close(); }
});

test('실행 출력이 기준(budgetMs)을 보내면 보고서 형식 오류로 실패한다', async () => {
  const f = await perfFixture({ 'GET /api/tasks': 300 });
  try {
    f.script(async ({ name }) => name !== 'perf' ? { code: 0 } : { code: 0, report: { timings: [{ name: 'GET /api/tasks', samplesMs: [100], budgetMs: 99_999 }] } });
    expect(await runNightCheck(options(f), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'perf' });
  } finally { await f.close(); }
});

test('기준이 없는 API는 응답 시간을 기록만 하고 통과를 막지 않는다', async () => {
  const f = await perfFixture({ 'GET /api/tasks': 300 });
  try {
    f.script(async ({ name }) => name !== 'perf' ? { code: 0 } : { code: 0, report: { timings: [{ name: 'GET /api/tasks', samplesMs: [100] }, { name: 'GET /api/wbs', samplesMs: [5_000] }] } });
    const result = await runNightCheck(options(f), '2026-11-27');
    expect(result).toMatchObject({ status: 'pass', timings: [{ name: 'GET /api/tasks', budgetMs: 300, over: false }, { name: 'GET /api/wbs', p95Ms: 5_000, budgetMs: null, over: false }] });
    expect(f.final().note).toContain('응답 시간 2개 기록 · 기준 없음 1 · 초과 0');
  } finally { await f.close(); }
});

test('정의에 기준이 하나도 없으면 모두 기록만 한다', async () => {
  const f = await perfFixture();
  try {
    f.script(async ({ name }) => name !== 'perf' ? { code: 0 } : { code: 0, report: { timings: [{ name: 'GET /api/tasks', samplesMs: [9_000] }] } });
    expect(await runNightCheck(options(f), '2026-11-27')).toMatchObject({ status: 'pass', timings: [{ budgetMs: null, over: false }] });
  } finally { await f.close(); }
});

test('정책의 격리 목록(ci.quarantined, 필수)을 판정 집합으로 바꾼다', () => {
  expect(policyQuarantine({ quarantined: [] })).toEqual(new Set());
  expect(policyQuarantine({ quarantined: ['a', 'b'] })).toEqual(new Set(['a', 'b']));
  expect(() => policyQuarantine({})).toThrow();
  expect(() => policyQuarantine({ quarantined: ['a', 1] })).toThrow();
  expect(() => policyQuarantine({ quarantined: 'a' })).toThrow();
  expect(causeCandidates({ suspects: ['a'.repeat(40)] })).toEqual([{ commit: 'a'.repeat(40) }]);
});
