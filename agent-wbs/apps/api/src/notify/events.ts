import type { PoolClient } from '@awbs/db';

/** 새 실패 보고만 센다. 알림 저장 실패가 Runner 보고까지 되돌리지 않도록 부분 취소점을 둔다. */
export async function repeatFailure(db: Pick<PoolClient, 'query'>, key: string) {
  await db.query('savepoint notify_repeat');
  try {
    await db.query(`update notify_events set dup_count=dup_count+1
      where coalesce(project_id::text,'global')=(select id::text from projects limit 1)
        and dedup_key=$1 and resolved_at is null`, [key]);
  } catch {
    await db.query('rollback to savepoint notify_repeat');
  } finally { await db.query('release savepoint notify_repeat'); }
}
