import type { Pool, PoolClient } from '@awbs/db';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deferChange, dropChanges, flushChanges } from '../changes/events.ts';
import { inEpoch } from '../platform/transaction.ts';
import { callBot, botOf, type BotResult } from './bot.ts';
import { currentProject, getAppUrl, type NotifyPayload } from './service.ts';
import { fingerprint, readToken, tokenKey } from './secrets.ts';
import { message } from './message.ts';

interface Delivery { id: string; project_id: string | null; delivery_id: string; kind: 'biz' | 'test'; attempts: number; payload: NotifyPayload; error: string | null }
export const ERROR_TEXT = {
  token_invalid: '토큰 오류(401) — BotFather에서 토큰을 확인하세요.',
  chat_not_found: '대화 없음(400) — Chat ID와 봇의 시작 여부를 확인하세요.',
  forbidden: '전송 권한 없음 · 봇 차단(403) — 차단 해제 또는 그룹 재초대 후 테스트하세요.',
  rate_limited: '요청 제한(429) — 재시도 대기', network: '통신 실패 — 네트워크를 확인하세요.',
  webhook_in_use: 'Webhook 사용 중 — 해제하지 않습니다. Chat ID를 직접 입력하세요.',
  chat_migrated: '수신 대상 변경 필요 — 새 Chat ID를 입력하고 테스트 후 저장하세요.',
};

export async function statusAlert(db: PoolClient, projectId: string | null, result: BotResult) {
  if (result.ok) {
    await db.query("update alerts set resolved_at=clock_timestamp() where key='telegram-connection' and resolved_at is null");
  } else {
    await db.query(`insert into alerts(project_id,key,severity,target) values($1,'telegram-connection','error',$2)
      on conflict (coalesce(project_id::text,'global'),key) where resolved_at is null do update set target=excluded.target,acknowledged_at=null`,
    [projectId, JSON.stringify({ key: 'notify', message: `Telegram ${ERROR_TEXT[result.error ?? 'network']}`, path: '/settings/notify' })]);
  }
  deferChange(db, projectId, 'alert', { key: 'telegram-connection' });
}

/** 한 번에 한 건을 보낸다. sending은 외부 호출 전에 별도 커밋한다(contracts §4.4). */
export async function processNotify(pool: Pool, epoch: number, now = new Date(), onlyId?: string): Promise<BotResult | null> {
  const lock = await pool.connect();
  try {
    const acquired = (await lock.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtextextended('notify:worker',0)) ok")).rows[0]?.ok;
    if (!acquired) return null;
    try {
      const row = await inEpoch(pool, epoch, async db => {
        const found = (await db.query<Delivery & { state: string }>(`select * from notify_outbox where epoch=$1 and ($3::uuid is null or id=$3)
          and ((state in ('queued','retry_wait') and (next_at is null or next_at<=$2)) or (state='sending' and updated_at<$2::timestamptz-interval '30 seconds'))
          order by created_at,id for update skip locked limit 1`, [epoch, now, onlyId ?? null])).rows[0];
        if (!found) return null;
        const gap = found.payload.chatId.startsWith('-') ? 3000 : 1000;
        const last = (await db.query<{ at: Date | null }>(`select max(l.at) at from notify_log l join notify_outbox o on o.delivery_id=l.delivery_id
          where o.payload->>'chatId'=$1 and l.state='sending'`, [found.payload.chatId])).rows[0]?.at;
        const due = last ? new Date(last.getTime() + gap) : now;
        if (due > now) { await db.query('update notify_outbox set next_at=$2 where id=$1', [found.id, due]); return null; }
        const ambiguous = found.state === 'sending' || found.error?.includes('중복 도착 가능');
        if (found.attempts >= 5) {
          await db.query("update notify_outbox set state='unknown',error='network:수락 여부 불명 — 중복 도착 가능' where id=$1", [found.id]);
          await db.query("insert into notify_log(project_id,delivery_id,kind,state,error,at) values($1,$2,$3,'unknown','수락 여부 불명 — 중복 도착 가능',$4)", [found.project_id, found.delivery_id, found.kind, now]);
          await statusAlert(db, found.project_id, { ok: false, error: 'network', retryAfter: null });
          deferChange(db, found.project_id, 'notify', { id: found.id });
          return null;
        }
        await db.query("update notify_outbox set state='sending',attempts=attempts+1,error=$2 where id=$1", [found.id, ambiguous ? 'network:응답 유실 또는 중단 — 중복 도착 가능' : null]);
        await db.query("insert into notify_log(project_id,delivery_id,kind,state,error,at) values($1,$2,$3,'sending',$4,$5)", [found.project_id, found.delivery_id, found.kind, ambiguous ? '중복 도착 가능' : null, now]);
        return { ...found, attempts: found.attempts + 1, error: ambiguous ? '중복 도착 가능' : null };
      });
      if (!row) return null;
      // 외부 호출 동안 epoch 공유 잠금을 잡아 초기화 뒤 낡은 알림을 보내지 않게 한다.
      // 외부 호출은 inEpoch의 교착 재실행 대상에 넣지 않는다. 수락 뒤 DB 오류는 sending으로 남겨 복구한다.
      await lock.query('begin');
      try {
        const db = lock;
        await db.query('select public.lock_epoch($1)', [epoch]);
        if (!(await db.query("select 1 from notify_outbox where id=$1 and epoch=$2 and state='sending' for update", [row.id, epoch])).rowCount) { await db.query('commit'); return null; }
        let result: BotResult;
        try { result = await callBot(await readToken(db, row.payload.secretKey), 'sendMessage', { chat_id: row.payload.chatId, text: row.payload.message }); }
        catch { result = { ok: false, error: 'network', retryAfter: null }; }
        const retry = !result.ok && (result.error === 'network' || result.error === 'rate_limited');
        const state = result.ok ? 'accepted' : retry && row.attempts < 5 ? 'retry_wait' : result.error === 'network' ? 'unknown' : 'failed';
        const ambiguous = row.error || result.error === 'network' ? ' — 중복 도착 가능' : '';
        const error = result.ok ? ambiguous || null : `${result.error}:${ERROR_TEXT[result.error ?? 'network']}${ambiguous}`;
        const next = state === 'retry_wait' ? new Date(Math.max(now.getTime(), Date.now()) + (result.retryAfter ?? Math.min(60, 2 ** row.attempts)) * 1000) : null;
        await db.query('update notify_outbox set state=$2,error=$3,next_at=$4 where id=$1', [row.id, state, error, next]);
        if (row.kind === 'test') {
          await db.query('update notify_settings set test_fingerprint=$1 where secret_key=$2 and chat_id=$3', [result.ok ? row.payload.fingerprint : null, row.payload.secretKey, row.payload.chatId]);
        }
        await db.query('insert into notify_log(project_id,delivery_id,kind,state,error,at) values($1,$2,$3,$4,$5,$6)', [row.project_id, row.delivery_id, row.kind, state, error, now]);
        if (!result.ok || row.kind === 'test') await statusAlert(db, row.project_id, result);
        deferChange(db, row.project_id, 'notify', { id: row.id });
        await flushChanges(db);
        await db.query('commit');
        return { ok: result.ok, error: result.error, retryAfter: result.retryAfter };
      } catch (error) {
        dropChanges(lock);
        await lock.query('rollback');
        throw error;
      }
    } finally { await lock.query("select pg_advisory_unlock(hashtextextended('notify:worker',0))"); }
  } finally { lock.release(); }
}

