import type { PoolClient } from '@awbs/db';
import { assertSameVersion, ApiError, invalid } from '../changes/http.ts';
import { deferChange, iso } from '../changes/events.ts';
import { decodeTimeIdCursor, encodeCursor, DEFAULT_LIMIT, MAX_LIMIT } from '../changes/history.ts';
import { fingerprint, tokenKey } from './secrets.ts';
import { DEFAULT_RULES, EVENTS, message, type NotifyEvent } from './message.ts';
import type { Bot, TelegramError } from './bot.ts';

type Db = Pick<PoolClient, 'query'>;
export interface NotifyPayload {
  secretKey: string; chatId: string; targetName: string; fingerprint: string;
  message: string; event: NotifyEvent | null; target: string; path: string; bot: Bot | null;
}
export const currentProject = async (db: Db) => (await db.query<{ id: string; name: string }>('select id,name from projects limit 1')).rows[0] ?? null;
export async function requireProject(db: Db, id: string) {
  const project = await currentProject(db);
  if (!project || project.id !== id) throw new ApiError('PROJECT_NOT_FOUND');
  return project;
}

export async function testOf(db: Db, fp: string | null, id?: string) {
  return (await db.query<{ state: string; error: string | null; payload: NotifyPayload; at: string }>(
    `select state,error,payload,${iso('updated_at')} at from notify_outbox where kind='test'
     and epoch=(select epoch from system_state where id=1) and (($2::uuid is not null and id=$2) or ($2::uuid is null and payload->>'fingerprint'=$1))
     order by created_at desc,id desc limit 1`, [fp, id ?? null])).rows[0] ?? null;
}

export async function getTelegram(db: Db, testId?: string) {
  const row = (await db.query<{ enabled: boolean; chat_id: string | null; target_name: string | null; bot: Bot | null; secret_key: string | null; test_fingerprint: string | null; tokenLast4: string | null; updatedAt: string }>(
    `select n.enabled,n.chat_id,n.target_name,n.bot,n.secret_key,n.test_fingerprint,s.last4 "tokenLast4",${iso('n.updated_at')} "updatedAt"
     from notify_settings n left join secrets s on s.key=n.secret_key where n.singleton`)).rows[0];
  const fp = row?.secret_key && row.chat_id ? fingerprint(row.secret_key, row.chat_id) : null;
  const proof = testId || fp ? await testOf(db, fp, testId) : null;
  const retained = !testId && !!row?.secret_key && !!row.chat_id && row.test_fingerprint === fingerprint(row.secret_key, row.chat_id);
  const error = proof?.state === 'accepted' ? null : proof?.error?.split(':')[0] as TelegramError | undefined;
  return { enabled: row?.enabled ?? false, chatId: row?.chat_id ?? null, targetName: row?.target_name ?? '', tokenSet: !!row?.secret_key,
    tokenLast4: row?.tokenLast4 ?? null, bot: row?.bot ?? null,
    chat: row?.chat_id ? { chatId: row.chat_id, title: row.target_name ?? '', type: row.chat_id.startsWith('-') ? 'group' : 'private' } : null,
    test: proof ? { ok: proof.state === 'accepted', error: error ?? null, at: proof.at } : retained ? { ok: true, error: null, at: row.updatedAt } : null, updatedAt: row?.updatedAt ?? null };
}

export async function putTelegram(db: PoolClient, body: { enabled: boolean; chatId: string; targetName: string; botToken?: string; updatedAt: string | null }) {
  await db.query("select pg_advisory_xact_lock(hashtextextended('settings:telegram',0))");
  const before = await getTelegram(db);
  await assertSameVersion(db, before.updatedAt, body.updatedAt, { current: before });
  if (!body.targetName.trim()) throw invalid([{ path: 'targetName', rule: 'required', message: '수신 대상 이름을 입력하세요.' }]);
  const key = await tokenKey(db, body.botToken);
  const fp = fingerprint(key, body.chatId), proof = await testOf(db, fp);
  const retained = !proof && !!(await db.query('select 1 from notify_settings where test_fingerprint=$1 and secret_key=$2 and chat_id=$3', [fp, key, body.chatId])).rowCount;
  const tested = proof?.state === 'accepted' || retained;
  if (body.enabled && !tested) throw invalid([{ path: 'enabled', rule: 'tested', message: '현재 토큰과 Chat ID로 테스트 알림을 먼저 보내세요.' }]);
  await db.query(`insert into notify_settings(singleton,enabled,chat_id,target_name,bot,test_fingerprint,secret_key) values(true,$1,$2,$3,$4,$5,$6)
    on conflict(singleton) do update set enabled=excluded.enabled,chat_id=excluded.chat_id,target_name=excluded.target_name,bot=excluded.bot,test_fingerprint=excluded.test_fingerprint,secret_key=excluded.secret_key`,
  [body.enabled, body.chatId, body.targetName, proof?.payload.bot ?? (retained ? before.bot : null), tested ? fp : null, key]);
  deferChange(db, null, 'notify', { key: 'telegram' });
  deferChange(db, null, 'settings', { key: 'telegram' });
  return getTelegram(db);
}

