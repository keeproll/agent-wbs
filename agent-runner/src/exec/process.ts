import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import type { Launch } from '../cli/isolation.ts';
import type { Launches, LaunchJob, LaunchRecord, Proof } from './launches.ts';
export interface ProcessOptions {
  launches: Launches;
  job: LaunchJob;
  launch: Launch;
  register: (record: LaunchRecord) => Promise<void>;
  signal?: AbortSignal;
  graceMs?: number;
  stdout?: (bytes: Buffer) => void | Promise<void>;
  stdoutEnd?: () => void;
}
/** 고정 래퍼만 shell로 읽는다. 실제 명령·인자는 "$@" 배열로 전달하고 문자열로 합치지 않는다. */
export function spawnWaiting(record: LaunchRecord, launch: Launch): ChildProcess {
  return spawn('/bin/sh', ['-c', 'IFS= read -r permit <&3 || exit 125; [ "$permit" = run ] || exit 125; exec 3<&-; exec "$@"', '--', launch.file, ...launch.args], {
    cwd: launch.cwd, env: { ...launch.env, AWBS_LAUNCH_ID: record.launchId }, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
}

export async function runProcess(o: ProcessOptions): Promise<{ code: number | null; signal: NodeJS.Signals | null; proof: Proof; launchId: string }> {
  o.signal?.throwIfAborted();
  const record = await o.launches.create(o.job);
  const child = spawnWaiting(record, o.launch);
  const permit = child.stdio[3] as Writable;
  permit.on('error', () => undefined);
  child.stdin?.on('error', () => undefined);
  child.stderr?.resume();
  const output = (async () => {
    try { if (child.stdout) for await (const bytes of child.stdout) await o.stdout?.(bytes as Buffer); }
    finally { o.stdoutEnd?.(); }
  })();
  void output.catch(() => { permit.destroy(); void clean(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // spawn 실패도 아래 정리 경로가 담당한다. 조기 reject가 처리되지 않은 Promise가 되지 않게 한다.
  void exited.catch(() => undefined);
  const clean = () => o.launches.reconcile({ job: o.job.id, ...o.launches.identity, processGroup: record.pgid }, o.graceMs);
  let rejectStop: (e: Error) => void = () => undefined;
  const stopping = new Promise<never>((_, reject) => { rejectStop = reject; });
  void stopping.catch(() => undefined);
  const abort = () => { permit.destroy(); void clean().then(proof => { if (!proof) rejectStop(new Error(`종료를 확인할 수 없습니다: ${o.launches.problem ?? '그룹이 남아 있습니다.'}`)); }); };
  o.signal?.addEventListener('abort', abort, { once: true });
  try {
    await once(child, 'spawn');
    await o.launches.attach(record, child.pid ?? 0);
    o.signal?.throwIfAborted();
    await o.register(record);
    o.signal?.throwIfAborted();
    permit.end('run\n');
    child.stdin?.end(o.launch.stdin);
    const result = await Promise.race([exited, stopping]);
    const proof = await clean();
    await output;
    if (!proof) throw new Error(`프로세스 그룹 종료를 증명하지 못했습니다. unconfirmed 보유를 유지합니다: ${o.launches.problem ?? '그룹이 남아 있습니다.'}`);
    return { ...result, proof, launchId: record.launchId };
  } finally {
    permit.destroy();
    await clean();
    o.signal?.removeEventListener('abort', abort);
  }
}
