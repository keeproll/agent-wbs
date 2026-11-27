// Codex 리뷰(review-codex.md)의 재현 시험을 올바른 동작 기준으로 뒤집은 회귀 시험이다.
import { mkdir, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { runNightCheck } from '../../src/ci/night/run.ts';
import { judgeTests } from '../../src/ci/night/tests.ts';
import { pruneEvidence } from '../../src/ci/night/retention.ts';
import { ciFixture } from './night-fixture.ts';
import { commit, file, git } from './int-fixture.ts';
import { png, pngRenderer } from './png.ts';

const NOW = Date.parse('2026-11-27T09:00:00Z');
type F = Awaited<ReturnType<typeof ciFixture>>;
const night = (f: F) => ({ repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report: f.report, home: f.home, quarantined: new Set<string>(), retry: 1, now: () => NOW, renderBaseline: pngRenderer });
const shot = png(2, 2, () => [1, 2, 3, 255]);
async function define(f: F, step: Record<string, unknown>, files: Record<string, Buffer> = {}) {
  for (const [path, value] of Object.entries(files)) await file(join(f.source, path), value.toString('base64'));
  await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify({ ...f.pipeline, stages: { ...f.pipeline.stages, night: [{ argv: ['fake', `night-${String(step.name)}`], ...step }] } }));
  commit(f.source); git(f.source, 'push', f.remote, 'main');
}
const budget = (f: F) => define(f, { name: 'perf', budgetsMs: { 'GET /api/tasks': 300 } });

test.each([undefined, {}, { timings: [] }, { timings: [{ name: 'GET /api/tasks-renamed', samplesMs: [900] }] }])('기준이 있는 측정이 빠지거나 이름이 바뀌면 실패한다 %#', async report => {
  const f = await ciFixture({ night: ['perf'] });
  try {
    await budget(f);
    f.script(async ({ name }) => ({ code: 0, ...(name === 'perf' && report !== undefined ? { report } : {}) }));
    const out = await runNightCheck(night(f), '2026-11-27');
    expect(out).toMatchObject({ status: 'fail', failStep: 'perf' });
    expect(f.final().logExcerpt).toContain('GET /api/tasks');
  } finally { await f.close(); }
});

test('재시도에서 새로 실패한 시험이 있으면 실패다', async () => {
  const a = [{ key: 'a', status: 'pass' as const }, { key: 'b', status: 'fail' as const }];
  const b = [{ key: 'a', status: 'fail' as const }, { key: 'b', status: 'pass' as const }, { key: 'new', status: 'fail' as const }];
  expect(judgeTests([a, b], new Set())).toMatchObject({ failed: ['a', 'new'], flaky: ['b'], blocking: true, total: 3, passed: 1 });
  const f = await ciFixture();
  try {
    f.script(async ({ name, attempt }) => name === 'e2e' ? { code: 1, report: { tests: attempt === 1 ? a : b } } : { code: 0 });
    expect(await runNightCheck(night(f), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'e2e', flaky: ['b'] });
    expect(f.final()).toMatchObject({ status: 'fail', e2e: { passed: 1, total: 3 } });
  } finally { await f.close(); }
});

test('응답 시간은 어느 시도든 기준을 넘으면 기준 초과로 기록한다', async () => {
  const f = await ciFixture({ night: ['perf'] });
  try {
    await budget(f);
    f.script(async ({ name, attempt }) => name !== 'perf' ? { code: 0 } : { code: attempt === 1 ? 1 : 0, report: { tests: [{ key: 'a', status: attempt === 1 ? 'fail' : 'pass' }], timings: [{ name: 'GET /api/tasks', samplesMs: [attempt === 1 ? 900 : 100] }] } });
    const out = await runNightCheck(night(f), '2026-11-27');
    expect(out).toMatchObject({ status: 'fail', failStep: 'perf', timings: [{ name: 'GET /api/tasks', p95Ms: 900, over: true }] });
  } finally { await f.close(); }
});

