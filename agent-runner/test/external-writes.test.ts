// M5·M7 통합 조정자 판단: Runner의 모든 외부 쓰기는 같은 관문 하나를 지난다.
// 관문 = 소유 확인(중단·서버 임대) → M4 쓰기 관문(beforeWrite: 원격 저장소 확인 → 배포 키 검사).
// 이 파일은 외부 쓰기 목록(src/github/write-gate.ts)을 한 곳에서 소스와 대조한다.
// 새 외부 쓰기 함수나 새 호출 위치가 생기면 여기서 실패한다. 관문을 붙이고 목록에 이유와 함께 등록해야 통과한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createGitHubClient } from '../src/github/client.ts';
import { GIT_WRITES, ownedGitHub, pushGate, REST_WRITES, WRITE_CALLERS } from '../src/github/write-gate.ts';
import { IntegrationQueue } from '../src/ci/integration/queue.ts';
import { Secret } from '../src/security/secret.ts';
import { fixture } from './ci/int-fixture.ts';
import { startFakeGitHub, type FakeGitHub } from './fakes/github/server.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((name) => {
  const path = join(dir, name);
  return statSync(join(ROOT, path)).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
});
/** offset을 감싼 메서드 이름과 그 메서드 본문(이름부터 offset까지). */
function enclosing(source: string, offset: number): { name: string; body: string } {
  const before = source.slice(0, offset);
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await']);
  const matches = [...before.matchAll(/\n\s{2,4}(?:async\s+)?([A-Za-z]\w*)\s*\([^)]*\)[^{\n]*\{/g)].filter((m) => !keywords.has(m[1] as string));
  const last = matches.at(-1);
  if (!last) throw new Error('감싼 메서드를 찾지 못했습니다.');
  return { name: last[1] as string, body: source.slice(last.index, offset) };
}

test('GitHub REST 쓰기(POST·PUT·PATCH·DELETE)는 목록의 메서드 안에만 있고, 각 메서드는 요청 전에 beforeWrite를 부른다', () => {
  const source = read('src/github/client.ts');
  const sites = [...source.matchAll(/\bcall\('(POST|PUT|PATCH|DELETE)'/g)].map((m) => enclosing(source, m.index));
  expect(new Set(sites.map((s) => s.name))).toEqual(new Set(REST_WRITES));
  for (const site of sites) expect(site.body, site.name).toMatch(/await beforeWrite\(/);
  // 각 쓰기 요청은 작업 문맥(write: 소유 확인·중단 신호)을 call에 넘긴다. call은 전송 바로 앞에서 소유를 확인한다.
  const writeCalls = [...source.matchAll(/\bcall\('(?:POST|PUT|PATCH|DELETE)'[^;]*;/g)].map((m) => m[0]);
  expect(writeCalls).toHaveLength(REST_WRITES.length);
  for (const line of writeCalls) expect(line).toMatch(/\bwrite\b/);
  const body = source.slice(source.indexOf('const call = async'), source.indexOf('const ok = async'));
  expect(body.indexOf('await init.write.guard()')).toBeGreaterThan(body.indexOf('await token()'));
  // 소유 확인과 전송 사이에 다른 await가 없다.
  const between = body.slice(body.indexOf('await init.write.guard()') + 'await init.write.guard()'.length, body.indexOf('await send('));
  expect(between).not.toMatch(/\bawait\b/);
});

test('Git push는 목록의 메서드 안에만 있고, 각 메서드는 push 전에 필수 관문(gate)을 부른다', () => {
  const source = read('src/git/repository.ts');
  const sites = [...source.matchAll(/\['push'/g)].map((m) => enclosing(source, m.index));
  expect(new Set(sites.map((s) => s.name))).toEqual(new Set(GIT_WRITES));
  for (const site of sites) {
    expect(site.body, site.name).toMatch(/gate: PushGate/);
    expect(site.body, site.name).toMatch(/await gate\(/);
  }
  // 다른 파일에서 git push를 직접 실행하지 않는다.
  for (const path of files('src').filter((p) => p !== 'src/git/repository.ts')) expect(read(path), path).not.toMatch(/['"]push['"]\s*,/);
});

test('외부 쓰기 함수를 부르는 제품 파일은 등록된 곳뿐이다(소유 확인 방식과 함께 등록)', () => {
  const names = [...REST_WRITES, ...GIT_WRITES].join('|');
  const pattern = new RegExp(`\\.(?:${names})\\(`);
  const definitions = new Set(['src/github/client.ts', 'src/git/repository.ts', 'src/github/write-gate.ts']);
  const callers = files('src').filter((path) => !definitions.has(path) && pattern.test(read(path))).map((path) => relative('.', path));
  expect(new Set(callers)).toEqual(new Set(Object.keys(WRITE_CALLERS)));
});

// ---- 동작: 관문이 거부하면 실제로 아무것도 쓰지 않는다 ----

let fake: FakeGitHub;
let writes: string[];
beforeEach(async () => {
  fake = await startFakeGitHub('FAKE'); writes = [];
  const record = (key: string) => () => { writes.push(key); return { status: 500, body: { message: '쓰면 안 됨' } }; };
  fake.on('POST /repos/o/r/pulls', record('pull_create'));
  fake.on('GET /repos/o/r/pulls', () => ({ body: [] }));
  fake.on('PATCH /repos/o/r/pulls/:n', record('pull_close'));
  fake.on('DELETE /repos/o/r/git/refs/heads/:branch', record('branch_delete'));
  fake.on('POST /repos/o/r/statuses/:sha', record('status'));
  fake.on('PUT /repos/o/r/pulls/:n/merge', record('merge'));
});
afterEach(async () => { await fake.close(); });

test('소유 확인이 거부하면 REST 쓰기 다섯 가지 모두 GitHub에 요청하지 않는다', async () => {
  let gate = 0;
  const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: async () => new Secret('FAKE'), baseUrl: fake.url, timeoutMs: 2_000,
    beforeWrite: async () => { gate++; } });
  const owned = ownedGitHub(client, async () => { throw new Error('임대 상실'); });
  const sha = 'a'.repeat(40);
  const calls: Record<(typeof REST_WRITES)[number], () => Promise<unknown>> = {
    ensurePullRequest: () => owned.ensurePullRequest({ branch: 'agent/TASK-0001-h1', title: 't', body: 'b' }),
    closePullRequest: () => owned.closePullRequest(1),
    deleteBranch: () => owned.deleteBranch('agent/TASK-0001-h1'),
    setCommitStatus: () => owned.setCommitStatus({ sha, context: 'agentwbs/int', state: 'pending' }),
    mergePullRequest: () => owned.mergePullRequest({ pr: 1, baseSha: sha, headSha: 'b'.repeat(40) }),
  };
  for (const [name, call] of Object.entries(calls)) await expect(call(), name).rejects.toThrow('임대 상실');
  expect(writes).toEqual([]);
  // M4 검사는 쓰기가 아니다. 소유 확인은 그 뒤, 전송 바로 앞에서 한다(마지막 확인 → 즉시 전송).
  expect(gate).toBe(5);
});

test('push 관문은 소유 확인 → M4 관문 → 소유 확인 순서이고, 앞 단계가 거부하면 뒤 단계를 부르지 않는다', async () => {
  const order: string[] = [];
  let ownedOk = true;
  const gate = pushGate({ assertWritable: async () => { order.push('m4'); } }, async () => { order.push('owner'); if (!ownedOk) throw new Error('중단'); });
  await gate({ kind: 'branch_push', branch: 'agent/x', remote: 'https://github.com/o/r' });
  expect(order).toEqual(['owner', 'm4', 'owner']);
  order.length = 0; ownedOk = false;
  await expect(gate({ kind: 'branch_push', branch: 'agent/x', remote: 'https://github.com/o/r' })).rejects.toThrow('중단');
  expect(order).toEqual(['owner']);
});

test('M7-02 통합 대기열: 소유 확인이 거부하면 H′ push·상태 기록·병합을 하지 않는다', async () => {
  const f = await fixture();
  try {
    await f.advance();
    const queue = await IntegrationQueue.open({ ...f.deps, guard: async () => { throw new Error('임대 상실'); } });
    try {
      const before = f.ref(f.request.branch);
      await expect(queue.run(f.request)).rejects.toThrow('임대 상실');
      expect(f.ref(f.request.branch)).toBe(before);
      expect([...f.statuses.keys()]).toEqual([]);
      expect(f.merged.size).toBe(0);
    } finally { await queue.close(); }
  } finally { await f.close(); }
});

test('M7-02 통합 대기열: H′ push도 M4 관문(배포 키)을 먼저 지나며, 거부하면 원격이 바뀌지 않는다', async () => {
  const f = await fixture();
  try {
    await f.advance();
    const seen: string[] = [];
    f.beforeWrite((operation) => { seen.push(operation.kind); if (operation.kind === 'branch_push') throw new Error('배포 키 거부'); });
    const queue = await IntegrationQueue.open(f.deps);
    try {
      const before = f.ref(f.request.branch);
      await expect(queue.run(f.request)).rejects.toThrow('배포 키 거부');
      expect(seen).toEqual(['branch_push']);
      expect(f.ref(f.request.branch)).toBe(before);
      expect(f.merged.size).toBe(0);
    } finally { await queue.close(); }
  } finally { await f.close(); }
});
