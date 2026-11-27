// M8 전 연결 실커널 시험: 전용 계정(awbs-agent) + 사용자 cgroup scope로 fake 세션을 띄우고, 정리 뒤 0개인지 본다.
//
// 유료 호출 없음. 이 PC에 설치된 실제 래퍼(/usr/local/libexec/awbs-agent-exec)와 sudoers 규칙만 쓴다(sudo 비밀번호 없음 규칙).
// - fake 세션: 래퍼가 허용하는 「CLI 설치본 안」 실행 파일 중 Codex 묶음의 bwrap(bubblewrap)으로 python3 kernel-tree.py를 띄운다.
//   kernel-tree.py는 setsid·nohup·이중 fork·표식 지우기 자손을 만든다. 모델·네트워크를 쓰지 않는다.
// - 실제 CLI: `codex --version`·`claude --version`만 부른다(무료).
// 설치가 안 된 PC(래퍼·계정 없음)에서는 건너뛴다. 설치된 PC에서 sudo·scope가 실패하면 시험이 실패한다.
import { spawnSync } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import { AGENT_EXEC, AGENT_ROOT, AGENT_USER, agentControl, selectIsolation } from '../../src/cli/dedicated-user.ts';
import type { IsolationLayer, Launch } from '../../src/cli/isolation.ts';
import { Launches, processInfo } from '../../src/exec/launches.ts';
import { GitRepository } from '../../src/git/repository.ts';
import { runProcess } from '../../src/exec/process.ts';
import { scopeCgroup } from '../../src/exec/scope.ts';
import { createRunCommand, probeEnv } from '../../src/readiness/command.ts';
import { hostArchive } from './host-evidence.ts';

const agentUid = (() => {
  const result = spawnSync('id', ['-u', AGENT_USER], { encoding: 'utf8' });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
})();
const installed = agentUid !== null && existsSync(AGENT_EXEC);
const archive = await hostArchive();
const facts: Record<string, unknown> = { at: new Date().toISOString(), installed, agentUser: AGENT_USER, agentUid, paidCalls: 0 };
afterAll(async () => { await writeFile(join(archive, 'dedicated-scope-facts.json'), JSON.stringify(facts, null, 2) + '\n'); });

const CODEX_VENDOR = 'lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl';
const run = createRunCommand({ env: probeEnv(process.env), timeoutMs: 30_000 });
const cfg = { user: AGENT_USER, root: AGENT_ROOT, exec: AGENT_EXEC };

/** /proc/<pid>/status의 실제 UID(첫 칸)와 유효 UID(둘째 칸) */
async function uids(pid: number): Promise<{ real: number; effective: number } | null> {
  try {
    const line = /^Uid:\s+(\d+)\s+(\d+)/m.exec(await readFile(`/proc/${String(pid)}/status`, 'utf8'));
    return line ? { real: Number(line[1]), effective: Number(line[2]) } : null;
  } catch { return null; }
}
async function alive(pid: number): Promise<boolean> {
  try { return !['Z', 'X'].includes((await processInfo(pid)).state); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
}
/** 이 PC 전체에서 Agent 계정이 실제 UID인 살아 있는 프로세스 */
async function agentProcesses(): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    if ((await uids(pid))?.real === agentUid && await alive(pid)) found.push(pid);
  }
  return found;
}
async function scopeProcs(unit: string): Promise<number[]> {
  try { return (await readFile(join(scopeCgroup(unit), 'cgroup.procs'), 'utf8')).trim().split('\n').filter(Boolean).map(Number); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function scopeGone(unit: string): Promise<boolean> {
  return !existsSync(scopeCgroup(unit)) || /^populated 0$/m.test(await readFile(join(scopeCgroup(unit), 'cgroup.events'), 'utf8').catch(() => 'populated 0'));
}

/** Agent 작업 영역 안 시험 폴더. 실제 작업 폴더처럼 0770으로 둔다(기본 ACL이 Agent 쓰기를 준다, isolation.md §6). */
async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(AGENT_ROOT, 'worktrees', 'host-scope-'));
  await chmod(dir, 0o770);
  const script = join(dir, 'kernel-tree.py');
  await copyFile(join(import.meta.dirname, 'kernel-tree.py'), script);
  await chmod(script, 0o644);
  return dir;
}
/** Agent가 만든 파일을 Runner가 지울 수 있게 래퍼 fix-perms로 되돌린 뒤 지운다(실제 agentControl 경로). */
async function removeWorkdir(dir: string): Promise<void> {
  const control = agentControl(cfg, { kind: 'fix-perms', path: dir });
  const fixed = await run(control.file, control.args);
  expect(fixed.stdout.trim(), fixed.stderr).toBe('fixed');
  await rm(dir, { recursive: true, force: true });
}

