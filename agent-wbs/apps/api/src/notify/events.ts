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

/** Telegram 알림 한 건(M6·M7 통합). 대상·상태 문구는 메시지 본문에 그대로 들어간다. */
export interface NotifyEmit {
  project: string;
  kind: 'done' | 'fail' | 'admin' | 'approve' | 'buildOk' | 'buildFail' | 'serviceDown';
  key: string;
  target: string;
  path: string;
  state: string;
  /** notify_events.ref에 더할 근거(path는 자동으로 넣는다). */
  ref?: object;
  /** 알림 규칙과 무관하게 보낸다(serviceDown, M7-03 결정 11). */
  anyRule?: boolean;
}

/**
 * 알림 기록(notify_events)과 Telegram 발송 대기열(notify_outbox)을 같은 트랜잭션에서 함께 만든다(0036 awbs_notify_emit).
 * 왜: M7 CI 코드가 notify_events만 직접 넣으면 기록은 남아도 Telegram으로는 나가지 않는다. 상태 전이 트리거(M6-04)와 같은 함수를 쓴다.
 * 알림이 꺼져 있거나(연결 미설정 포함) 규칙이 꺼져 있으면 아무것도 남기지 않는다. 함수 안의 오류는 CI 보고를 되돌리지 않는다.
 */
export async function emitNotify(db: Pick<PoolClient, 'query'>, e: NotifyEmit) {
  await db.query('select public.awbs_notify_emit($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
    [e.project, e.kind, e.key, e.target, e.path, e.state, JSON.stringify(e.ref ?? {}), e.anyRule ?? false]);
}
