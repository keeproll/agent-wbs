// Codex 재리뷰(review2-codex.md) 지적 1: 배포·복구는 환경별로 한 번에 하나, 복구는 자기보다 새 배포가 없을 때만.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runDeployCheck } from '../../src/ci/deploy/run.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { ciFixture } from './night-fixture.ts';
import { commit, file, git } from './int-fixture.ts';
import { png } from './png.ts';

type F = Awaited<ReturnType<typeof ciFixture>>;
const NOW = Date.parse('2026-11-27T09:00:00Z');
const shot = png(2, 2, () => [1, 2, 3, 255]);
const deploy = (f: F, heavy: HeavySemaphore, sha: string, fetch: typeof globalThis.fetch) => ({ repo: f.repo, heavy, execute: f.execute, report: f.report, home: f.home,
  job: { jobId: '00000000-0000-4000-8000-0000000000aa', fence: 7, commit: sha }, url: 'http://127.0.0.1:28463', fetch, now: () => NOW, healthTimeoutMs: 20, healthIntervalMs: 1 });
async function advance(f: F, name: string) { await file(join(f.source, name), name); const sha = commit(f.source); git(f.source, 'push', f.remote, 'main'); return sha; }

test('실패한 배포의 복구는 대기 중인 더 새 배포보다 먼저 끝나 새 정상 배포를 되돌리지 않는다', async () => {
  const f = await ciFixture();
  try {
    const heavy = new HeavySemaphore(1);
    let running: string | null = null;
    let failed = '';
    let firstUp!: () => void;
    const bStarted = new Promise<void>(resolve => { firstUp = resolve; });
    let finishB!: () => void;
    const bCanFinish = new Promise<void>(resolve => { finishB = resolve; });
    const events: string[] = [];
    let a = '', c = '';
    f.script(async ({ name, env }) => {
      const sha = env.AWBS_DEPLOY_COMMIT ?? '';
      if (name === 'up') {
        if (sha === failed) { running = null; firstUp(); await bCanFinish; events.push('B failed'); return { code: 1 }; }
        running = sha; events.push(sha === a ? 'A up' : sha === c ? 'C up' : 'other up');
      }
      return name === 'browser' ? { code: 0, files: { 'shot.png': shot }, report: { screenshots: ['shot.png'] } } : { code: 0 };
    });
    const fetch = (async () => new Response(running ? 'ok' : 'down', { status: running ? 200 : 502 })) as typeof globalThis.fetch;
    a = f.main;
    await runDeployCheck(deploy(f, heavy, a, fetch));
    const b = await advance(f, 'b');
    c = await advance(f, 'c');
    failed = b;
    const bRun = runDeployCheck(deploy(f, heavy, b, fetch));
    await bStarted;
    const cRun = runDeployCheck(deploy(f, heavy, c, fetch));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events).toEqual(['A up']);
    finishB();
    const [bOut, cOut] = await Promise.all([bRun, cRun]);
    expect(events).toEqual(['A up', 'B failed', 'A up', 'C up']);
    expect(bOut.restore).toMatchObject({ commit: a, status: 'pass' });
    expect(cOut.status).toBe('pass');
    expect(running).toBe(c);
    expect(JSON.parse(await readFile(join(f.home, 'ci', 'deploy', 'state.json'), 'utf8'))).toMatchObject({ seq: 3, lastPass: { commit: c } });
  } finally { await f.close(); }
});

test('배포 순번은 단조 증가하고, 실행 중 더 새 배포 순번이 기록되면 복구하지 않는다', async () => {
  const f = await ciFixture();
  try {
    const heavy = new HeavySemaphore(1);
    let running: string | null = null;
    const statePath = join(f.home, 'ci', 'deploy', 'state.json');
    let bump = false;
    f.script(async ({ name, env }) => {
      if (name === 'up') {
        if (bump) {
          // 다른 Runner가 같은 환경에 더 새 배포를 시작한 상황(협조적 검사)을 흉내 낸다.
          const state = JSON.parse(await readFile(statePath, 'utf8')) as { seq: number };
          await writeFile(statePath, JSON.stringify({ ...state, seq: state.seq + 1 }));
          running = null; return { code: 1 };
        }
        running = env.AWBS_DEPLOY_COMMIT ?? null;
      }
      return name === 'browser' ? { code: 0, files: { 'shot.png': shot }, report: { screenshots: ['shot.png'] } } : { code: 0 };
    });
    const fetch = (async () => new Response(running ? 'ok' : 'down', { status: running ? 200 : 502 })) as typeof globalThis.fetch;
    await runDeployCheck(deploy(f, heavy, f.main, fetch));
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ seq: 1 });
    const b = await advance(f, 'b');
    bump = true;
    const out = await runDeployCheck(deploy(f, heavy, b, fetch));
    expect(out.restore).toBeUndefined();
    expect(out.note).toContain('더 새 배포가 시작되어 복구하지 않음');
    expect(f.final()).not.toHaveProperty('deployRestore');
    expect(f.calls.filter(c => c.name === 'up')).toHaveLength(2);
    // 더 새 배포가 맡은 상태를 옛 실행이 덮어쓰지 않는다.
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ seq: 3, lastPass: { commit: f.main } });
  } finally { await f.close(); }
});
