// M8 전 연결: 사용자 cgroup scope 감싸기·launch 기록. 실제 scope는 test/exec/dedicated-scope.host.ts가 본다.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Launches } from '../../src/exec/launches.ts';
import { runProcess } from '../../src/exec/process.ts';
import { clearScope, inUserScope, newScopeUnit, scopeCgroup, scopeCgroupPath, scopeEmpty, validScopeUnit, withUserScope } from '../../src/exec/scope.ts';
import { PENDING_ISOLATION } from '../../src/cli/isolation.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const home = async () => { const p = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'scope-')); roots.push(p); return p; };
const uid = String(process.getuid?.());

test('scope 이름은 awbs-<uuid>만 받고, cgroup 위치는 사용자 systemd의 app.slice 아래로 정해져 있다', () => {
  const unit = newScopeUnit();
  expect(validScopeUnit(unit)).toBe(true);
  for (const bad of ['awbs-x', 'other-0b6f3c2e-6a1d-4f7e-8a9b-0123456789ab', 'awbs-../../x', '', 1, null]) expect(validScopeUnit(bad)).toBe(false);
  expect(scopeCgroup(unit)).toBe(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}.scope`);
  expect(() => scopeCgroup('awbs-../../../etc')).toThrow();
  expect(() => inUserScope({ file: '/bin/true', args: [], env: {}, cwd: '/', stdin: '' }, 'bad')).toThrow();
});

test('withUserScope: 안쪽 계층이 거부하면 scope로 감싸지 않고 그 거부를 그대로 올린다', () => {
  const layer = withUserScope(PENDING_ISOLATION);
  expect(layer.flags('Codex')).toEqual([]);
  expect(() => layer.wrap({ file: '/bin/true', args: [], env: {}, cwd: '/', stdin: '' }, 'Codex')).toThrow(expect.objectContaining({ code: 'isolation_undecided' }));
});

test('없는 scope(이미 비어 systemd가 지움)는 비었다고 본다. 이름이 틀린 scope는 다루지 않는다', async () => {
  const unit = newScopeUnit();
  expect(await scopeEmpty(unit)).toBe(true);
  expect(await clearScope(unit)).toBe(true);
  await expect(clearScope('awbs-not-a-uuid')).rejects.toThrow();
});

test('launch 기록은 프로세스를 띄우기 전에 scope 이름을 남기고, 손상된 scope 기록은 거부한다', async () => {
  const dir = await home();
  const launches = new Launches(dir, { hostId: 'host', bootId: 'boot' });
  const unit = newScopeUnit();
  const record = await launches.create({ id: 'job', fence: 1, epoch: 0 }, { scope: unit });
  expect((await launches.list()).find(r => r.launchId === record.launchId)?.scope).toBe(unit);
  await expect(launches.create({ id: 'job', fence: 1, epoch: 0 }, { scope: 'awbs-../x' })).rejects.toThrow();
  const file = join(launches.directory, `${record.launchId}.json`);
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')) as object, scope: '../../etc' }));
  await expect(launches.list()).rejects.toThrow('scope');
});

test('runProcess는 launch.scope·cgroup을 기록하고, scope가 비었으면 cgroup_empty 증거로 끝낸다(조정자 결정 3)', async () => {
  const dir = await home();
  const launches = new Launches(dir, { hostId: 'host', bootId: 'boot' });
  const unit = newScopeUnit();
  // 실제 systemd-run 없이: scope 이름만 붙인 실행 계획. scope 폴더가 없으므로 「이미 비었음」이다.
  const result = await runProcess({ launches, job: { id: 'job', fence: 1, epoch: 0 }, launch: { file: '/bin/sh', args: ['-c', 'exit 0'], env: {}, cwd: dir, stdin: '', scope: unit }, register: async () => undefined, graceMs: 100 });
  expect(result.code).toBe(0);
  expect(result.proof).toMatchObject({ kind: 'cgroup_empty', cgroup: scopeCgroupPath(unit) });
  const [name] = await readdir(launches.directory);
  const saved = JSON.parse(await readFile(join(launches.directory, name ?? ''), 'utf8')) as { scope?: string; cgroup?: string };
  expect(saved).toMatchObject({ scope: unit, cgroup: scopeCgroupPath(unit) });
  expect(saved.cgroup).toBe(`/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}.scope`);
});

test('서버 보유의 cgroup과 launch 기록을 대조해 증거를 고른다: 같으면 cgroup_empty, 다르면 증거 없음, scope 없는 기록은 group_empty', async () => {
  const dir = await home();
  const launches = new Launches(dir, { hostId: 'host', bootId: 'boot' });
  const unit = newScopeUnit();
  const scoped = await runProcess({ launches, job: { id: 'scoped', fence: 1, epoch: 0 }, launch: { file: '/bin/sh', args: ['-c', 'exit 0'], env: {}, cwd: dir, stdin: '', scope: unit }, register: async () => undefined, graceMs: 100 });
  const pgid = scoped.proof.kind === 'cgroup_empty' ? scoped.proof.processGroup : 0;
  const hold = { job: 'scoped', hostId: 'host', bootId: 'boot', processGroup: pgid };
  expect(await launches.reconcile({ ...hold, cgroup: scopeCgroupPath(unit) }, 100)).toMatchObject({ kind: 'cgroup_empty', processGroup: pgid, cgroup: scopeCgroupPath(unit) });
  expect(await launches.reconcile({ ...hold, cgroup: null }, 100)).toBeNull();
  expect(await launches.reconcile({ ...hold, cgroup: scopeCgroupPath(newScopeUnit()) }, 100)).toBeNull();
  const plain = await runProcess({ launches, job: { id: 'plain', fence: 1, epoch: 0 }, launch: { file: '/bin/sh', args: ['-c', 'exit 0'], env: {}, cwd: dir, stdin: '' }, register: async () => undefined, graceMs: 100 });
  expect(plain.proof.kind).toBe('group_empty');
  const plainPgid = plain.proof.kind === 'group_empty' ? plain.proof.processGroup : 0;
  expect(await launches.reconcile({ job: 'plain', hostId: 'host', bootId: 'boot', processGroup: plainPgid, cgroup: '/x.scope' }, 100)).toBeNull();
});
