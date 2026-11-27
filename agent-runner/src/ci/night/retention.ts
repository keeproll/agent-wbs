import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** 근거 파일(로그 원문·스크린샷) 보관 기간(G L488, architecture §1 「기본 30일」). */
export const RETENTION_DAYS = 30;
/** 이 PC는 시계가 뒤로 몇 초씩 간다. 경계에 걸린 폴더를 성급히 지우지 않는다. */
const CLOCK_MARGIN_MS = 5_000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `<AWBS_HOME>/runs/` 아래 기간이 지난 실행 폴더를 지운다. 지운 실행 ID를 돌려준다.
 * 실행이 끝날 때 남긴 `runner/run.json`의 finishedAt으로 판단한다.
 * 끝 기록이 없는 폴더는 진행 중일 수 있어 기본으로 남긴다.
 *   - 왜: 파일 내용을 고쳐도 부모 폴더의 수정 시각은 바뀌지 않는다. 오래 걸리는 실행의 근거를 지울 수 있다.
 *   - 진행 중인 실행이 없다고 확인한 호출(예: Runner 시작 때)만 `unfinished: 'remove'`로 기간이 지난 미완료 폴더를 지운다.
 * DB에는 위치와 요약만 있으므로 서버 기록은 그대로 남는다. 빌드 결과물은 애초에 여기 두지 않는다.
 */
export async function pruneEvidence(runs: string, now: number, { days = RETENTION_DAYS, keep = new Set<string>(), unfinished = 'keep' }:
  { days?: number; keep?: ReadonlySet<string>; unfinished?: 'keep' | 'remove' } = {}): Promise<string[]> {
  const cutoff = now - days * 86_400_000 - CLOCK_MARGIN_MS;
  let names: string[];
  try { names = await readdir(runs); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names.sort()) {
    if (!RUN_ID.test(name) || keep.has(name)) continue;
    const path = join(runs, name);
    const stat = await lstat(path);
    // symlink를 따라가 바깥 파일을 지우지 않는다.
    if (!stat.isDirectory()) continue;
    let finished: number;
    try {
      const file = await open(join(path, 'runner', 'run.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let meta: { finishedAt?: unknown };
      try { meta = JSON.parse(await file.readFile('utf8')) as { finishedAt?: unknown }; } finally { await file.close(); }
      finished = typeof meta.finishedAt === 'string' ? Date.parse(meta.finishedAt) : Number.NaN;
      if (!Number.isFinite(finished)) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || unfinished === 'keep') continue;
      finished = stat.mtimeMs;
    }
    if (finished >= cutoff) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
