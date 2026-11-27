// Codex 리뷰(review-codex.md)의 배포 재현 시험을 올바른 동작 기준으로 뒤집은 회귀 시험이다.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { runDeployCheck } from '../../src/ci/deploy/run.ts';
import { ciFixture } from './night-fixture.ts';
import { png } from './png.ts';

const NOW = Date.parse('2026-11-27T09:00:00Z');
type F = Awaited<ReturnType<typeof ciFixture>>;
const up = (ok: () => boolean) => (async () => ok() ? new Response('ok') : new Response('down', { status: 502 })) as typeof fetch;
const deploy = (f: F, fetch: typeof globalThis.fetch = up(() => true)) => ({ repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report: f.report, home: f.home,
  job: { jobId: '00000000-0000-4000-8000-0000000000aa', fence: 7, commit: f.main }, url: 'http://127.0.0.1:28463', fetch, now: () => NOW,
  healthTimeoutMs: 20, healthIntervalMs: 1 });
const shot = png(2, 2, () => [1, 2, 3, 255]);

test('마지막 배포 명령이 커밋 파일을 바꾸면 실패한다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name, cwd }) => {
      if (name !== 'browser') return { code: 0 };
      await writeFile(join(cwd, 'shared'), 'changed after last pre-check');
      return { code: 0, files: { 'fake.png': shot }, report: { screenshots: ['fake.png'] } };
    });
    expect(await runDeployCheck(deploy(f))).toMatchObject({ status: 'fail', failStep: 'browser' });
  } finally { await f.close(); }
});

test('Runner가 붙이는 단계 이름은 사용자 단계 이름과 겹치지 않아 서버가 받을 수 있다', async () => {
  const f = await ciFixture({ deploy: ['url-check'] });
  try {
    f.script(async () => ({ code: 0, files: { 'fake.png': shot }, report: { screenshots: ['fake.png'] } }));
    expect(await runDeployCheck(deploy(f))).toMatchObject({ status: 'pass' });
    const steps = f.final().steps ?? [];
    expect(steps.map(s => s.name)).toEqual(['url-check', 'runner:url-check', 'runner:screenshots']);
  } finally { await f.close(); }
});

test('배포 실패 뒤 복구도 안 되면 「그대로」라고 보고하지 않고 서비스 없음을 적는다', async () => {
  const f = await ciFixture();
  try {
    let serviceRunning = false;
    const fetch = up(() => serviceRunning);
    f.script(async ({ name }) => {
      if (name === 'up') serviceRunning = true;
      return name === 'browser' ? { code: 0, files: { 'shot.png': shot }, report: { screenshots: ['shot.png'] } } : { code: 0 };
    });
    expect((await runDeployCheck(deploy(f, fetch))).status).toBe('pass');
    f.script(async ({ name }) => {
      if (name === 'up') { serviceRunning = false; return { code: 1, stderr: 'port is already allocated' }; }
      return { code: 0 };
    });
    const out = await runDeployCheck(deploy(f, fetch));
    expect(out.note).not.toContain('그대로');
    expect(out.note).toContain(`마지막 정상 커밋 ${f.main.slice(0, 7)} 복구 실패 — 서비스 없음`);
    expect(out.restore).toMatchObject({ commit: f.main, status: 'fail' });
  } finally { await f.close(); }
});

test('직전 통과 배포가 없는데 실패 뒤 서비스가 응답하면 응답했다는 사실만 적는다', async () => {
  const f = await ciFixture();
  try {
    f.script(async ({ name }) => ({ code: name === 'browser' ? 1 : 0 }));
    const out = await runDeployCheck(deploy(f));
    expect(out.note).toContain('복구할 직전 통과 배포가 없음 — 실패 뒤 /api/health 응답 200(응답한 서비스의 커밋은 확인하지 않음)');
    expect(out.restore).toBeUndefined();
  } finally { await f.close(); }
});

test('실제 Docker의 포트 충돌 문구를 포트 사용 중으로 인식한다', async () => {
  const f = await ciFixture();
  try {
    for (const stderr of [
      'Error response from daemon: ports are not available: exposing port TCP 127.0.0.1:28464 -> 127.0.0.1:0: /forwards/expose returned unexpected status: 500',
      'Error starting userland proxy: listen tcp4 127.0.0.1:28463: bind: address already in use',
      'driver failed programming external connectivity on endpoint x: Bind for 0.0.0.0:28463 failed: port is already allocated',
    ]) {
      f.script(async ({ name }) => ({ code: name === 'up' ? 1 : 0, stderr: name === 'up' ? stderr : '' }));
      const out = await runDeployCheck(deploy(f));
      expect(out).toMatchObject({ status: 'fail', failStep: 'up' });
      expect(out.note).toContain('포트 28463 사용 중');
    }
  } finally { await f.close(); }
});
