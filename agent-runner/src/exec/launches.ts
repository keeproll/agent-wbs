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
export interface LaunchRecord { launchId: string; job: LaunchJob; hostId: string; bootId: string; pgid: number | null; startTime: string | null; sessionId?: number; completedAt?: string; createdAfter: string; cgroup: null }

interface Proc { pid: number; pgid: number; sessionId: number; startTime: string; launchId: string | undefined }
const gone = (e: unknown) => ['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '');
const validPid = (n: number) => Number.isInteger(n) && n > 1 && n <= 2147483647;

/** PID 뒤 괄호 안의 이름에는 공백과 괄호가 들어갈 수 있다. 필드는 마지막 괄호 뒤부터 센다. */
export async function processInfo(pid: number): Promise<{ pgid: number; sessionId: number; startTime: string; state: string }> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const parts = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const pgid = Number(parts[2]), sessionId = Number(parts[3]), startTime = parts[19];
  if (!validPid(pgid) || !validPid(sessionId) || !startTime || !/^\d+$/.test(startTime)) throw new Error('프로세스 식별 정보가 없습니다.');
  return { pgid, sessionId, startTime, state: parts[0] ?? '' };
}

// shortcut: 같은 사용자의 원래 세션 또는 launchId 보존 자손만 추적한다. 둘 다 벗어나는 실행은 운영 cgroup 연결 때 확장한다.
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

