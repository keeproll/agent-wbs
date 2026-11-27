import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { runDeployCheck } from '../../src/ci/deploy/run.ts';
import { ciFixture } from './night-fixture.ts';
import { commit, definition, file, git } from './int-fixture.ts';
import { png } from './png.ts';

const NOW = Date.parse('2026-11-27T09:00:00Z');
const JOB = '00000000-0000-4000-8000-0000000000aa';
const shot = png(2, 2, () => [1, 2, 3, 255]);
type F = Awaited<ReturnType<typeof ciFixture>>;

function server(status: (url: string) => number | Error = () => 200) {
  const seen: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = String(input); seen.push(url);
    const value = status(url);
    if (value instanceof Error) throw value;
    return new Response('ok', { status: value });
  };
  return { seen, fetch: fetch as typeof globalThis.fetch };
}
const options = (f: F, extra: Partial<Parameters<typeof runDeployCheck>[0]> = {}) => ({
  repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report: f.report, home: f.home,
  job: { jobId: JOB, fence: 7, commit: f.main }, url: 'http://localhost:8080', fetch: server().fetch,
  now: () => NOW, healthTimeoutMs: 50, healthIntervalMs: 1, ...extra,
});
const browser = (f: F) => f.script(async ({ name }) => name === 'browser'
  ? { code: 0, files: { 'shots/login.png': shot, 'shots/wbs.png': shot }, report: { screenshots: ['shots/login.png', 'shots/wbs.png'] } }
  : { code: 0 });

test('job의 fence로 시작·보고하고 운영 빌드→기동→접속 확인→스크린샷을 근거로 통과한다', async () => {
  const f = await ciFixture();
  try {
    browser(f);
    const http = server();
    const result = await runDeployCheck(options(f, { fetch: http.fetch }));
    expect(f.reports[0]).toMatchObject({ kind: 'start', body: { jobId: JOB, fence: 7, stage: 'deploy', ref: 'main', trigger: '팀장 요청', headSha: f.main, pipelineSha: result.pipelineSha } });
    expect(f.reports.slice(1).every(r => (r.body as { fence: unknown }).fence === 7)).toBe(true);
    expect(result).toMatchObject({ status: 'pass', url: 'http://localhost:8080' });
    expect(f.final()).toMatchObject({ status: 'pass', url: 'http://localhost:8080', finishedAt: new Date(NOW).toISOString() });
    expect(f.final().steps?.map(s => [s.name, s.status])).toEqual([['image', 'pass'], ['up', 'pass'], ['browser', 'pass'], ['runner:url-check', 'pass'], ['runner:screenshots', 'pass']]);
    expect(f.final().artifacts).toEqual(expect.arrayContaining([`runs/${result.runId}/step/shots/login.png`, `runs/${result.runId}/step/shots/wbs.png`]));
    expect(f.final().note).toContain('스크린샷 2장');
    expect(http.seen).toEqual(expect.arrayContaining(['http://localhost:8080/api/health', 'http://localhost:8080/']));
    const env = f.calls.find(c => c.name === 'image')?.env;
    expect(env).toMatchObject({ AWBS_DEPLOY_COMMIT: f.main, AWBS_DEPLOY_TAG: `agentwbs-deploy:${f.main.slice(0, 12)}`, AWBS_DEPLOY_URL: 'http://localhost:8080', COMPOSE_PROJECT_NAME: 'agentwbs-deploy' });
    expect(f.calls.every(c => c.cwd !== f.source)).toBe(true);
    await expect(lstat(f.calls[0]?.cwd ?? '')).rejects.toThrow();
  } finally { await f.close(); }
});

test('배포할 커밋의 정의를 쓴다(다시 빌드해도 같은 결과)', async () => {
  const f = await ciFixture();
  try {
    browser(f);
    const target = f.main;
    await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify({ ...definition, stages: { ...definition.stages, deploy: [{ name: 'other', argv: ['fake', 'deploy-other'] }] } }));
    commit(f.source); git(f.source, 'push', f.remote, 'main');
    const result = await runDeployCheck(options(f, { job: { jobId: JOB, fence: 7, commit: target } }));
    expect(f.calls.map(c => c.name)).toEqual(['image', 'up', 'browser']);
    expect(result.status).toBe('pass');
  } finally { await f.close(); }
});

