import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from '@awbs/db';
import { inEpoch } from '../platform/transaction.ts';

export const DATA_ROOT = join(homedir(), '.agentwbs', 'wbs');

/** DB에 적힌 경로도 신뢰하지 않는다. 현재 세대의 일반 파일만 읽고 링크를 따라가지 않는다. */
export async function readStoredFile(root: string, epoch: number, path: string) {
  const parts = path.split('/');
  if (parts[0] !== String(epoch) || parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) throw new Error('잘못된 파일 경로');
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('링크 파일은 내보낼 수 없음');
  }
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('일반 파일이 아님');
    return await file.readFile();
  } finally { await file.close(); }
}

/** 파일 작업도 세대 공유 잠금 안에서 끝낸다. 초기화는 이 작업이 끝나야 세대를 바꿀 수 있다. */
export async function deleteFiles(pool: Pool, epoch: number, root = DATA_ROOT) {
  await inEpoch(pool, epoch, async (db) => {
    let dirs: Dirent[];
    try { dirs = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; dirs = []; }
    // 만료된 작업이 뒤늦게 만든 옛 폴더도 다음 주기에 다시 큐에 넣는다.
    for (const dir of dirs) if (/^[1-9]\d*$/.test(dir.name) && Number(dir.name) < epoch) {
      await db.query("insert into file_delete_queue(epoch,path,reason) values($1,$2,'stale-epoch') on conflict do nothing", [Number(dir.name), `${dir.name}/`]);
    }
    const rows = (await db.query<{ id: string; epoch: number; path: string }>('select id,epoch,path from file_delete_queue order by created_at for update skip locked')).rows;
    for (const row of rows) {
      try {
        if (row.epoch < 1 || row.epoch >= epoch || row.path !== `${String(row.epoch)}/`) throw new Error('경로 거부');
        await rm(join(root, String(row.epoch)), { recursive: true, force: true });
      } catch {
        await db.query("update file_delete_queue set attempts=attempts+1,last_error='파일 삭제 실패: 세대 경로와 접근 권한을 확인하세요.' where id=$1", [row.id]);
        continue;
      }
      await db.query('delete from file_delete_queue where id=$1', [row.id]);
    }
  });
}