export async function sendTest(pool: Pool, epoch: number, input: { botToken?: string; chatId: string; targetName: string }) {
  const id = randomUUID();
  // 테스트 초안도 서버에만 암호화한다. 설정 저장은 별도 동작이다.
  await inEpoch(pool, epoch, async db => {
    const key = await tokenKey(db, input.botToken), project = await currentProject(db);
    const bot = botOf(await callBot(await readToken(db, key), 'getMe'));
    const payload: NotifyPayload = { secretKey: key, chatId: input.chatId, targetName: input.targetName, fingerprint: fingerprint(key, input.chatId),
      event: null, target: '연결 테스트', path: '/settings/notify', bot,
      message: message({ event: null, project: project?.name ?? '설정 전', target: '연결 테스트', state: '테스트 알림', path: '/settings/notify', at: new Date().toISOString() }, (await getAppUrl(db)).appUrl) };
    await db.query("insert into notify_outbox(id,project_id,delivery_id,epoch,state,payload,kind) values($1,$2,$1,$3,'queued',$4,'test')", [id, project?.id ?? null, epoch, payload]);
    await db.query('update notify_settings set test_fingerprint=null where secret_key=$1 and chat_id=$2', [key, input.chatId]);
    deferChange(db, project?.id ?? null, 'notify', { id });
  });
  let result = await processNotify(pool, epoch, new Date(), id);
  if (!result) {
    const next = (await pool.query<{ next_at: Date | null }>('select next_at from notify_outbox where id=$1', [id])).rows[0]?.next_at;
    if (next) {
      await delay(Math.max(0, Math.min(3010, Math.ceil(next.getTime() - Date.now()) + 10)));
      result = await processNotify(pool, epoch, new Date(), id);
    }
  }
  return { ...(result ?? { ok: false, error: 'rate_limited' as const, retryAfter: 3 }), testId: id };
}

export function startNotifyWorker(pool: Pool, onError: (error: unknown) => void) {
  let running: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = pool.query<{ epoch: number }>('select epoch from system_state where id=1')
      .then(row => processNotify(pool, row.rows[0]?.epoch ?? 0)).catch(onError).finally(() => { running = undefined; });
  }, 1000);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}
