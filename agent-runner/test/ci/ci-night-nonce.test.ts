// Codex 재리뷰(review2-codex.md) 지적 3: 보고서는 시도마다 새 경로와 일회용 값(nonce)을 쓰고, 옛 파일은 읽지 않는다.
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runNightCheck } from '../../src/ci/night/run.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { ciFixture } from './night-fixture.ts';
import { commit, file, git } from './int-fixture.ts';

type F = Awaited<ReturnType<typeof ciFixture>>;
const NOW = Date.parse('2026-11-27T09:00:00Z');
const RUN = '00000000-0000-4000-8000-000000000099';
const night = (f: F, report = f.report) => ({ repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report, home: f.home, quarantined: new Set<string>(), retry: 1, now: () => NOW });
async function budget(f: F) {
  await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify({ ...f.pipeline, stages: { ...f.pipeline.stages, night: [{ name: 'perf', argv: ['fake', 'night-perf'], budgetsMs: { x: 300 } }] } }));
  commit(f.source); git(f.source, 'push', f.remote, 'main');
}

test('중단 뒤 같은 실행 ID로 재개해도 예전 보고서를 이번 측정값으로 읽지 않는다', async () => {
  const f = await ciFixture({ night: ['perf'] });
  try {
    await budget(f);
    const stepDir = join(f.home, 'runs', RUN, 'step');
    await mkdir(stepDir, { recursive: true });
    await writeFile(join(stepDir, 'perf-1.report.json'), JSON.stringify({ timings: [{ name: 'x', samplesMs: [10] }] }));
    const report = { ...f.report, start: async () => ({ id: RUN, runKey: 'replayed' }) };
    f.script(async () => ({ code: 0 }));
    const out = await runNightCheck(night(f, report), '2026-11-27');
    expect(out).toMatchObject({ status: 'fail', failStep: 'perf' });
    expect(f.final().logExcerpt).toContain('기준이 있는 응답 시간 측정이 없습니다: x');
    // 옛 파일은 지우지 않는다(근거 보존). 이번 시도는 새 경로와 nonce만 읽으므로 옛 파일을 읽지 않는다.
    expect((await readdir(stepDir)).filter(n => n.endsWith('.report.json'))).toContain('perf-1.report.json');
  } finally { await f.close(); }
});

test('보고서에 이번 시도의 nonce가 없거나 다르면 읽지 않고 형식 오류로 실패한다', async () => {
  const f = await ciFixture({ night: ['perf'] });
  try {
    await budget(f);
    f.script(async ({ name }) => name !== 'perf' ? { code: 0 } : { code: 0, rawReport: { timings: [{ name: 'x', samplesMs: [10] }] } });
    expect(await runNightCheck(night(f), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'perf' });
    expect(f.final().logExcerpt).toContain('nonce');
    f.script(async ({ name }) => name !== 'perf' ? { code: 0 } : { code: 0, rawReport: { nonce: 'other', timings: [{ name: 'x', samplesMs: [10] }] } });
    expect(await runNightCheck(night(f), '2026-11-28')).toMatchObject({ status: 'fail', failStep: 'perf' });
    f.script(async ({ name }) => name !== 'perf' ? { code: 0 } : { code: 0, report: { timings: [{ name: 'x', samplesMs: [10] }] } });
    expect(await runNightCheck(night(f), '2026-11-29')).toMatchObject({ status: 'pass' });
  } finally { await f.close(); }
});

test('보고서 경로와 nonce는 시도마다 새로 주고, 앞 시도의 보고서를 다음 시도가 이어받지 않는다', async () => {
  const f = await ciFixture({ night: ['perf'] });
  try {
    await budget(f);
    f.script(async ({ name, attempt }) => name !== 'perf' ? { code: 0 } : attempt === 1
      ? { code: 1, report: { tests: [{ key: 'a', status: 'fail' }], timings: [{ name: 'x', samplesMs: [10] }] } }
      : { code: 0, report: { tests: [{ key: 'a', status: 'pass' }] } });
    const out = await runNightCheck(night(f), '2026-11-27');
    const envs = f.calls.filter(c => c.name === 'perf').map(c => c.env);
    expect(envs).toHaveLength(2);
    expect(envs[0]?.AWBS_REPORT).not.toBe(envs[1]?.AWBS_REPORT);
    expect(envs[0]?.AWBS_REPORT_NONCE).toMatch(/^[0-9a-f-]{36}$/);
    expect(envs[0]?.AWBS_REPORT_NONCE).not.toBe(envs[1]?.AWBS_REPORT_NONCE);
    // 두 번째 시도의 보고서에는 기준 측정이 없다. 첫 시도의 보고서를 이어받지 않는다.
    expect(out).toMatchObject({ status: 'fail', failStep: 'perf' });
    expect(f.final().logExcerpt).toContain('기준이 있는 응답 시간 측정이 없습니다: x');
  } finally { await f.close(); }
});

test('같은 실행 ID로 재개해도 같은 단계·시도의 보고서 경로를 다시 쓰지 않는다', async () => {
  const f = await ciFixture({ night: ['perf'] });
  try {
    const report = { ...f.report, start: async () => ({ id: RUN, runKey: 'replayed' }) };
    f.script(async () => ({ code: 0 }));
    await runNightCheck(night(f, report), '2026-11-27');
    await runNightCheck(night(f, report), '2026-11-28');
    const paths = f.calls.filter(c => c.name === 'perf').map(c => c.env.AWBS_REPORT);
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
  } finally { await f.close(); }
});

test('보고서 정리는 이름 앞부분이 겹치는 다른 단계(a-1과 a)의 보고서를 지우지 않는다', async () => {
  const f = await ciFixture({ night: ['a-1', 'a'] });
  try {
    f.script(async ({ name }) => name === 'install' ? { code: 0 } : { code: 0, report: { tests: [{ key: name, status: 'pass' }] } });
    const out = await runNightCheck(night(f), '2026-11-27');
    expect(out.status).toBe('pass');
    const first = f.calls.find(c => c.name === 'a-1')?.env.AWBS_REPORT ?? '';
    const stepDir = join(f.home, 'runs', out.runId, 'step');
    expect(await readdir(stepDir)).toContain(first.split('/').at(-1));
    // 보고한 근거 목록의 파일은 실제로 남아 있어야 한다.
    for (const artifact of f.final().artifacts ?? []) expect(existsSync(join(f.home, artifact)), artifact).toBe(true);
  } finally { await f.close(); }
});
