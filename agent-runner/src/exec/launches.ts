import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ApiRequest } from '../api/client.ts';
import { processGroupEmpty } from '../cleanup/reset.ts';
import { atomicWrite } from '../state/files.ts';
export type Proof = ApiRequest<'releaseJob'>['body']['proof'];
export interface Hold { job: string; hostId: string; bootId: string; processGroup: number | null }
export interface LaunchJob { id: string; fence: number; epoch: number }
export interface LaunchRecord { launchId: string; job: LaunchJob; hostId: string; bootId: string; pgid: number | null; startTime: string | null; createdAfter: string; cgroup: null }

interface Proc { pid: number; pgid: number; startTime: string; launchId: string | undefined }
const gone = (e: unknown) => ['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '');
const validPid = (n: number) => Number.isInteger(n) && n > 1 && n <= 2147483647;

/** PID 뒤 괄호 안의 이름에는 공백과 괄호가 들어갈 수 있다. 필드는 마지막 괄호 뒤부터 센다. */
export async function processInfo(pid: number): Promise<{ pgid: number; startTime: string; state: string }> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const parts = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const pgid = Number(parts[2]), startTime = parts[19];
  if (!validPid(pgid) || !startTime || !/^\d+$/.test(startTime)) throw new Error('프로세스 식별 정보가 없습니다.');
  return { pgid, startTime, state: parts[0] ?? '' };
}