async function isolation(): Promise<IsolationLayer> {
  const choice = await selectIsolation({ AWBS_AGENT_USER: AGENT_USER }, run);
  facts.isolation = { name: choice.isolation.name, reason: choice.reason };
  expect(choice.reason).toBeNull();
  return choice.isolation;
}
function fakeSession(layer: IsolationLayer, dir: string, hold: boolean): Launch {
  const bwrap = join(AGENT_ROOT, 'cli', 'codex', 'current', CODEX_VENDOR, 'codex-resources', 'bwrap');
  return layer.wrap({
    file: bwrap,
    args: ['--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', '/usr/bin/python3', join(dir, 'kernel-tree.py'), 'all', join(dir, 'pids.jsonl'), ...(hold ? ['--hold'] : [])],
    env: { LANG: 'C.UTF-8' }, cwd: dir, stdin: '',
  }, 'Codex');
}

test.runIf(installed)('전용 계정 fake 세션: 모든 프로세스가 awbs-agent·사용자 scope 안에 있고, 중단 정리 뒤 0개다', async () => {
  const layer = await isolation();
  const dir = await workdir();
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'dedicated-scope-'));
  const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
  const launch = fakeSession(layer, dir, true);
  const unit = launch.scope ?? '';
  const controller = new AbortController();
  let ready = false;
  try {
    expect(launch.file).toBe('/usr/bin/systemd-run');
    expect(launch.args).toContain('/usr/bin/sudo');
    const before = await agentProcesses();
    const running = runProcess({ launches, job: { id: 'dedicated-hold', fence: 1, epoch: 0 }, launch, signal: controller.signal, register: async () => undefined, graceMs: 200,
      stdout: bytes => { if (bytes.toString('utf8').includes('ready')) ready = true; } });
    void running.catch(() => undefined);
    await expect.poll(() => ready, { timeout: 15_000 }).toBe(true);
    const procs = await scopeProcs(unit);
    const owners = await Promise.all(procs.map(async pid => ({ pid, ...(await uids(pid)), cgroup: (await readFile(`/proc/${String(pid)}/cgroup`, 'utf8')).trim() })));
    const relative = scopeCgroup(unit).slice('/sys/fs/cgroup'.length);
    const agent = owners.filter(o => o.real === agentUid);
    // kernel-tree.py 자손 6개 + python 본체 + bwrap. sudo 자신은 root(유효 UID 0)로 같은 scope에 있다.
    expect(agent.length).toBeGreaterThanOrEqual(8);
    expect(owners.some(o => o.effective === 0)).toBe(true);
    for (const o of owners) expect(o.cgroup).toBe(`0::${relative}`);
    // 이 PC의 Agent 계정 프로세스는 모두 이 scope 안이다(새로 생긴 것 기준).
    const outside = (await agentProcesses()).filter(pid => !before.includes(pid) && !procs.includes(pid));
    expect(outside).toEqual([]);
    // Runner 계정은 Agent 프로세스에 직접 신호를 보낼 수 없다. 그래서 scope가 필요하다.
    let denied = '';
    try { process.kill(agent[0]?.pid ?? 0, 0); } catch (error) { denied = (error as NodeJS.ErrnoException).code ?? ''; }
    expect(denied).toBe('EPERM');
    // 자손이 원래 그룹·세션을 빠져나갔는지(setsid·이중 fork) 기록한다. 그룹만으로는 이들을 증명할 수 없다(M5-03).
    const ids = await Promise.all(agent.map(async o => { const f = (await readFile(`/proc/${String(o.pid)}/stat`, 'utf8')).split(') ')[1]?.split(' ') ?? []; return { pgid: f[2], sid: f[3] }; }));
    const groups = new Set(ids.map(i => i.pgid)), sessions = new Set(ids.map(i => i.sid));
    expect(sessions.size).toBeGreaterThanOrEqual(3);
    facts.hold = { unit, cgroup: relative, processes: owners, agentCount: agent.length, groups: groups.size, sessions: sessions.size, killFromRunner: denied };
    controller.abort();
    const result = await running;
    expect(result.proof).toMatchObject({ kind: 'group_empty' });
    for (const o of owners) expect(await alive(o.pid)).toBe(false);
    expect(await scopeGone(unit)).toBe(true);
    const after = (await agentProcesses()).filter(pid => !before.includes(pid));
    expect(after).toEqual([]);
    facts.holdAfter = { proof: result.proof, signal: result.signal, scopeGone: true, agentProcessesLeft: after.length, agentProcessesTotal: (await agentProcesses()).length };
  } finally {
    controller.abort();
    await removeWorkdir(dir);
    await rm(home, { recursive: true, force: true });
  }
});

