// 조정자 결정 7: 배포 확인이 실패하면 마지막으로 통과한 커밋을 다시 기동하고 접속 확인한 결과를 보고한다.
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { runDeployCheck } from '../../src/ci/deploy/run.ts';
import { commit, definition, file, git } from './int-fixture.ts';
import { ciFixture } from './night-fixture.ts';
import { png } from './png.ts';

const NOW = Date.parse('2026-11-27T09:00:00Z');
type F = Awaited<ReturnType<typeof ciFixture>>;
const shot = png(2, 2, () => [1, 2, 3, 255]);
const JOB = '00000000-0000-4000-8000-0000000000aa';

/** 가짜 compose: up이 성공하면 그 커밋의 서비스가 돈다. 실패하면 기존 서비스도 내려간다(실제 compose 교체 동작). */
function world(f: F) {
  const state = { running: null as string | null, failUp: new Set<string>(), healthDown: false };
  f.script(async ({ name, env }) => {
    const commit = env.AWBS_DEPLOY_COMMIT ?? '';
    if (name === 'up') {
      if (state.failUp.has(commit)) { state.running = null; return { code: 1, stderr: 'port is already allocated' }; }
      state.running = commit;
    }
    return name === 'browser' ? { code: 0, files: { 'shot.png': shot }, report: { screenshots: ['shot.png'] } } : { code: 0 };
  });
  const fetch = (async () => state.running && !state.healthDown ? new Response('ok') : new Response('down', { status: 502 })) as typeof globalThis.fetch;
  return { state, fetch };
}
const deploy = (f: F, fetch: typeof globalThis.fetch, commit: string) => ({ repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report: f.report, home: f.home,
  job: { jobId: JOB, fence: 7, commit }, url: 'http://127.0.0.1:28463', fetch, now: () => NOW, healthTimeoutMs: 20, healthIntervalMs: 1 });
async function advance(f: F, name: string) { await file(join(f.source, name), name); const sha = commit(f.source); git(f.source, 'push', f.remote, 'main'); return sha; }

test('새 배포가 실패하면 직전 통과 커밋을 다시 기동하고 접속 확인이 통과했다고 보고한다', async () => {
  const f = await ciFixture();
  try {
    const w = world(f);
    const a = f.main;
    expect((await runDeployCheck(deploy(f, w.fetch, a))).status).toBe('pass');
    const b = await advance(f, 'b');
    w.state.failUp.add(b);
    const out = await runDeployCheck(deploy(f, w.fetch, b));
    expect(out).toMatchObject({ status: 'fail', failStep: 'up', restore: { commit: a, status: 'pass' } });
    expect(w.state.running).toBe(a);
    const restoreUp = f.calls.filter(c => c.name === 'up').at(-1);
    expect(restoreUp?.env).toMatchObject({ AWBS_DEPLOY_COMMIT: a, AWBS_DEPLOY_TAG: `agentwbs-deploy:${a.slice(0, 12)}` });
    expect(f.final().steps?.map(s => [s.name, s.status])).toEqual([['image', 'pass'], ['up', 'fail'], ['browser', 'skip'], ['runner:url-check', 'skip'], ['runner:screenshots', 'skip'], ['runner:restore', 'pass']]);
    expect(f.final().note).toContain(`마지막 정상 커밋 ${a.slice(0, 7)}을 다시 기동해 접속 확인 통과`);
    expect(f.final().status).toBe('fail');
  } finally { await f.close(); }
});

test('복구할 때는 직전 통과 커밋 자신의 정의로 다시 기동한다', async () => {
  const f = await ciFixture();
  try {
    const w = world(f);
    const a = f.main;
    await runDeployCheck(deploy(f, w.fetch, a));
    await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify({ ...f.pipeline, stages: { ...f.pipeline.stages, deploy: [{ name: 'up', argv: ['fake', 'deploy-up'] }, { name: 'other', argv: ['fake', 'deploy-other'] }] } }));
    const b = commit(f.source); git(f.source, 'push', f.remote, 'main');
    w.state.failUp.add(b);
    f.calls.length = 0;
    await runDeployCheck(deploy(f, w.fetch, b));
    expect(f.calls.map(c => `${c.name}:${(c.env.AWBS_DEPLOY_COMMIT ?? '').slice(0, 7)}`)).toEqual([`up:${b.slice(0, 7)}`, `image:${a.slice(0, 7)}`, `up:${a.slice(0, 7)}`, `browser:${a.slice(0, 7)}`]);
    expect(definition).toBeDefined();
  } finally { await f.close(); }
});