async function processes(createdAfter: bigint): Promise<Proc[]> {
  const found: Proc[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    try {
      if ((await stat(`/proc/${name}`)).uid !== process.getuid?.()) continue;
      const info = await processInfo(pid);
      // Runner보다 먼저 시작한 프로세스는 그 Runner가 만든 자손일 수 없다.
      if (BigInt(info.startTime) < createdAfter) continue;
      if (info.state === 'Z' || info.state === 'X') continue;
      let env: string | undefined;
      for (let attempt = 0; ; attempt++) {
        try { env = await readFile(`/proc/${name}/environ`, 'utf8'); break; }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EACCES' || attempt >= 3) throw e;
          await sleep(10);
          const current = await processInfo(pid);
          if (['Z', 'X'].includes(current.state)) break;
        }
      }
      if (env === undefined) continue;
      const launchId = env.split('\0').find(v => v.startsWith('AWBS_LAUNCH_ID='))?.slice('AWBS_LAUNCH_ID='.length);
      found.push({ pid, ...info, launchId });
    } catch (e) {
      if (gone(e)) continue;
      // 종료 순간에는 stat을 읽은 뒤 environ이 EACCES가 될 수 있다. 살아 있는 미확인 프로세스는 건너뛰지 않는다.
      if ((e as NodeJS.ErrnoException).code === 'EACCES') {
        try { if (['Z', 'X'].includes((await processInfo(pid)).state)) continue; }
        catch (later) { if (gone(later)) continue; throw later; }
      }
      throw e;
    }
  }
  return found;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!validPid(pgid) || pgid === process.pid) throw new Error('종료할 프로세스 그룹 번호가 올바르지 않습니다.');
  try { process.kill(-pgid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}

export class Launches {
  problem: string | null = null;
  readonly home: string;
  readonly identity: { hostId: string; bootId: string };
  constructor(home: string, identity: { hostId: string; bootId: string }) { this.home = home; this.identity = identity; }
  get directory(): string { return join(this.home, 'state', 'launches'); }

  async create(job: LaunchJob): Promise<LaunchRecord> {
    const record: LaunchRecord = { launchId: randomUUID(), job, ...this.identity, pgid: null, startTime: null, createdAfter: (await processInfo(process.pid)).startTime, cgroup: null };
    await this.save(record);
    return record;
  }

  async save(record: LaunchRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(this.directory, `${record.launchId}.json`, JSON.stringify(record));
  }

  async attach(record: LaunchRecord, pid: number): Promise<void> {
    if (!validPid(pid)) throw new Error('대기 래퍼 PID가 없습니다.');
    const info = await processInfo(pid);
    if (info.pgid !== pid) throw new Error('독립 프로세스 그룹이 아닙니다.');
    record.pgid = pid;
    record.startTime = info.startTime;
    await this.save(record);
  }

  async list(): Promise<LaunchRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (e) { if (gone(e)) return []; throw e; }
    const records: LaunchRecord[] = [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const r = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as LaunchRecord;
      if (!r || !/^[a-f0-9-]{36}$/.test(r.launchId) || name !== `${r.launchId}.json` || typeof r.job?.id !== 'string' || !Number.isSafeInteger(r.job.fence) || !Number.isSafeInteger(r.job.epoch) || typeof r.hostId !== 'string' || typeof r.bootId !== 'string' || !/^\d+$/.test(r.createdAfter) || (r.pgid !== null && !validPid(r.pgid)) || (r.startTime !== null && !/^\d+$/.test(r.startTime))) throw new Error('launch 기록이 손상됐습니다.');
      records.push(r);
    }
    return records;
  }

  /** 같은 부팅의 launch 기록이 없으면 추측하지 않는다. pgid 재사용 프로세스는 종료하지 않는다. */
  async reconcile(hold: Hold, graceMs = 1000): Promise<Proof | null> {
    this.problem = null;
    if (hold.hostId !== this.identity.hostId) return null;
    if (hold.bootId !== this.identity.bootId) return { kind: 'boot_changed', bootId: hold.bootId, currentBootId: this.identity.bootId, processGroup: hold.processGroup };
    try {
      const records = (await this.list()).filter(r => r.job.id === hold.job && r.hostId === hold.hostId && r.bootId === hold.bootId);
      if (!records.length) return null;
      const createdAfter = records.reduce((min, r) => BigInt(r.createdAfter) < min ? BigInt(r.createdAfter) : min, BigInt(records[0]?.createdAfter ?? '0'));
      const groups = new Set<number>();
      const snapshot = await processes(createdAfter);
      for (const r of records) {
        for (const p of snapshot) if (p.launchId === r.launchId) groups.add(p.pgid);
        if (r.pgid !== null) {
          const leader = snapshot.find(p => p.pid === r.pgid && p.startTime === r.startTime);
          if (leader) groups.add(r.pgid);
          else if (!processGroupEmpty(r.pgid) && !groups.has(r.pgid)) return null;
        }
      }
      if (hold.processGroup !== null && !groups.has(hold.processGroup) && !processGroupEmpty(hold.processGroup)) return null;
      for (const g of groups) signalGroup(g, 'SIGTERM');
      const empty = async () => [...groups].every(processGroupEmpty) && !(await processes(createdAfter)).some(p => records.some(r => p.launchId === r.launchId));
      let deadline = Date.now() + graceMs;
      while (!(await empty()) && Date.now() < deadline) await sleep(10);
      if (!(await empty())) {
        // 다시 대조한다. 대기 중 번호가 재사용됐으면 새 프로세스를 죽이지 않는다.
        const current = await processes(createdAfter);
        for (const g of groups) if (current.some(p => p.pgid === g && records.some(r => p.launchId === r.launchId || (p.pid === r.pgid && p.startTime === r.startTime)))) signalGroup(g, 'SIGKILL');
        deadline = Date.now() + 1000;
        while (!(await empty()) && Date.now() < deadline) await sleep(10);
      }
      if (!(await empty()) || (hold.processGroup !== null && !processGroupEmpty(hold.processGroup))) return null;
      return hold.processGroup === null ? { kind: 'no_process', bootId: hold.bootId } : { kind: 'group_empty', bootId: hold.bootId, processGroup: hold.processGroup };
    } catch (e) { this.problem = e instanceof Error ? e.message : 'launch 대조 오류'; return null; }
  }
}
