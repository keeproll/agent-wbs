import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { dueNight, runNightCheck } from '../../src/ci/night/run.ts';
import { ciFixture } from './night-fixture.ts';
import { png } from './png.ts';
import { file, commit, git } from './int-fixture.ts';

const NOW = Date.parse('2026-11-26T17:00:30Z');
const options = (f: Awaited<ReturnType<typeof ciFixture>>, extra: Partial<Parameters<typeof runNightCheck>[0]> = {}) => ({
  repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report: f.report, home: f.home,
  quarantined: new Set<string>(), retry: 1, now: () => NOW, ...extra,
});

test('main을 고정해 job 없이 night:<date> 키로 시작하고 fence null로 보고한다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name }) => ({ code: 0, ...(name === 'e2e' && { report: { tests: [{ key: 'login.spec.ts › 로그인', status: 'pass' }] } }) }));
    const result = await runNightCheck(options(f), '2026-11-27');
    expect(f.reports[0]).toEqual({ kind: 'start', key: 'night:2026-11-27', body: {
      stage: 'night', ref: 'main', trigger: '야간 일정', baseSha: f.main, headSha: f.main, pipelineSha: result.pipelineSha } });
    expect(f.reports[0]?.body).not.toHaveProperty('jobId');
    expect(f.reports[1]).toMatchObject({ kind: 'update', body: { fence: null, status: 'run' } });
    expect(f.final()).toMatchObject({ fence: null, status: 'pass', e2e: { passed: 1, total: 1 }, finishedAt: new Date(NOW).toISOString() });
    expect(f.final().steps?.map(s => [s.name, s.status])).toEqual([['runner:install', 'pass'], ['e2e', 'pass']]);
    expect(f.reports.every(r => r.kind === 'start' || (r.body as { fence: unknown }).fence === null)).toBe(true);
    expect(f.calls.every(c => c.cwd !== f.source && !c.cwd.startsWith(f.home))).toBe(true);
  } finally { await f.close(); }
});

test('실패 테스트는 1회 재시도하고 재시도로만 통과하면 불안정 후보로 보고하되 담당 Task는 보내지 않는다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name, attempt }) => name !== 'e2e' ? { code: 0 } : attempt === 1
      ? { code: 1, stderr: '1 failed', report: { tests: [{ key: 'wbs-tree.spec.ts › 접힘', status: 'fail' }, { key: 'ok', status: 'pass' }] } }
      : { code: 0, report: { tests: [{ key: 'wbs-tree.spec.ts › 접힘', status: 'pass' }, { key: 'ok', status: 'pass' }] } });
    const result = await runNightCheck(options(f), '2026-11-27');
    expect(f.calls.filter(c => c.name === 'e2e')).toHaveLength(2);
    expect(result).toMatchObject({ status: 'pass', flaky: ['wbs-tree.spec.ts › 접힘'] });
    expect(f.final().flakyTests).toEqual([{ testKey: 'wbs-tree.spec.ts › 접힘', rate: 1, lastFailedAt: new Date(NOW).toISOString() }]);
    expect(JSON.stringify(f.reports)).not.toMatch(/taskKey|"task"/);
    expect(f.final().note).toContain('불안정 후보 1');
  } finally { await f.close(); }
});

test('재시도 한도는 정책 값을 따르고 끝까지 실패하면 실패 단계와 로그 발췌를 남긴다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name }) => name !== 'e2e' ? { code: 0 } : { code: 1, stderr: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 boom', report: { tests: [{ key: 'a', status: 'fail' }] } });
    const result = await runNightCheck(options(f, { retry: 2 }), '2026-11-27');
    expect(f.calls.filter(c => c.name === 'e2e')).toHaveLength(3);
    expect(result).toMatchObject({ status: 'fail', failStep: 'e2e' });
    expect(f.final()).toMatchObject({ status: 'fail', e2e: { passed: 0, total: 1 } });
    expect(f.final().logExcerpt).toContain('boom');
    expect(f.final().logExcerpt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(f.final().flakyTests).toBeUndefined();
  } finally { await f.close(); }
});

test('격리한 테스트가 실패해도 통과를 막지 않고 결과를 기록한다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name }) => name !== 'e2e' ? { code: 0 } : { code: 1, report: { tests: [{ key: 'q', status: 'fail' }, { key: 'b', status: 'pass' }] } });
    const result = await runNightCheck(options(f, { quarantined: new Set(['q']) }), '2026-11-27');
    expect(result).toMatchObject({ status: 'pass', quarantinedFailures: ['q'] });
    expect(f.final()).toMatchObject({ status: 'pass', e2e: { passed: 1, total: 2 } });
    expect(f.final().flakyTests).toEqual([{ testKey: 'q', rate: 1, lastFailedAt: new Date(NOW).toISOString() }]);
    expect(f.final().note).toContain('격리 실패 1');
  } finally { await f.close(); }
});