test('화면 비교 기준은 main 고정 정의의 prototype/uiux HTML을 렌더한 것이고 실행 출력이 바꿀 수 없다', async () => {
  const f = await ciFixture({ night: ['visual'] });
  try {
    const proto = png(2, 2, () => [9, 9, 9, 255]);
    await define(f, { name: 'visual', screens: { wbs: { page: 'prototype/uiux/shots/wbs.html', route: '#wbs', ready: 'main' } } }, { 'prototype/uiux/shots/wbs.html': proto });
    f.script(async ({ name }) => name === 'visual' ? { code: 0, files: { 'fake.png': shot }, report: { screens: [{ name: 'wbs', actual: 'fake.png' }] } } : { code: 0 });
    expect(await runNightCheck(night(f), '2026-11-27')).toMatchObject({ status: 'pass', screens: [{ name: 'wbs', status: 'diff', ratio: 1 }] });
    f.script(async ({ name }) => name === 'visual' ? { code: 0, files: { 'fake.png': shot }, report: { screens: [{ name: 'wbs', actual: 'fake.png', expected: 'fake.png' }] } } : { code: 0 });
    expect(await runNightCheck(night(f), '2026-11-28')).toMatchObject({ status: 'fail', failStep: 'visual' });
  } finally { await f.close(); }
});

test('시작 응답을 잃은 뒤 main이 움직여도 같은 날짜 키로 같은 본문을 다시 보낸다', async () => {
  const f = await ciFixture();
  try {
    const bodies: unknown[] = [];
    const keys: unknown[] = [];
    let lose = true;
    const report = { ...f.report, start: async (body: Parameters<F['report']['start']>[0], key?: string) => {
      bodies.push(body); keys.push(key);
      if (lose) throw new Error('response lost after server commit');
      return f.report.start(body, key);
    } };
    await expect(runNightCheck({ ...night(f), report }, '2026-11-27')).rejects.toThrow('response lost');
    await file(join(f.source, 'later'), 'main advanced'); commit(f.source); git(f.source, 'push', f.remote, 'main');
    lose = false;
    f.script(async () => ({ code: 0 }));
    const out = await runNightCheck({ ...night(f), report }, '2026-11-27');
    expect(keys).toEqual(['night:2026-11-27', 'night:2026-11-27']);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(out.baseSha).toBe(f.main);
    // 끝난 뒤 다음 날은 새 main을 고정한다.
    expect(await f.readJson(join(f.home, 'ci/night/state.json'))).toMatchObject({ pending: null });
    const next = await runNightCheck({ ...night(f), report }, '2026-11-28');
    expect(next.baseSha).not.toBe(f.main);
  } finally { await f.close(); }
});

test('단계가 미리 만든 링크를 따라가 Runner가 다른 파일을 덮어쓰지 않는다', async () => {
  const f = await ciFixture();
  try {
    await mkdir(f.home, { recursive: true });
    const other = join(f.home, 'other-task-evidence.log');
    await writeFile(other, 'KEEP THIS OTHER TASK EVIDENCE');
    f.script(async ({ name, env }) => {
      if (name === 'e2e') {
        const evidence = env.AWBS_EVIDENCE_DIR ?? '';
        // 단계가 아는 경로와 짐작할 수 있는 Runner 경로 모두에 링크를 심는다.
        await symlink(other, join(evidence, 'e2e-1.log'));
        await mkdir(join(evidence, '..', 'runner'), { recursive: true }).catch(() => undefined);
        await symlink(other, join(evidence, '..', 'runner', 'e2e-1.log')).catch(() => undefined);
        await symlink(other, join(evidence, '..', 'runner', 'run.json')).catch(() => undefined);
      }
      return { code: 0, stdout: 'overwrite' };
    });
    const out = await runNightCheck(night(f), '2026-11-27');
    expect(await readFile(other, 'utf8')).toBe('KEEP THIS OTHER TASK EVIDENCE');
    expect(out.status).toBe('pass');
  } finally { await f.close(); }
});

test('보고서 파일이 링크면 따라가지 않고 형식 오류로 실패한다', async () => {
  const f = await ciFixture();
  try {
    const outside = join(f.root, 'outside.json');
    await writeFile(outside, JSON.stringify({ tests: [{ key: 'a', status: 'pass' }] }));
    f.script(async ({ name, env }) => {
      if (name === 'e2e' && env.AWBS_REPORT) await symlink(outside, env.AWBS_REPORT);
      return { code: 0 };
    });
    expect(await runNightCheck(night(f), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'e2e' });
  } finally { await f.close(); }
});