async function signalOwnedGroup(pgid: number, snapshot: Proc[], signal: NodeJS.Signals): Promise<void> {
  for (const member of snapshot.filter(p => p.pgid === pgid)) {
    try {
      const current = await processInfo(member.pid);
      if (current.startTime === member.startTime && current.pgid === pgid) { signalGroup(pgid, signal); return; }
    } catch (e) { if (!gone(e)) throw e; }
  }
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
    record.sessionId = info.sessionId;
    await this.save(record);
  }

  async list(): Promise<LaunchRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (e) { if (gone(e)) return []; throw e; }
    const records: LaunchRecord[] = [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const r = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as LaunchRecord;
      if (!r || !/^[a-f0-9-]{36}$/.test(r.launchId) || name !== `${r.launchId}.json` || typeof r.job?.id !== 'string' || !Number.isSafeInteger(r.job.fence) || !Number.isSafeInteger(r.job.epoch) || typeof r.hostId !== 'string' || typeof r.bootId !== 'string' || !/^\d+$/.test(r.createdAfter) || (r.pgid !== null && !validPid(r.pgid)) || (r.startTime !== null && !/^\d+$/.test(r.startTime))) throw new Error('launch 기록이 손상됐습니다.');
      if ((r.sessionId !== undefined && !validPid(r.sessionId)) || (r.completedAt !== undefined && !Number.isFinite(Date.parse(r.completedAt)))) throw new Error('launch 정체성·완료 기록이 손상됐습니다.');
      records.push(r);
    }
    return records;
  }

  /** 같은 부팅의 launch 기록이 없으면 추측하지 않는다. pgid 재사용 프로세스는 종료하지 않는다. */
  async reconcile(hold: Hold, graceMs = 1000): Promise<Proof | null> {
    return this.#reconcile(hold, graceMs, false);
  }

  /** 종료 증명과 서버 해제 응답(또는 보유 없음)을 확인한 뒤 호출한다. 번호가 아닌 launchId 하나를 완료한다. */
  async complete(launchId: string, proof: Proof): Promise<void> {
    const record = (await this.list()).find(r => r.launchId === launchId);
    if (!record || proof.bootId !== record.bootId || (proof.kind === 'no_process' && record.pgid !== null) || (proof.kind === 'group_empty' && proof.processGroup !== record.pgid)) throw new Error('launch 완료 증거가 정체성과 다릅니다.');
    await this.save({ ...record, completedAt: new Date().toISOString() });
  }

  /** 현재 서버 보유가 없는 기록도 남은 자기 자손은 정리한다. 재사용된 타인의 번호는 해제 근거로 쓰지 않는다. */
  async retire(record: LaunchRecord): Promise<boolean> {
    if (record.completedAt) return true;
    const proof = await this.#reconcile({ job: record.job.id, hostId: record.hostId, bootId: record.bootId, processGroup: record.pgid }, 1000, true);
    if (!proof) return false;
    await this.complete(record.launchId, proof);
    return true;
  }

  async #reconcile(hold: Hold, graceMs: number, orphan: boolean): Promise<Proof | null> {
    this.problem = null;
    if (hold.hostId !== this.identity.hostId) return null;
    if (hold.bootId !== this.identity.bootId) return { kind: 'boot_changed', bootId: hold.bootId, currentBootId: this.identity.bootId, processGroup: hold.processGroup };
    try {
      const records = (await this.list()).filter(r => r.job.id === hold.job && r.hostId === hold.hostId && r.bootId === hold.bootId);
      if (!records.length) return null;
      const createdAfter = records.reduce((min, r) => BigInt(r.createdAfter) < min ? BigInt(r.createdAfter) : min, BigInt(records[0]?.createdAfter ?? '0'));
      const groups = new Set<number>();
      const snapshot = await processes(createdAfter);
      const owned = (p: Proc, current: Proc[]) => records.some(r => p.launchId === r.launchId ||
        (!r.completedAt && r.pgid !== null && p.sessionId === (r.sessionId ?? r.pgid) && BigInt(p.startTime) >= BigInt(r.startTime ?? '0') &&
          !current.some(leader => leader.pid === r.pgid && leader.startTime !== r.startTime)));
      for (const r of records) {
        for (const p of snapshot) if (p.launchId === r.launchId) groups.add(p.pgid);
        if (r.pgid !== null && !r.completedAt) {
          const leader = snapshot.find(p => p.pid === r.pgid);
          if (leader && leader.startTime !== r.startTime) {
            if (!orphan) return null;
            continue;
          }
          // 원래 leader가 사라져도 session ID를 쓰는 자손이 있으면 그 번호는 아직 재사용될 수 없다.
          for (const p of snapshot) if (p.sessionId === (r.sessionId ?? r.pgid) && BigInt(p.startTime) >= BigInt(r.startTime ?? '0')) groups.add(p.pgid);
          if (leader) groups.add(r.pgid);
          else if (!orphan && !processGroupEmpty(r.pgid) && !groups.has(r.pgid)) return null;
        }
      }
      if (!orphan && hold.processGroup !== null && !records.some(r => r.pgid === hold.processGroup)) return null;
      for (const g of groups) await signalOwnedGroup(g, snapshot.filter(p => owned(p, snapshot)), 'SIGTERM');
      const empty = async () => {
        const current = await processes(createdAfter);
        return [...groups].every(processGroupEmpty) && !current.some(p => owned(p, current));
      };
      let deadline = Date.now() + graceMs;
      while (!(await empty()) && Date.now() < deadline) await sleep(10);
      if (!(await empty())) {
        // 다시 대조한다. 대기 중 번호가 재사용됐으면 새 프로세스를 죽이지 않는다.
        const current = await processes(createdAfter);
        // TERM 처리 중 새 그룹으로 분리된 자손도 다시 묶는다(M5-03 실커널 재현).
        for (const p of current) if (owned(p, current)) groups.add(p.pgid);
        for (const g of groups) await signalOwnedGroup(g, current.filter(p => owned(p, current)), 'SIGKILL');
        deadline = Date.now() + 1000;
        while (!(await empty()) && Date.now() < deadline) await sleep(10);
      }
      if (!(await empty())) return null;
      return hold.processGroup === null ? { kind: 'no_process', bootId: hold.bootId } : { kind: 'group_empty', bootId: hold.bootId, processGroup: hold.processGroup };
    } catch (e) { this.problem = e instanceof Error ? e.message : 'launch 대조 오류'; return null; }
  }
}