test('종료 코드 0이어도 보고서에 격리하지 않은 실패가 있으면 실패다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name }) => name !== 'e2e' ? { code: 0 } : { code: 0, report: { tests: [{ key: 'a', status: 'fail' }] } });
    expect(await runNightCheck(options(f), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'e2e' });
  } finally { await f.close(); }
});

test('테스트 실패 없이 종료 코드만 실패면 격리와 관계없이 실패다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name }) => name !== 'e2e' ? { code: 0 } : { code: 2, report: { tests: [{ key: 'b', status: 'pass' }] } });
    expect(await runNightCheck(options(f, { quarantined: new Set(['b']) }), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'e2e' });
  } finally { await f.close(); }
});

async function screens(f: Awaited<ReturnType<typeof ciFixture>>, table: Record<string, string>, files: Record<string, Buffer>) {
  for (const [path, value] of Object.entries(files)) await file(join(f.source, path), value as unknown as string);
  const stages = { ...f.pipeline.stages, night: [{ name: 'visual', argv: ['fake', 'night-visual'], screens: table }] };
  await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify({ ...f.pipeline, stages }));
  commit(f.source); git(f.source, 'push', f.remote, 'main');
}

test('화면 스크린샷을 main의 프로토타입 기준 이미지와 픽셀 비교하고 차이는 기록, 빠진 화면은 실패로 본다', async () => {
  const f = await ciFixture({ night: ['visual'] });
  try {
    const same = png(2, 2, () => [10, 20, 30, 255]);
    const diff = png(2, 2, (x) => x ? [10, 20, 30, 255] : [0, 0, 0, 255]);
    await screens(f, { wbs: 'prototype/uiux/shots/wbs.png', task: 'prototype/uiux/shots/task.png' },
      { 'prototype/uiux/shots/wbs.png': same, 'prototype/uiux/shots/task.png': same });
    f.script(async ({ name }) => name !== 'visual' ? { code: 0 } : { code: 0,
      files: { 'shots/wbs.png': same, 'shots/task.png': diff, 'shots/extra.png': same },
      report: { screens: [{ name: 'wbs', actual: 'shots/wbs.png' }, { name: 'task', actual: 'shots/task.png' }, { name: 'extra', actual: 'shots/extra.png' }] } });
    const ok = await runNightCheck(options(f), '2026-11-27');
    expect(ok.status).toBe('pass');
    expect(ok.screens).toEqual([{ name: 'wbs', status: 'same', ratio: 0 }, { name: 'task', status: 'diff', ratio: 0.5 }, { name: 'extra', status: 'unchecked', ratio: null }]);
    expect(f.final().note).toContain('화면 비교 2개 중 1개 차이 · 기준 없는 화면 1');
    expect(f.final().artifacts).toEqual(expect.arrayContaining([`runs/${ok.runId}/step/shots/task.png`]));

    f.script(async ({ name }) => name !== 'visual' ? { code: 0 } : { code: 0, files: { 'a.png': same },
      report: { screens: [{ name: 'wbs', actual: 'a.png' }] } });
    const missing = await runNightCheck(options(f), '2026-11-28');
    expect(missing).toMatchObject({ status: 'fail', failStep: 'visual', screens: [{ name: 'wbs', status: 'same' }, { name: 'task', status: 'missing' }] });
  } finally { await f.close(); }
});

test('보고서 경로가 근거 폴더 밖이면 거부한다', async () => {
  const f = await ciFixture({ night: ['visual'] });
  try {
    const outside = png(1, 1, () => [1, 1, 1, 255]);
    await screens(f, { x: 'prototype/uiux/x.png' }, { 'prototype/uiux/x.png': outside });
    f.script(async ({ name }) => name !== 'visual' ? { code: 0 } : { code: 0, files: { '../outside.png': outside },
      report: { screens: [{ name: 'x', actual: '../outside.png' }] } });
    expect(await runNightCheck(options(f), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'visual', screens: [{ name: 'x', status: 'missing' }] });
  } finally { await f.close(); }
});

test('주요 API p95가 정의의 기준을 넘으면 실패하고 재시도하지 않는다', async () => {
  const f = await ciFixture({ night: ['perf'] });
  try {
    const stages = { ...f.pipeline.stages, night: [{ name: 'perf', argv: ['fake', 'night-perf'], budgetsMs: { 'GET /api/tasks': 300 } }] };
    await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify({ ...f.pipeline, stages }));
    commit(f.source); git(f.source, 'push', f.remote, 'main');
    f.script(async ({ name }) => name !== 'perf' ? { code: 0 } : { code: 0, report: { timings: [{ name: 'GET /api/tasks', samplesMs: [100, 900] }] } });
    const result = await runNightCheck(options(f), '2026-11-27');
    expect(result).toMatchObject({ status: 'fail', failStep: 'perf', timings: [{ name: 'GET /api/tasks', p95Ms: 900, over: true }] });
    expect(f.calls.filter(c => c.name === 'perf')).toHaveLength(1);
    expect(f.final().note).toContain('초과 1');
  } finally { await f.close(); }
});