test('health check가 응답하지 않으면 실패하고, 기다림은 정한 시간 안에서 다시 확인한다', async () => {
  const f = await ciFixture();
  try {
    browser(f);
    let calls = 0;
    const http = server(url => url.endsWith('/api/health') && ++calls < 3 ? new Error('ECONNREFUSED') : 200);
    expect((await runDeployCheck(options(f, { fetch: http.fetch, healthTimeoutMs: 5_000 }))).status).toBe('pass');
    expect(calls).toBe(3);
    const down = server(() => 503);
    const result = await runDeployCheck(options(f, { fetch: down.fetch }));
    expect(result).toMatchObject({ status: 'fail', failStep: 'runner:url-check' });
    expect(f.final().logExcerpt).toContain('503');
  } finally { await f.close(); }
});

test('포트 충돌로 실패하면 원인을 적고 직전 통과 이미지를 남긴다', async () => {
  const f = await ciFixture();
  try {
    browser(f);
    await runDeployCheck(options(f));
    f.script(async ({ name }) => name === 'up' ? { code: 1, stderr: 'Error: listen EADDRINUSE: address already in use :::8080' } : { code: 0 });
    const result = await runDeployCheck(options(f));
    expect(result).toMatchObject({ status: 'fail', failStep: 'up' });
    expect(f.final().note).toContain('포트 8080 사용 중');
    expect(f.final().note).toContain(`직전 통과 커밋 ${f.main.slice(0, 7)}의 이미지는 남겨 둠`);
    expect(f.calls.some(c => c.name === 'browser' && c.attempt === 2)).toBe(false);
  } finally { await f.close(); }
});

test('브라우저 접속 스크린샷이 없거나 PNG가 아니면 배포 확인이 아니다', async () => {
  const f = await ciFixture();
  try {
    f.script(async () => ({ code: 0 }));
    expect(await runDeployCheck(options(f))).toMatchObject({ status: 'fail', failStep: 'runner:screenshots' });
    f.script(async ({ name }) => name === 'browser' ? { code: 0, files: { 'x.png': 'text' }, report: { screenshots: ['x.png'] } } : { code: 0 });
    expect(await runDeployCheck(options(f))).toMatchObject({ status: 'fail', failStep: 'runner:screenshots' });
  } finally { await f.close(); }
});

test('Q-15 결정 전에는 이 PC(loopback) 대상만 확인한다', async () => {
  const f = await ciFixture();
  try {
    browser(f);
    const http = server();
    const result = await runDeployCheck(options(f, { url: 'https://deploy.example.com', fetch: http.fetch }));
    expect(result).toMatchObject({ status: 'fail', failStep: 'runner:target' });
    expect(f.calls).toHaveLength(0);
    expect(http.seen).toHaveLength(0);
    expect(f.final().note).toContain('Q-15');
    expect((await runDeployCheck(options(f, { url: null }))).failStep).toBe('runner:target');
  } finally { await f.close(); }
});

test('로컬 Docker 이미지는 다음 배포 확인까지만 남기고, 실패하면 직전 통과 이미지를 지우지 않는다', async () => {
  const f = await ciFixture();
  try {
    const removed: string[] = [];
    const execute: typeof f.execute = async (argv, cwd, signal, env) => {
      if (argv[0] === 'docker') { removed.push(String(argv.at(-1))); return { code: 0, stdout: '', stderr: '' }; }
      return f.execute(argv, cwd, signal, env);
    };
    const tag = (sha: string) => `agentwbs-deploy:${sha.slice(0, 12)}`;
    browser(f);
    await runDeployCheck(options(f, { execute }));
    const first = f.main;
    await file(join(f.source, 'next'), '1'); const second = commit(f.source); git(f.source, 'push', f.remote, 'main');
    f.script(async ({ name }) => ({ code: name === 'up' ? 1 : 0 }));
    await runDeployCheck(options(f, { execute, job: { jobId: JOB, fence: 7, commit: second } }));
    expect(removed).toEqual([]);
    await file(join(f.source, 'third'), '1'); const third = commit(f.source); git(f.source, 'push', f.remote, 'main');
    browser(f);
    await runDeployCheck(options(f, { execute, job: { jobId: JOB, fence: 7, commit: third } }));
    expect(removed.sort()).toEqual([tag(first), tag(second)].sort());
    const state = JSON.parse(await readFile(join(f.home, 'ci', 'deploy', 'state.json'), 'utf8')) as unknown;
    expect(state).toMatchObject({ lastPass: { commit: third, tag: tag(third) }, images: [tag(third)] });
  } finally { await f.close(); }
});

test('main에 들어가지 않은 커밋은 배포 확인하지 않는다', async () => {
  const f = await ciFixture();
  try {
    browser(f);
    await f.repo.fetchBranch('agent/task');
    await expect(runDeployCheck(options(f, { job: { jobId: JOB, fence: 7, commit: f.head } }))).rejects.toThrow('main에 없습니다');
    expect(f.reports).toHaveLength(0);
  } finally { await f.close(); }
});
