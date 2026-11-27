// 재점검 P2-1: Agent 설정이 띄운 setsid 자손이 출력 통로를 쥐어도 Runner의 Agent 계정 명령 호출은 끝나야 한다.
// 같은 계정 시험이라 scope 정리가 없다. 남은 자손은 pid 파일로 시험이 직접 끝낸다. scope 정리는 dedicated-scope.host.ts가 본다.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { captureCode, localAgentGit } from '../../src/git/agent-git.ts';

const roots: string[] = [];
const pids: string[] = [];
afterEach(async () => {
  for (const file of pids.splice(0)) {
    const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
    if (pid > 1) try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ }
  }
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
const temp = async () => { const p = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'agent-hang-')); roots.push(p); return p; };

test('명령은 끝났는데 setsid 자손이 출력 통로를 쥐면, 잠깐 기다린 뒤 통로를 닫고 실패한다(결과를 쓰지 않음)', async () => {
  const dir = await temp();
  const pid = join(dir, 'pid'); pids.push(pid);
  let killed = 0;
  const started = performance.now();
  await expect(captureCode({ file: '/bin/sh', args: ['-c', `setsid sh -c 'echo $$ > ${pid}; exec sleep 600' & echo hi; exit 0`], env: { PATH: '/usr/bin:/bin' }, cwd: dir },
    { graceMs: 300, kill: async () => { killed += 1; } })).rejects.toThrow('출력 통로를 쥐고');
  expect(performance.now() - started).toBeLessThan(5_000);
  // 래퍼 호출이면 kill이 그 호출의 scope 전체를 cgroup.kill로 끝낸다.
  expect(killed).toBe(1);
});

test('재점검 재현: Agent가 심은 filter가 setsid 자손으로 통로를 쥐어 git이 막히면, 시간 초과로 끝나고 실패한다', async () => {
  const dir = await temp();
  const pid = join(dir, 'pid'); pids.push(pid);
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgSign=false', ...a]);
  g('init', '-q', '-b', 'main'); await writeFile(join(dir, 'a.txt'), 'a\n'); g('add', 'a.txt'); g('commit', '-qm', 'a');
  g('config', 'filter.x.clean', `setsid sh -c 'echo $$ > ${pid}; exec sleep infinity' & cat`);
  await writeFile(join(dir, '.git', 'info', 'attributes'), '* filter=x\n');
  await writeFile(join(dir, 'a.txt'), 'a\n');
  const started = performance.now();
  await expect(localAgentGit({ timeoutMs: 1_000 }).inspect(dir)).rejects.toThrow('시간 초과');
  expect(performance.now() - started).toBeLessThan(8_000);
});
