// M8 전 연결 실커널 시험: 전용 계정(awbs-agent) + 사용자 cgroup scope로 fake 세션을 띄우고, 정리 뒤 0개인지 본다.
//
// 유료 호출 없음. 이 PC에 설치된 실제 래퍼(/usr/local/libexec/awbs-agent-exec)와 sudoers 규칙만 쓴다(sudo 비밀번호 없음 규칙).
// - fake 세션: 래퍼가 허용하는 「CLI 설치본 안」 실행 파일 중 Codex 묶음의 bwrap(bubblewrap)으로 python3 kernel-tree.py를 띄운다.
//   kernel-tree.py는 setsid·nohup·이중 fork·표식 지우기 자손을 만든다. 모델·네트워크를 쓰지 않는다.
// - 실제 CLI: `codex --version`·`claude --version`만 부른다(무료).
// 설치가 안 된 PC(래퍼·계정 없음)에서는 건너뛴다. 설치된 PC에서 sudo·scope가 실패하면 시험이 실패한다.
import { spawnSync } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import { AGENT_EXEC, AGENT_ROOT, AGENT_USER, agentControl, dedicatedUserIsolation, selectIsolation } from '../../src/cli/dedicated-user.ts';
import { wrapperAgentFiles, wrapperAgentGit } from '../../src/git/agent-git.ts';
import { installSubagents } from '../../src/exec/install.ts';
import { createHash } from 'node:crypto';
import type { IsolationLayer, Launch } from '../../src/cli/isolation.ts';
import { Launches, processInfo } from '../../src/exec/launches.ts';
import { GitRepository } from '../../src/git/repository.ts';
import { runProcess } from '../../src/exec/process.ts';
import { inUserScope, scopeCgroup, withUserScope } from '../../src/exec/scope.ts';
import { createRunCommand, probeEnv } from '../../src/readiness/command.ts';
import { hostArchive } from './host-evidence.ts';

const agentUid = (() => {
  const result = spawnSync('id', ['-u', AGENT_USER], { encoding: 'utf8' });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
})();
const installed = agentUid !== null && existsSync(AGENT_EXEC);
const WRAPPER_SOURCE = join(import.meta.dirname, '..', '..', 'scripts', 'isolation', 'awbs-agent-exec.sh');
/**
 * 설치된 래퍼가 저장소의 지금 래퍼와 같은가. 래퍼를 바꾸면 owner가 설치 스크립트를 다시 실행해야 적용된다.
 * - 같으면: fake 세션을 ci-run(python3)으로 띄운다(조정자 결정 1). bwrap은 진입점이 아니라 거부돼야 한다(결정 4).
 * - 다르면(옛 래퍼): 옛 래퍼가 받는 bwrap(CLI 묶음 안 실행 파일)으로 띄우고 그 사실을 증거에 적는다.
 */
