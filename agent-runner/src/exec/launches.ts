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

interface Proc { pid: number; ppid: number; pgid: number; sessionId: number; startTime: string; launchId: string | undefined }
const gone = (e: unknown) => ['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '');
const validPid = (n: number) => Number.isInteger(n) && n > 1 && n <= 2147483647;

/** PID 뒤 괄호 안의 이름에는 공백과 괄호가 들어갈 수 있다. 필드는 마지막 괄호 뒤부터 센다. */
export async function processInfo(pid: number): Promise<{ ppid: number; pgid: number; sessionId: number; startTime: string; state: string }> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const parts = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const ppid = Number(parts[1]), pgid = Number(parts[2]), sessionId = Number(parts[3]), startTime = parts[19];
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !validPid(pgid) || !validPid(sessionId) || !startTime || !/^\d+$/.test(startTime)) throw new Error('프로세스 식별 정보가 없습니다.');
  return { ppid, pgid, sessionId, startTime, state: parts[0] ?? '' };
}

// shortcut: 같은 사용자의 세션·부모 연결·읽을 수 있는 launchId로 추적한다. 모두 잃은 자손은 운영 cgroup 연결 때 확장한다.
async function processes(createdAfter: bigint, records: LaunchRecord[], known: Map<number, string>): Promise<Proc[]> {
  const found: Proc[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    try {
      if ((await stat(`/proc/${name}`)).uid !== process.getuid?.()) continue;
      const info = await processInfo(pid);
      if (BigInt(info.startTime) < createdAfter || ['Z', 'X'].includes(info.state)) continue;
      found.push({ pid, ...info, launchId: undefined });
    } catch (e) { if (!gone(e)) throw e; }
  }
  const byPid = new Map(found.map(p => [p.pid, p]));
  const related = (process: Proc): boolean => {
    const seen = new Set<number>();
    let current: Proc | undefined = process;
    while (current && !seen.has(current.pid)) {
      const p = current;
      if (known.get(p.pid) === p.startTime || records.some(r => p.launchId === r.launchId ||
        (!r.completedAt && r.pgid !== null && p.sessionId === (r.sessionId ?? r.pgid) && BigInt(p.startTime) >= BigInt(r.startTime ?? '0') &&
          !(byPid.has(r.pgid) && byPid.get(r.pgid)?.startTime !== r.startTime)))) return true;
      seen.add(p.pid);
      current = byPid.get(p.ppid);
      if (current && BigInt(current.startTime) > BigInt(p.startTime)) return false;
    }
    return false;
  };
  // 환경 접근 전에 공개 stat의 세션·부모 연결로 소속을 가린다.
  for (const p of found) if (related(p)) known.set(p.pid, p.startTime);
  const denied = new Map<Proc, unknown>();
  for (const p of found) {
    try {
      // 다른 세션으로 분리된 자손은 읽을 수 있는 launchId 표식으로도 찾는다.
      const env = await readFile(`/proc/${p.pid}/environ`, 'utf8');
      p.launchId = env.split('\0').find(v => v.startsWith('AWBS_LAUNCH_ID='))?.slice('AWBS_LAUNCH_ID='.length);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EACCES') denied.set(p, e);
      else if (!gone(e)) throw e;
    }
  }
  for (const p of found) if (related(p)) known.set(p.pid, p.startTime);
  for (const [p, error] of denied) {
    if (!related(p)) continue;
    // 소속 프로세스의 종료 순간 EACCES만 재확인한다. 무관한 프로세스는 정리를 막지 않는다.
    for (let attempt = 0; ; attempt++) {
      try {
        const current = await processInfo(p.pid);
        if (current.startTime !== p.startTime || ['Z', 'X'].includes(current.state)) break;
        if (attempt >= 3) throw error;
        await sleep(10);
        await readFile(`/proc/${p.pid}/environ`, 'utf8');
        break;
      } catch (e) {
        if (gone(e)) break;
        if ((e as NodeJS.ErrnoException).code !== 'EACCES' || attempt >= 3) throw e;
      }
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

/**
 * 이 Runner가 직접 띄운 detached 자식(자기 프로세스 그룹의 leader)의 그룹 하나를 끝낸다.
 * M5-02·M5-03의 그룹 정리 방식(`signalOwnedGroup`·`processGroupEmpty`)을 그대로 쓴다: TERM → graceMs 대기 → 남으면 KILL → 1초 대기.
 * 그룹이 비었음을 확인하면 true, 확인하지 못하면 false다(그때 호출자는 결과를 「모름」으로 다룬다).
 * 신호는 leader 시작 이후에 생긴 같은 사용자 프로세스가 지금도 그 그룹에 있을 때만 보낸다(번호 재사용 방지).
 * 예: git push를 끊으면 git이 띄운 git-remote-https·git send-pack까지 같은 그룹이라 함께 끝난다.
 */
export async function terminateGroup(pgid: number, leaderStartTime: string, graceMs = 2_000): Promise<boolean> {
  if (!validPid(pgid) || pgid === process.pid || !/^\d+$/.test(leaderStartTime)) return false;
  const members = async (): Promise<Proc[]> => {
    const found: Proc[] = [];
    for (const name of await readdir('/proc')) {
      if (!/^[1-9]\d*$/.test(name)) continue;
      try {
        if ((await stat(`/proc/${name}`)).uid !== process.getuid?.()) continue;
        const info = await processInfo(Number(name));
        if (info.pgid === pgid && BigInt(info.startTime) >= BigInt(leaderStartTime) && !['Z', 'X'].includes(info.state)) found.push({ pid: Number(name), ...info, launchId: undefined });
      } catch (e) { if (!gone(e)) throw e; }
    }
    return found;
  };
  try {
    if (processGroupEmpty(pgid)) return true;
    const first = await members();
    // 그룹은 남았는데 우리 구성원이 하나도 보이지 않으면 남의 그룹일 수 있다. 신호를 보내지 않고 「모름」이다.
    if (first.length === 0) return false;
    await signalOwnedGroup(pgid, first, 'SIGTERM');
    let deadline = performance.now() + graceMs;
    while (!processGroupEmpty(pgid) && performance.now() < deadline) await sleep(10);
    if (!processGroupEmpty(pgid)) {
      await signalOwnedGroup(pgid, await members(), 'SIGKILL');
      deadline = performance.now() + 1_000;
      while (!processGroupEmpty(pgid) && performance.now() < deadline) await sleep(10);
    }
    return processGroupEmpty(pgid);
  } catch { return false; }
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
      const known = new Map<number, string>();
      const snapshot = await processes(createdAfter, records, known);
      const owned = (p: Proc) => known.get(p.pid) === p.startTime;
      for (const p of snapshot) if (owned(p)) groups.add(p.pgid);
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
      for (const g of groups) await signalOwnedGroup(g, snapshot.filter(p => owned(p)), 'SIGTERM');
      const empty = async () => {
        const current = await processes(createdAfter, records, known);
        return [...groups].every(processGroupEmpty) && !current.some(p => owned(p));
      };
      let deadline = performance.now() + graceMs;
      while (!(await empty()) && performance.now() < deadline) await sleep(10);
      if (!(await empty())) {
        // 다시 대조한다. 대기 중 번호가 재사용됐으면 새 프로세스를 죽이지 않는다.
        const current = await processes(createdAfter, records, known);
        // TERM 처리 중 새 그룹으로 분리된 자손도 다시 묶는다(M5-03 실커널 재현).
        for (const p of current) if (owned(p)) groups.add(p.pgid);
        for (const g of groups) await signalOwnedGroup(g, current.filter(p => owned(p)), 'SIGKILL');
        deadline = performance.now() + 1000;
        while (!(await empty()) && performance.now() < deadline) await sleep(10);
      }
      if (!(await empty())) return null;
      return hold.processGroup === null ? { kind: 'no_process', bootId: hold.bootId } : { kind: 'group_empty', bootId: hold.bootId, processGroup: hold.processGroup };
    } catch (e) { this.problem = e instanceof Error ? e.message : 'launch 대조 오류'; return null; }
  }
}