export async function getRules(db: Db, projectId: string) {
  await requireProject(db, projectId);
  const rows = (await db.query<{ key: NotifyEvent; enabled: boolean }>('select key,enabled from notify_rules')).rows;
  const version = (await db.query<{ at: string | null }>(`select ${iso('max(updated_at)')} at from notify_rules`)).rows[0]?.at ?? null;
  return { ...DEFAULT_RULES, ...Object.fromEntries(rows.map(r => [r.key, r.enabled])), updatedAt: version };
}

export async function putRules(db: PoolClient, projectId: string, body: typeof DEFAULT_RULES & { updatedAt: string | null }) {
  await db.query("select pg_advisory_xact_lock(hashtextextended('settings:notify-rules',0))");
  const before = await getRules(db, projectId);
  await assertSameVersion(db, before.updatedAt, body.updatedAt, { current: before });
  for (const key of Object.keys(DEFAULT_RULES) as NotifyEvent[]) {
    await db.query('insert into notify_rules(key,enabled) values($1,$2) on conflict(key) do update set enabled=excluded.enabled', [key, body[key]]);
  }
  deferChange(db, projectId, 'notify', { key: 'rules' });
  return getRules(db, projectId);
}

export async function getAppUrl(db: Db) {
  const row = (await db.query<{ appUrl: string | null; updatedAt: string | null }>(`select app_url "appUrl",${iso('updated_at')} "updatedAt" from app_settings where singleton`)).rows[0];
  return row ?? { appUrl: null, updatedAt: null };
}
export async function putAppUrl(db: PoolClient, body: { appUrl: string | null; updatedAt: string | null }) {
  await db.query('select id from app_settings where singleton for update');
  const before = await getAppUrl(db);
  await assertSameVersion(db, before.updatedAt, body.updatedAt, { current: before });
  if (body.appUrl !== null) {
    let url: URL;
    try { url = new URL(body.appUrl); } catch { throw invalid([{ path: 'appUrl', rule: 'format', message: 'HTTP 또는 HTTPS 주소를 입력하세요.' }]); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || body.appUrl.length > 1000) {
      throw invalid([{ path: 'appUrl', rule: 'format', message: '사용자 정보·질의·조각이 없는 HTTP 또는 HTTPS 주소를 입력하세요.' }]);
    }
  }
  await db.query('update app_settings set app_url=$1 where singleton', [body.appUrl]);
  deferChange(db, null, 'settings', { key: 'app-url' });
  deferChange(db, null, 'notify', { key: 'app-url' });
  return getAppUrl(db);
}

export async function preview(db: Db, projectId: string, event: NotifyEvent) {
  const project = await requireProject(db, projectId), { appUrl } = await getAppUrl(db);
  return { text: message({ event, project: project.name, target: event.startsWith('build') ? '② 통합 확인 — PR #9' : event === 'admin' ? 'Runner 준비 상태' : 'TASK-0001',
    state: event === 'buildFail' ? '실패 — 실패 단계: E2E' : `${EVENTS[event]} (예시)`, path: event.startsWith('build') ? '/ci/CI-0127' : event === 'admin' ? '/settings/runner' : '/wbs/TASK-0001', at: new Date().toISOString() }, appUrl) };
}

export async function notifyLog(db: Db, projectId: string, query: { kind?: 'biz' | 'test'; cursor?: string; limit?: number }, id?: string) {
  await requireProject(db, projectId);
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = query.cursor ? decodeTimeIdCursor(query.cursor) : null;
  if (query.cursor && !cursor) throw invalid([{ path: 'cursor', rule: 'format', message: '다음 페이지 정보가 올바르지 않습니다.' }]);
  const rows = (await db.query<{ id: string; at: string; kind: 'biz' | 'test'; event: NotifyEvent | null; target: string; state: string; attempts: number; duplicates: number; error: string | null; message: string }>(
    `select o.id,${iso('o.created_at')} at,o.kind,o.payload->>'event' event,coalesce(o.payload->>'target','') target,o.state,o.attempts,coalesce(e.dup_count,0) duplicates,o.error${id ? ",coalesce(o.payload->>'message','') message" : ''},
       o.payload->>'path' path,o.payload->>'targetName' "targetName",o.payload->>'chatId' "chatId",(select name from projects where id=o.project_id) "projectName"
     from notify_outbox o left join notify_events e on e.id=o.event where o.project_id=$1 and ($2::text is null or o.kind=$2)
       and ($3::uuid is null or o.id=$3) and ($4::timestamptz is null or (o.created_at,o.id)<($4::timestamptz,$5::uuid))
     order by o.created_at desc,o.id desc limit $6`, [projectId, query.kind ?? null, id ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1])).rows;
  if (id) { if (!rows[0]) throw new ApiError('NOT_FOUND'); return rows[0]; }
  const page = rows.slice(0, limit), last = page.at(-1);
  return { items: page, nextCursor: rows.length > limit && last ? encodeCursor([last.at, last.id]) : null };
}
