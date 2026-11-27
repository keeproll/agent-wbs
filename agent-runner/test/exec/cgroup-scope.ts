// systemd 사용자 scope 안에서만 실행한다. 운영 Runner나 다른 scope는 이동·종료하지 않는다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { Launches } from '../../src/exec/launches.ts';
import { spawnWaiting } from '../../src/exec/process.ts';

const home = process.argv[2] ?? '';
assert(home);
const relative = /^0::(\/.*)$/m.exec(await readFile('/proc/self/cgroup', 'utf8'))?.[1] ?? '';
assert(relative?.includes('/awbs-host-cgroup-'));
const scope = join('/sys/fs/cgroup', relative);
const session = join(scope, 'session');
const manager = join(scope, 'manager');
const file = join(home, 'pids.jsonl');

async function sample() {
  const cpu = await readFile(join(session, 'cpu.stat'), 'utf8');
  const events = await readFile(join(session, 'cgroup.events'), 'utf8');
  return {
    cpuUsec: Number(/^usage_usec (\d+)$/m.exec(cpu)?.[1]),
    memory: Number(await readFile(join(session, 'memory.current'), 'utf8')),
    pids: Number(await readFile(join(session, 'pids.current'), 'utf8')),
    populated: Number(/^populated (\d+)$/m.exec(events)?.[1]),
  };
}

async function probe() {
  let controllers: string[];
  try {
    controllers = (await readFile(join(scope, 'cgroup.controllers'), 'utf8')).trim().split(/\s+/);
    for (const name of ['cpu', 'memory', 'pids']) assert(controllers.includes(name), `controller 없음: ${name}`);
    await mkdir(manager);
    await writeFile(join(manager, 'cgroup.procs'), String(process.pid));
    // cgroup v2는 CPU·메모리 controller를 켜는 부모 그룹 안에 프로세스가 없어야 한다.
    await writeFile(join(scope, 'cgroup.subtree_control'), '+cpu +memory +pids');
    await mkdir(session);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(code ?? '')) throw error;
    return { available: false, code, scope, reason: '사용자 scope에 세션 cgroup을 만들거나 controller를 켤 권한이 없음' };
  }
  const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
  const record = await launches.create({ id: 'cgroup-host', fence: 1, epoch: 0 });
  const child = spawnWaiting(record, { file: '/usr/bin/python3', args: [join(import.meta.dirname, 'kernel-tree.py'), 'all', file, '--hold'], env: {}, cwd: home, stdin: '' });
  const permit = child.stdio[3] as Writable;
  permit.on('error', () => undefined);
  const exited = once(child, 'exit');
  child.stderr?.resume();
  try {
    await once(child, 'spawn');
    await launches.attach(record, child.pid ?? 0);
    // 실행 허가 전 이동한다. 자손은 태어날 때 이 cgroup을 물려받는다.
    await writeFile(join(session, 'cgroup.procs'), String(child.pid));
    assert(child.stdout);
    const ready = once(child.stdout, 'data');
    permit.end('run\n');
    child.stdin?.end();
    await ready;
    const processes = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; role: string; marked: boolean });
    assert.equal(processes.length, 6);
    assert.equal(processes.find(p => p.role === 'scrub')?.marked, false);
    for (const p of processes) assert.equal((await readFile(`/proc/${p.pid}/cgroup`, 'utf8')).trim(), `0::${relative}/session`);
    const before = await sample();
    await writeFile(join(session, 'cgroup.kill'), '1');
    await exited;
    const deadline = Date.now() + 2000;
    let after = await sample();
    // 생존 표시가 먼저 0이 되어도 종료 중인 태스크의 pids 계수가 나중에 줄어들 수 있다.
    while ((after.populated !== 0 || after.pids !== 0) && Date.now() < deadline) { await sleep(10); after = await sample(); }
    assert.equal(after.populated, 0);
    assert.equal(after.pids, 0);
    return { available: true, scope, controllers, before, after, processes, guarantee: 'setsid·nohup·이중 fork·환경 표식 제거에도 같은 cgroup 상속. cgroup 밖 이동 권한은 주지 않아야 함.', productionConnected: false, dedicatedAccountVerified: false };
  } finally {
    permit.destroy();
    // 실패한 시험도 자신이 만든 cgroup만 비우고 지운다.
    await writeFile(join(session, 'cgroup.kill'), '1');
    await exited;
    const deadline = Date.now() + 2000;
    while ((await sample()).populated !== 0 && Date.now() < deadline) await sleep(10);
    await rmdir(session);
  }
}
await writeFile(join(home, 'kernel-facts.json'), JSON.stringify(await probe()) + '\n', { flag: 'wx', mode: 0o600 });