test('복구도 실패하면 「서비스 없음」을 사실대로 보고한다', async () => {
  const f = await ciFixture();
  try {
    const w = world(f);
    const a = f.main;
    await runDeployCheck(deploy(f, w.fetch, a));
    const b = await advance(f, 'b');
    w.state.failUp.add(b); w.state.failUp.add(a);
    const out = await runDeployCheck(deploy(f, w.fetch, b));
    expect(out).toMatchObject({ status: 'fail', failStep: 'up', restore: { commit: a, status: 'fail' } });
    expect(f.final().steps?.at(-1)).toMatchObject({ name: 'runner:restore', status: 'fail' });
    expect(f.final().note).toContain('복구 실패 — 서비스 없음');
    expect(f.final().note).not.toContain('통과');
  } finally { await f.close(); }
});

test('복구 단계는 통과했지만 접속 확인이 안 되면 복구 실패다', async () => {
  const f = await ciFixture();
  try {
    const w = world(f);
    const a = f.main;
    await runDeployCheck(deploy(f, w.fetch, a));
    const b = await advance(f, 'b');
    f.script(async ({ name }) => { if (name === 'browser') w.state.healthDown = true; return { code: 0 }; });
    const out = await runDeployCheck(deploy(f, w.fetch, b));
    expect(out).toMatchObject({ status: 'fail', failStep: 'runner:url-check', restore: { commit: a, status: 'fail' } });
    expect(f.final().note).toContain('복구 실패 — 서비스 없음');
  } finally { await f.close(); }
});

test('직전 통과 배포가 없으면 복구하지 않고 그 사실과 실제 접속 결과를 적는다', async () => {
  const f = await ciFixture();
  try {
    const w = world(f);
    w.state.failUp.add(f.main);
    const out = await runDeployCheck(deploy(f, w.fetch, f.main));
    expect(out.restore).toBeUndefined();
    expect(f.final().steps?.map(s => s.name)).not.toContain('runner:restore');
    expect(f.final().note).toContain('복구할 직전 통과 배포가 없음 — 서비스 없음');
  } finally { await f.close(); }
});

test('대상 확인(runner:target)에서 멈춘 실패는 아무것도 바꾸지 않았으므로 복구하지 않는다', async () => {
  const f = await ciFixture();
  try {
    const w = world(f);
    await runDeployCheck(deploy(f, w.fetch, f.main));
    f.calls.length = 0;
    const out = await runDeployCheck({ ...deploy(f, w.fetch, f.main), url: 'https://example.com' });
    expect(out).toMatchObject({ failStep: 'runner:target' });
    expect(out.restore).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test('복구 단계 하나라도 실패하면 서비스가 응답해도 복구 실패다', async () => {
  const f = await ciFixture();
  try {
    const w = world(f);
    const a = f.main;
    await runDeployCheck(deploy(f, w.fetch, a));
    const b = await advance(f, 'b');
    f.script(async ({ name, env }) => {
      if (name === 'up') { w.state.running = env.AWBS_DEPLOY_COMMIT ?? null; return { code: env.AWBS_DEPLOY_COMMIT === b ? 1 : 0 }; }
      return { code: name === 'browser' ? 1 : 0 };
    });
    const out = await runDeployCheck(deploy(f, w.fetch, b));
    expect(w.state.running).toBe(a);
    expect(out.restore).toMatchObject({ commit: a, status: 'fail', detail: 'browser 실패' });
  } finally { await f.close(); }
});