test('실패하면 마지막 통과 이후 main 커밋을 원인 후보로 남긴다', async () => {
  const f = await ciFixture();
  try {
    f.script(async () => ({ code: 0 }));
    await runNightCheck(options(f), '2026-11-27');
    await file(join(f.source, 'bad'), 'x'); const bad = commit(f.source); git(f.source, 'push', f.remote, 'main');
    f.script(async ({ name }) => ({ code: name === 'e2e' ? 1 : 0 }));
    const result = await runNightCheck(options(f), '2026-11-28');
    expect(result).toMatchObject({ status: 'fail', suspects: [bad] });
    expect(f.final().note).toContain(bad.slice(0, 7));
    const third = await runNightCheck(options(f), '2026-11-29');
    expect(third.suspects).toEqual([bad]);
  } finally { await f.close(); }
});

test('로그·보고서는 저장소 밖 runs/<실행 ID>에 남기고 검사 사본은 지운다', async () => {
  const f = await ciFixture();
  try {
    f.script(async () => ({ code: 0, stdout: 'hello' }));
    const result = await runNightCheck(options(f), '2026-11-27');
    const dir = join(f.home, 'runs', result.runId);
    expect((await lstat(dir)).isDirectory()).toBe(true);
    expect(await readFile(join(dir, 'runner', 'e2e-1.log'), 'utf8')).toContain('hello');
    expect(await f.readJson(join(dir, 'runner', 'run.json'))).toMatchObject({ runId: result.runId, stage: 'night', finishedAt: new Date(NOW).toISOString() });
    expect(f.final().artifacts).toContain(`runs/${result.runId}/runner/e2e-1.log`);
    const cwd = f.calls[0]?.cwd ?? '';
    await expect(lstat(cwd)).rejects.toThrow();
    expect(await readdir(join(f.root, 'runner'))).not.toContain('node_modules');
  } finally { await f.close(); }
});

test('불안정 비율은 실행 사이에 이어서 센다', async () => {
  const f = await ciFixture();
  try {
    const flaky = (fail: boolean) => f.script(async ({ name, attempt }) => name !== 'e2e' ? { code: 0 }
      : fail && attempt % 2 === 1 ? { code: 1, report: { tests: [{ key: 'a', status: 'fail' }] } } : { code: 0, report: { tests: [{ key: 'a', status: 'pass' }] } });
    flaky(false); await runNightCheck(options(f), '2026-11-27');
    flaky(false); await runNightCheck(options(f), '2026-11-28');
    f.calls.length = 0;
    flaky(true); await runNightCheck(options(f), '2026-11-29');
    expect(f.final().flakyTests).toEqual([{ testKey: 'a', rate: 1 / 3, lastFailedAt: new Date(NOW).toISOString() }]);
  } finally { await f.close(); }
});

test('설치 단계는 재시도하지 않는다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name }) => ({ code: name === 'install' ? 1 : 0 }));
    expect(await runNightCheck(options(f, { retry: 3 }), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'runner:install' });
    expect(f.calls.map(c => c.name)).toEqual(['install']);
  } finally { await f.close(); }
});

test('로그 원문 파일에도 비밀값을 남기지 않는다', async () => {
  const f = await ciFixture();
  try {
    f.script(async () => ({ code: 0, stdout: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }));
    const result = await runNightCheck(options(f), '2026-11-27');
    const log = await readFile(join(f.home, 'runs', result.runId, 'runner', 'e2e-1.log'), 'utf8');
    expect(log).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  } finally { await f.close(); }
});

test('원인 후보는 main의 first-parent 커밋만 센다', async () => {
  const f = await ciFixture();
  try {
    const from = f.main;
    git(f.source, 'checkout', '-b', 'side', from);
    await file(join(f.source, 's1'), '1'); const side = commit(f.source);
    git(f.source, 'checkout', 'main');
    await file(join(f.source, 'm1'), '1'); const m1 = commit(f.source);
    git(f.source, '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'merge', '--no-ff', '-m', 'merge', 'side');
    const merge = git(f.source, 'rev-parse', 'HEAD'); git(f.source, 'push', f.remote, 'main');
    await f.repo.mainPipeline();
    const commits = await f.repo.mainCommitsSince(from, merge);
    expect(commits).toEqual([m1, merge]);
    expect(commits).not.toContain(side);
    expect(await f.repo.mainCommitsSince(side, m1)).toEqual([]);
  } finally { await f.close(); }
});

test('이미 시작한 날짜는 다시 돌리지 않는다(Runner 재시작·시계 역행)', async () => {
  const f = await ciFixture();
  try {
    expect(await dueNight(f.home, NOW, '02:00')).toBe('2026-11-27');
    f.script(async () => ({ code: 0 }));
    await runNightCheck(options(f), '2026-11-27');
    expect(await dueNight(f.home, NOW, '02:00')).toBeNull();
    expect(await dueNight(f.home, NOW - 2_300, '02:00')).toBeNull();
    expect(await dueNight(f.home, NOW + 86_400_000, '02:00')).toBe('2026-11-28');
  } finally { await f.close(); }
});