test('추적 중인 불안정 시험은 정상 통과한 뒤에도 낮아진 비율과 실제 마지막 실패 시각을 보낸다', async () => {
  const f = await ciFixture();
  try {
    let now = NOW;
    const options = { ...night(f), now: () => now };
    f.script(async ({ name, attempt }) => name !== 'e2e' ? { code: 0 } : { code: attempt === 1 ? 1 : 0, report: { tests: [{ key: 'a', status: attempt === 1 ? 'fail' : 'pass' }, { key: 'ok', status: 'pass' }] } });
    await runNightCheck(options, '2026-11-27');
    expect(f.final().flakyTests).toEqual([{ testKey: 'a', rate: 1, lastFailedAt: new Date(NOW).toISOString() }]);
    now = NOW + 86_400_000;
    f.script(async ({ name }) => name !== 'e2e' ? { code: 0 } : { code: 0, report: { tests: [{ key: 'a', status: 'pass' }, { key: 'ok', status: 'pass' }] } });
    await runNightCheck(options, '2026-11-28');
    expect(f.final().flakyTests).toEqual([{ testKey: 'a', rate: 0.5, lastFailedAt: new Date(NOW).toISOString() }]);
  } finally { await f.close(); }
});

test('끝 기록이 없는 실행 폴더는 기본으로 지우지 않는다(진행 중일 수 있다)', async () => {
  const f = await ciFixture();
  try {
    const runs = join(f.home, 'runs');
    const active = '00000000-0000-4000-8000-000000000099';
    const dir = join(runs, active);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'active.log'), 'still in progress');
    const old = (NOW - 31 * 86400000) / 1000;
    await utimes(dir, old, old);
    expect(await pruneEvidence(runs, NOW)).toEqual([]);
    expect(await readdir(runs)).toEqual([active]);
    // 진행 중인 실행이 없다고 확인한 호출(Runner 시작 때)만 미완료 폴더를 정리한다.
    expect(await pruneEvidence(runs, NOW, { unfinished: 'remove' })).toEqual([active]);
  } finally { await f.close(); }
});

test('Runner가 붙이는 단계 이름은 사용자 단계 이름과 겹치지 않는다', async () => {
  const f = await ciFixture({ night: ['install'] });
  try {
    f.script(async () => ({ code: 0 }));
    const out = await runNightCheck(night(f), '2026-11-27');
    const names = f.final().steps?.map(s => s.name) ?? [];
    expect(names).toEqual(['runner:install', 'install']);
    expect(out.status).toBe('pass');
    const logs = f.final().artifacts?.filter(a => a.endsWith('.log')) ?? [];
    expect(new Set(logs).size).toBe(2);
  } finally { await f.close(); }
});

test('단계가 커밋 파일을 바꾸면 그 단계가 실패한다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name, cwd }) => {
      if (name === 'e2e') await writeFile(join(cwd, 'shared'), 'changed');
      return { code: 0 };
    });
    expect(await runNightCheck(night(f), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'e2e' });
  } finally { await f.close(); }
});

test('추적 중인 시험이 진짜로 실패하면 마지막 실패 시각을 그날로 바꾼다', async () => {
  const f = await ciFixture();
  try {
    let now = NOW;
    const options = { ...night(f), now: () => now };
    f.script(async ({ name, attempt }) => name !== 'e2e' ? { code: 0 } : { code: attempt === 1 ? 1 : 0, report: { tests: [{ key: 'a', status: attempt === 1 ? 'fail' : 'pass' }] } });
    await runNightCheck(options, '2026-11-27');
    now = NOW + 86_400_000;
    f.script(async ({ name }) => name !== 'e2e' ? { code: 0 } : { code: 1, report: { tests: [{ key: 'a', status: 'fail' }] } });
    expect((await runNightCheck(options, '2026-11-28')).status).toBe('fail');
    expect(f.final().flakyTests).toEqual([{ testKey: 'a', rate: 1, lastFailedAt: new Date(now).toISOString() }]);
  } finally { await f.close(); }
});
