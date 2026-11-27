import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** 근거 파일(로그 원문·스크린샷) 보관 기간(G L488, architecture §1 「기본 30일」). */
export const RETENTION_DAYS = 30;
/** 이 PC는 시계가 뒤로 몇 초씩 간다. 경계에 걸린 폴더를 성급히 지우지 않는다. */
const CLOCK_MARGIN_MS = 5_000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `<AWBS_HOME>/runs/` 아래 기간이 지난 실행 폴더를 지운다. 지운 실행 ID를 돌려준다.
 * 실행이 끝날 때 남긴 run.json의 finishedAt으로 판단하고, 없으면(중간에 죽은 실행) 폴더 수정 시각을 쓴다.
 * DB에는 위치와 요약만 있으므로 서버 기록은 그대로 남는다. 빌드 결과물은 애초에 여기 두지 않는다.
 */
export async function pruneEvidence(runs: string, now: number, { days = RETENTION_DAYS, keep = new Set<string>() }: { days?: number; keep?: ReadonlySet<string> } = {}): Promise<string[]> {
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
      const meta = JSON.parse(await readFile(join(path, 'run.json'), 'utf8')) as { finishedAt?: unknown };
      finished = typeof meta.finishedAt === 'string' ? Date.parse(meta.finishedAt) : Number.NaN;
      if (!Number.isFinite(finished)) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      finished = stat.mtimeMs;
    }
    if (finished >= cutoff) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