test.runIf(installed)('전용 계정 fake 세션: 본체가 정상 종료해도 그룹 밖으로 숨은 Agent 자손까지 끝내고 증거를 낸다', async () => {
  const layer = await isolation();
  const dir = await workdir();
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'dedicated-scope-'));
  const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
  const launch = fakeSession(layer, dir, false);
  const unit = launch.scope ?? '';
  const seen = new Set<number>();
  try {
    const before = await agentProcesses();
    let watching = true;
    // 정리 전에 scope 안 프로세스를 계속 적어 둔다(정리 뒤 살아 있는지 확인용).
    const watcher = (async () => { while (watching) { for (const pid of await scopeProcs(unit)) seen.add(pid); await sleep(5); } })();
    const result = await runProcess({ launches, job: { id: 'dedicated-exit', fence: 1, epoch: 0 }, launch, register: async () => undefined, graceMs: 200 });
    watching = false;
    await watcher;
    expect(result.code).toBe(0);
    expect(result.proof).toMatchObject({ kind: 'group_empty' });
    expect(seen.size).toBeGreaterThanOrEqual(7);
    for (const pid of seen) expect(await alive(pid)).toBe(false);
    expect(await scopeGone(unit)).toBe(true);
    const after = (await agentProcesses()).filter(pid => !before.includes(pid));
    expect(after).toEqual([]);
    facts.exit = { unit, seenInScope: seen.size, code: result.code, proof: result.proof, agentProcessesLeft: after.length };
  } finally {
    await removeWorkdir(dir);
    await rm(home, { recursive: true, force: true });
  }
});