const wrapperCurrent = installed && readFileSync(AGENT_EXEC, 'utf8') === readFileSync(WRAPPER_SOURCE, 'utf8');
const systemdRun = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '/bin/true'], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${String(process.getuid?.())}` } }).status === 0;
const archive = await hostArchive();
const facts: Record<string, unknown> = { at: new Date().toISOString(), installed, wrapperCurrent, agentUser: AGENT_USER, agentUid, paidCalls: 0 };
/**
 * 설치된 래퍼가 저장소 소스와 다르면(owner가 setup-agent-user.sh를 다시 돌리기 전) 래퍼 동작에 기대는 시험은 돌리지 않고, 그 사실을 이름과 증거에 남긴다.
 * 왜: 옛 래퍼 갈래(bwrap run)는 fix1 이후 어떤 설치본에도 없다. 그 갈래로 돌리면 「실패」가 래퍼 결함인지 설치 차이인지 가를 수 없다.
 */
const MISMATCH = wrapperCurrent ? '' : ' [건너뜀: 설치된 래퍼≠저장소 소스 — setup-agent-user.sh 재설치 뒤 실행]';
if (installed && !wrapperCurrent) facts.skippedForWrapperMismatch = [];
const mismatch = (name: string) => { if (installed && !wrapperCurrent) (facts.skippedForWrapperMismatch as string[]).push(name); return `${name}${MISMATCH}`; };
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
  // ci-run은 실행마다 새 HOME(.awbs-home)을 요구한다(조정자 결정 8). 실제 검사 사본은 GitRepository가 만든다.
  await mkdir(join(dir, '.awbs-home'), { mode: 0o770 }); await chmod(join(dir, '.awbs-home'), 0o770);
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
/** Agent 계정으로 임의 명령 하나. 새 래퍼면 ci-run, 옛 래퍼면 bwrap(run). */
function agentCommand(layer: IsolationLayer, dir: string, argv: [string, ...string[]], current = wrapperCurrent): Launch {
  if (current) {
    if (!layer.command) throw new Error('격리 계층에 command가 없습니다.');
    return layer.command({ file: argv[0], args: argv.slice(1), env: { LANG: 'C.UTF-8', CI: '1' }, cwd: dir, stdin: '' });
  }
  // 옛 래퍼: Runner는 이제 진입점이 아닌 실행 파일을 넘기지 않는다(결정 4). 그래서 시험이 옛 Runner와 같은 실행 계획을 직접 만든다.
  // 사용자 scope(inUserScope)와 sudo·래퍼 run은 실제 그대로다. owner가 설치 스크립트를 다시 실행하면 이 갈래는 쓰이지 않는다.
  const bwrap = join(realpathSync(join(AGENT_ROOT, 'cli', 'codex', 'current')), CODEX_VENDOR, 'codex-resources', 'bwrap');
  return inUserScope({ file: '/usr/bin/sudo', args: ['-n', '-u', AGENT_USER, '--', AGENT_EXEC, 'run', '--agent', 'codex', '--cwd', realpathSync(dir), '--', bwrap,
    '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', ...argv], env: { PATH: '/usr/bin:/bin' }, cwd: dir, stdin: '' });
}
function fakeSession(layer: IsolationLayer, dir: string, hold: boolean): Launch {
  return agentCommand(layer, dir, ['python3', join(dir, 'kernel-tree.py'), 'all', join(dir, 'pids.jsonl'), ...(hold ? ['--hold'] : [])]);
}

test.runIf(installed && wrapperCurrent)(mismatch('전용 계정 fake 세션: 모든 프로세스가 awbs-agent·사용자 scope 안에 있고, 중단 정리 뒤 0개다'), async () => {
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
    // kernel-tree.py 자손 6개(child·grandchild·setsid·nohup·double-fork·scrub) + python 본체 = 7개. sudo 자신은 root(유효 UID 0)로 같은 scope에 있다.
    // 새 래퍼 ci-run은 python을 바로 exec한다(사이에 낀 프로세스 없음). 그래서 Agent 프로세스는 정확히 7개이고 모두 kernel-tree.py다.
    // 옛 래퍼 갈래(bwrap run)는 bwrap 프로세스가 하나 더 있어 8개 이상이다.
    if (wrapperCurrent) {
      expect(agent.length).toBe(7);
      for (const o of agent) expect(await readFile(`/proc/${String(o.pid)}/cmdline`, 'utf8')).toContain(join(dir, 'kernel-tree.py'));
    } else {
      expect(agent.length).toBeGreaterThanOrEqual(8);
    }
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
    expect(result.proof).toMatchObject({ kind: 'cgroup_empty' });
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

test.runIf(installed && wrapperCurrent)(mismatch('전용 계정 fake 세션: 본체가 정상 종료해도 그룹 밖으로 숨은 Agent 자손까지 끝내고 증거를 낸다'), async () => {
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
    expect(result.proof).toMatchObject({ kind: 'cgroup_empty' });
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
      expect(result.proof).toMatchObject({ kind: 'cgroup_empty' });
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

test.runIf(installed && wrapperCurrent)(mismatch('작업 폴더 삭제: Agent가 권한을 지운 폴더(chmod 000)도 실제 래퍼 fix-perms로 되돌린 뒤 지운다'), async () => {
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
    // 새 래퍼의 임의 명령(ci-run)은 실행마다 새 HOME(.awbs-home)이 있는 검사 사본에서만 돈다(조정자 결정 8). 실제 Runner도 ci-run은 검사 사본에만 쓴다.
    // 옛 래퍼 갈래(bwrap run)는 보통 작업 폴더에서 돈다. 어느 쪽이든 같은 removeWorktree 경로로 지운다.
    const work = wrapperCurrent ? await repo.createTaskCheckWorktree('task-1', base) : await repo.createWorktree('task-1', 'agent/TASK-1', base);
    const launch = agentCommand(layer, work, ['sh', '-c', 'mkdir -p locked/inner && echo x > locked/inner/f && chmod 000 locked/inner locked && echo done']);
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

test.runIf(installed && wrapperCurrent)(mismatch('조정자 결정 4: 설치된 래퍼는 CLI 묶음 안의 bwrap을 진입점으로 받지 않는다'), async () => {
  const bwrap = join(await realpath(join(AGENT_ROOT, 'cli', 'codex', 'current')), CODEX_VENDOR, 'codex-resources', 'bwrap');
  const r = await run('/usr/bin/sudo', ['-n', '-u', AGENT_USER, '--', AGENT_EXEC, 'run', '--agent', 'codex', '--cwd', join(AGENT_ROOT, 'worktrees'), '--', bwrap, '--version']);
  expect(r.code).toBe(2);
  facts.bwrapRejected = { code: r.code };
});

/**
 * 새 래퍼(저장소 사본)를 실제 사용자 scope 안에서 돌린다. 계정 전환만 fake sudo(Runner 계정 그대로)로 대신한다.
 * 왜: owner가 설치 스크립트를 다시 실행하기 전에도 ci-run·진입점 규칙·scope 정리를 실커널에서 확인한다.
 */
test.runIf(systemdRun)('새 래퍼 사본 + 실제 사용자 scope: ci-run fake 세션의 자손이 모두 scope 안이고, 중단 뒤 0개·cgroup_empty다', async () => {
  const root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'wrapper-scope-'));
  const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  const area = join(root, 'srv');
  const work = join(area, 'worktrees', 'p1', 'ci-1');
  const controller = new AbortController();
  try {
    for (const d of [work, join(work, '.awbs-home'), join(area, 'inputs'), join(area, 'cli', 'codex', '1.0.0', 'bin'), join(area, 'cli', 'codex', '1.0.0', 'vendor'), join(root, 'node')]) await mkdir(d, { recursive: true });
    await copyFile(join(import.meta.dirname, 'kernel-tree.py'), join(work, 'kernel-tree.py'));
    for (const f of [join(area, 'cli', 'codex', '1.0.0', 'bin', 'codex'), join(area, 'cli', 'codex', '1.0.0', 'vendor', 'bwrap')]) { await writeFile(f, '#!/bin/sh\necho cli\n'); await chmod(f, 0o755); }
    const conf = join(root, 'agent-exec.conf');
    await writeFile(conf, `AGENT_USER=${me}\nRUNNER_USER=${me}\nRUNNER_HOME=${join(root, 'runner-home')}\nAGENT_ROOT=${area}\nNODE_DIR=${join(root, 'node')}\n`);
    const exec = join(root, 'awbs-agent-exec');
    await writeFile(exec, readFileSync(WRAPPER_SOURCE, 'utf8').replace('\nCONF=/etc/agentwbs/agent-exec.conf\n', `\nCONF=${conf}\n`)); await chmod(exec, 0o755);
    const sudo = join(root, 'fake-sudo');
    await writeFile(sudo, '#!/bin/bash\n[[ $1 == -n && $2 == -u && $4 == -- ]] || exit 9\nshift 4\nexec env -i "$@"\n'); await chmod(sudo, 0o755);
    const layer = withUserScope(dedicatedUserIsolation({ user: me, root: area, exec, sudo }));
    // 진입점이 아닌 실행 파일은 Runner 쪽에서 먼저 거부한다.
    expect(() => layer.wrap({ file: join(area, 'cli', 'codex', '1.0.0', 'vendor', 'bwrap'), args: [], env: {}, cwd: work, stdin: '' }, 'Codex')).toThrow(expect.objectContaining({ code: 'binary_outside_agent_root' }));
    // 래퍼 자신도 거부한다.
    expect(spawnSync(exec, ['run', '--agent', 'codex', '--cwd', work, '--', join(area, 'cli', 'codex', '1.0.0', 'vendor', 'bwrap')], { env: { PATH: '/usr/bin:/bin' } }).status).toBe(2);
    const launch = agentCommand(layer, work, ['python3', join(work, 'kernel-tree.py'), 'all', join(work, 'pids.jsonl'), '--hold'], true);
    const unit = launch.scope ?? '';
    expect(launch.args).toContain('ci-run');
    const launches = new Launches(root, { hostId: 'host', bootId: 'boot' });
    let ready = false;
    const running = runProcess({ launches, job: { id: 'wrapper-copy', fence: 1, epoch: 0 }, launch, signal: controller.signal, register: async () => undefined, graceMs: 200,
      stdout: bytes => { if (bytes.toString('utf8').includes('ready')) ready = true; } });
    void running.catch(() => undefined);
    await expect.poll(() => ready, { timeout: 15_000 }).toBe(true);
    const procs = await scopeProcs(unit);
    const relative = scopeCgroup(unit).slice('/sys/fs/cgroup'.length);
    for (const pid of procs) expect((await readFile(`/proc/${String(pid)}/cgroup`, 'utf8')).trim()).toBe(`0::${relative}`);
    const rows = (await readFile(join(work, 'pids.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; role: string; marked: boolean });
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(procs).toContain(row.pid);
    controller.abort();
    const result = await running;
    expect(result.proof).toMatchObject({ kind: 'cgroup_empty', cgroup: relative });
    for (const row of rows) expect(await alive(row.pid)).toBe(false);
    expect(await scopeGone(unit)).toBe(true);
    facts.wrapperCopy = { unit, cgroup: relative, inScope: procs.length, descendants: rows.map(r => r.role), proof: result.proof };
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * 조정자 결정 6(fix2): 새 래퍼 사본(git-inspect·git-bundle)을 실제 사용자 scope 안에서 GitRepository 전용 계정 흐름에 붙인다.
 * 계정 전환만 fake sudo(Runner 계정 그대로)로 대신한다. 리뷰어 PoC 설정은 Agent 쪽 git에서도 실행되지 않아야 한다(늦은 가져오기 끔).
 */
test.runIf(systemdRun)('새 래퍼 사본 + 실제 scope: 결과는 bundle로만 가져오고, 검사는 Agent 쪽 git이 하며, PoC 설정은 실행되지 않는다', async () => {
  const root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'wrapper-git-'));
  const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  const area = join(root, 'srv');
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgSign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).stdout.trim();
  try {
    for (const d of [join(area, 'worktrees'), join(area, 'inputs'), join(area, 'cli'), join(root, 'node'), join(root, 'src')]) await mkdir(d, { recursive: true });
    const conf = join(root, 'agent-exec.conf');
    await writeFile(conf, `AGENT_USER=${me}\nRUNNER_USER=${me}\nRUNNER_HOME=${join(root, 'runner-home')}\nAGENT_ROOT=${area}\nNODE_DIR=${join(root, 'node')}\n`);
    const exec = join(root, 'awbs-agent-exec');
    await writeFile(exec, readFileSync(WRAPPER_SOURCE, 'utf8').replace('\nCONF=/etc/agentwbs/agent-exec.conf\n', `\nCONF=${conf}\n`)); await chmod(exec, 0o755);
    const sudo = join(root, 'fake-sudo');
    await writeFile(sudo, '#!/bin/bash\n[[ $1 == -n && $2 == -u && $4 == -- ]] || exit 9\nshift 4\nexec env -i "$@"\n'); await chmod(sudo, 0o755);
    const remote = join(root, 'remote.git');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await writeFile(join(root, 'src', 'a.txt'), 'a');
    git(join(root, 'src'), 'init', '-q', '-b', 'main'); git(join(root, 'src'), 'add', '.'); git(join(root, 'src'), 'commit', '-qm', 'a'); git(join(root, 'src'), 'push', '-q', remote, 'main');
    const head = git(join(root, 'src'), 'rev-parse', 'HEAD');
    const repo = await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot: area, restorePermissions: null, agentGit: wrapperAgentGit({ user: me, exec, sudo }) });
    // 1) 시도 작업 폴더에 Agent가 커밋 → bundle로만 가져온다.
    const work = await repo.createWorktree('task-1', 'agent/TASK-1', head);
    await writeFile(join(work, 'b.txt'), 'b'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'agent');
    const agentHead = git(work, 'rev-parse', 'HEAD');
    expect(await repo.importWorktree('task-1', 'agent/TASK-1')).toBe(agentHead);
    // 2) 검사 사본: 깨끗하면 통과, 추적 안 된 파일이 있으면 거부(Agent 쪽 git-inspect).
    const ci = await repo.createTaskCheckWorktree('ci-1', head);
    await repo.taskCheckPath('ci-1', head);
    await writeFile(join(ci, 'extra.txt'), 'x');
    await expect(repo.taskCheckPath('ci-1', head)).rejects.toThrow('커밋하지 않은 변경');
    // 3) 리뷰어 PoC: promisor·uploadpack을 심어도 늦은 가져오기를 하지 않아 명령이 실행되지 않는다(Agent 쪽에서도).
    const poc = await repo.createTaskCheckWorktree('ci-poc', head);
    const marker = join(root, 'PWNED');
    git(poc, 'config', 'core.repositoryformatversion', '1'); git(poc, 'config', 'extensions.partialClone', 'x');
    git(poc, 'config', 'remote.x.url', remote); git(poc, 'config', 'remote.x.promisor', 'true');
    git(poc, 'config', 'remote.x.uploadpack', `id -un > ${marker}; git-upload-pack`);
    await writeFile(join(poc, '.git', 'refs', 'heads', 'agent', 'ci-poc'), '1'.repeat(40) + '\n');
    await expect(repo.taskCheckPath('ci-poc', head)).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    // 4) 하위 Agent 정의(fix2 추가): 래퍼 agent-file로만 쓰고 걷어 낸다. 실제 사용자 scope 안에서 돈다.
    const files = wrapperAgentFiles({ user: me, exec, sudo });
    const text = '코드를 검토합니다.\n';
    const def = { id: '00000000-0000-4000-8000-000000000001', key: 'code-reviewer', agent: 'Codex' as const, version: 1, file: text, sandbox: 'read-only',
      hash: createHash('sha256').update(text).digest('hex') };
    await installSubagents(work, 'Codex', { enabled: true, items: [def] }, { model: 'gpt-6.2-sol', effort: 'high' }, files);
    expect(readFileSync(join(work, '.codex/agents/code-reviewer.toml'), 'utf8')).toContain('name = "code-reviewer"');
    await installSubagents(work, 'Codex', { enabled: false, items: [] }, { model: 'gpt-6.2-sol', effort: 'high' }, files);
    expect(existsSync(join(work, '.codex/agents/code-reviewer.toml'))).toBe(false);
    facts.agentGitCopy = { importedHead: agentHead, untrackedRejected: true, pocMarker: existsSync(marker), subagentFilesViaWrapper: true };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * 재점검 P2-1(fix3): Agent가 심은 filter가 setsid 자손으로 출력 통로를 쥐어 git-inspect가 막혀도,
 * 래퍼 호출의 전용 scope를 시간 초과 때 cgroup.kill로 비워 호출이 끝나고 자손도 남지 않아야 한다(새 래퍼 사본, 실제 scope).
 */
test.runIf(systemdRun)('재점검 P2-1 재현: filter의 setsid 자손이 통로를 쥐어도 래퍼 호출은 시간 초과로 끝나고 scope 전체가 정리된다', async () => {
  const root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'wrapper-hang-'));
  const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  const area = join(root, 'srv');
  const repo = join(area, 'worktrees', 'p1', 'ci-hang');
  const pidFile = join(root, 'stray.pid');
  try {
    for (const d of [repo, join(area, 'inputs'), join(area, 'cli'), join(root, 'node')]) await mkdir(d, { recursive: true });
    const conf = join(root, 'agent-exec.conf');
    await writeFile(conf, `AGENT_USER=${me}\nRUNNER_USER=${me}\nRUNNER_HOME=${join(root, 'runner-home')}\nAGENT_ROOT=${area}\nNODE_DIR=${join(root, 'node')}\n`);
    const exec = join(root, 'awbs-agent-exec');
    await writeFile(exec, readFileSync(WRAPPER_SOURCE, 'utf8').replace('\nCONF=/etc/agentwbs/agent-exec.conf\n', `\nCONF=${conf}\n`)); await chmod(exec, 0o755);
    const sudo = join(root, 'fake-sudo');
    await writeFile(sudo, '#!/bin/bash\n[[ $1 == -n && $2 == -u && $4 == -- ]] || exit 9\nshift 4\nexec env -i "$@"\n'); await chmod(sudo, 0o755);
    const g = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgSign=false', ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); await writeFile(join(repo, 'a.txt'), 'a\n'); g('add', 'a.txt'); g('commit', '-qm', 'a');
    // Agent가 심을 수 있는 설정: clean filter가 setsid 자손을 띄워 git의 통로를 쥔다(리뷰어 재현과 같은 모양, sleep infinity).
    g('config', 'filter.x.clean', `setsid sh -c 'echo $$ > ${pidFile}; exec sleep infinity' & cat`);
    await writeFile(join(repo, '.git', 'info', 'attributes'), '* filter=x\n');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    const started = performance.now();
    await expect(wrapperAgentGit({ user: me, exec, sudo, timeoutMs: 2_000 }).inspect(repo)).rejects.toThrow('시간 초과');
    const elapsed = Math.round(performance.now() - started);
    expect(elapsed).toBeLessThan(15_000);
    const stray = Number(readFileSync(pidFile, 'utf8').trim());
    expect(stray).toBeGreaterThan(1);
    // scope 전체를 cgroup.kill로 비웠으므로 setsid 자손도 끝났다.
    await expect.poll(() => alive(stray), { timeout: 3_000 }).toBe(false);
    facts.wrapperHang = { elapsedMs: elapsed, strayPid: stray, strayAlive: await alive(stray) };
  } finally {
    const stray = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : 0);
    if (stray > 1) try { process.kill(stray, 'SIGKILL'); } catch { /* 이미 끝남 */ }
    await rm(root, { recursive: true, force: true });
  }
});

test.runIf(!installed)('전용 계정이 설치되지 않은 PC: 시험을 건너뛰었음을 기록한다', () => {
  facts.skipped = '래퍼 또는 awbs-agent 계정이 없어 실커널 전용 계정 시험을 건너뜀';
  expect(installed).toBe(false);
});