test.runIf(installed)('실제 CLI는 무료 명령(--version)만: 전용 계정 + scope로 돌고 같은 버전을 말한다', async () => {
  const layer = await isolation();
  const dir = await workdir();
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'dedicated-scope-'));
  const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
  try {
    const versions: Record<string, string> = {};
    for (const agent of ['Codex', 'Claude'] as const) {
      const name = agent.toLowerCase();
      const launch = layer.wrap({ file: join(AGENT_ROOT, 'cli', name, 'current', 'bin', name), args: ['--version'], env: { LANG: 'C.UTF-8' }, cwd: dir, stdin: '' }, agent);
      const out: Buffer[] = [];
      const result = await runProcess({ launches, job: { id: `version-${name}`, fence: 1, epoch: 0 }, launch, register: async () => undefined, graceMs: 200, stdout: bytes => { out.push(bytes); } });
      expect(result.code).toBe(0);
      expect(result.proof).toMatchObject({ kind: 'group_empty' });
      expect(await scopeGone(launch.scope ?? '')).toBe(true);
      versions[agent] = Buffer.concat(out).toString('utf8').trim();
      // 래퍼에 넘긴 실행 파일은 실행 시점의 버전 폴더(current 링크를 따라간 곳)다.
      expect(versions[agent]).toContain(basename(await realpath(join(AGENT_ROOT, 'cli', name, 'current'))));
    }
    expect(versions.Codex).toMatch(/\d+\.\d+\.\d+/);
    expect(versions.Claude).toMatch(/\d+\.\d+\.\d+/);
    facts.versions = versions;
  } finally {
    await removeWorkdir(dir);
    await rm(home, { recursive: true, force: true });
  }
});

test.runIf(installed)('작업 폴더 삭제: Agent가 권한을 지운 폴더(chmod 000)도 실제 래퍼 fix-perms로 되돌린 뒤 지운다', async () => {
  const layer = await isolation();
  const root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'dedicated-git-'));
  const source = join(root, 'source'), remote = join(root, 'remote.git');
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).stdout.trim();
  const repositoryId = `host-perms-${String(process.pid)}`;
  const area = join(AGENT_ROOT, 'worktrees', repositoryId);
  const launches = new Launches(root, { hostId: 'host', bootId: 'boot' });
  try {
    await mkdir(join(source, 'src'), { recursive: true });
    git(source, 'init', '-b', 'main');
    await writeFile(join(source, 'src/a.ts'), 'a');
    git(source, 'add', '-A'); git(source, 'commit', '-m', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    git(source, 'init', '--bare', '-b', 'main', remote);
    git(source, 'push', remote, 'main');
    const repo = await GitRepository.clone(join(root, 'runner'), repositoryId, remote, { agentRoot: AGENT_ROOT });
    const work = await repo.createWorktree('task-1', 'agent/TASK-1', base);
    const bwrap = join(AGENT_ROOT, 'cli', 'codex', 'current', CODEX_VENDOR, 'codex-resources', 'bwrap');
    const launch = layer.wrap({ file: bwrap, args: ['--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', '/bin/sh', '-c',
      'mkdir -p locked/inner && echo x > locked/inner/f && chmod 000 locked/inner locked && echo done'], env: {}, cwd: work, stdin: '' }, 'Codex');
    const out: Buffer[] = [];
    const result = await runProcess({ launches, job: { id: 'perms', fence: 1, epoch: 0 }, launch, register: async () => undefined, graceMs: 200, stdout: bytes => { out.push(bytes); } });
    expect(Buffer.concat(out).toString('utf8').trim()).toBe('done');
    expect(result.code).toBe(0);
    // Runner 계정은 Agent 소유 000 폴더를 열 수 없다.
    await expect(readdir(join(work, 'locked'))).rejects.toMatchObject({ code: 'EACCES' });
    await repo.removeWorktree('task-1');
    expect(existsSync(work)).toBe(false);
    expect(await repo.recordedWorktrees()).toEqual([]);
    facts.removeWorktree = { work, agentChmod000: true, removedAfterFixPerms: true };
  } finally {
    if (existsSync(area)) {
      const control = agentControl(cfg, { kind: 'fix-perms', path: area });
      await run(control.file, control.args);
      await rm(area, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test.runIf(!installed)('전용 계정이 설치되지 않은 PC: 시험을 건너뛰었음을 기록한다', () => {
  facts.skipped = '래퍼 또는 awbs-agent 계정이 없어 실커널 전용 계정 시험을 건너뜀';
  expect(installed).toBe(false);
});
