/**
 * 메일 설정: SMTP와 받는 사람(G§4.11 L400·L406, §8.5, data-model `mail_settings`·`mail_recipients`).
 *
 * - SMTP 설정은 한 줄(singleton)이다. 편집 버전은 `settings_version`이다.
 *   연결 확인 결과(status·checked_at·error)는 같은 줄에 적지만 편집 버전을 올리지 않는다.
 *   왜: 수정 폼을 열어 둔 채 「연결 확인」을 눌렀다고 저장이 충돌(409)이 되면 안 된다.
 * - 받는 사람 주소는 대소문자를 무시하고 하나만 둔다(DB 고유 인덱스 `recipient_email_lower`).
 * - 일간·주간 구독을 모두 끄면 자동으로 중지된다(G L400). 구독 없이 「받는 중」은 될 수 없다(DB 검사 `recipient_schedule`).
 * - Q-13 결정 A: 외부 수신자(`external`)는 보고용 보기 · PDF 첨부로 고정이고 일간을 받지 않는다(DB 검사 `recipient_external`).
 *   왜 일간을 막나: 일간 보고서는 팀장용(Task ID 등 내부 용어 포함)만 있다(G L402, PDF도 팀장용만).
 */
import type { PoolClient } from '@awbs/db';
import { ApiError, assertSameVersion, invalid } from '../changes/http.ts';
import { deferChange, iso } from '../changes/events.ts';
import { readSmtpPassword, SMTP_SECRET, storeSmtpPassword } from './secret.ts';
import { syncMailAlert } from './queue.ts';
import { checkSmtp, DEFAULT_TIMEOUT_MS, SMTP_SECURITY, type SmtpSecurity, type SmtpTarget } from './smtp.ts';

export interface SmtpView {
  host: string; port: number; sec: string; from: string; user: string; pwSet: boolean; updatedAt: string | null;
  /** 마지막 연결 확인(없으면 null). 화면의 「정상 / 실패 · 확인 시각」과 실패 배너가 쓴다. */
  check: { ok: boolean; checkedAt: string; error: string | null } | null;
}
export interface SmtpInput { updatedAt: string | null; host: string; port: number; sec: string; from: string; user: string; password?: string }

/** 아직 저장하지 않았을 때 보이는 값(P MAIL 빈 설정: STARTTLS 587) */
const BLANK = { host: '', port: 587, sec: 'STARTTLS', from: '', user: '' };

export async function getSmtp(client: PoolClient): Promise<SmtpView> {
  const row = (await client.query<{ host: string | null; port: number | null; security: string | null; from: string | null; user: string | null; pwSet: boolean;
    updatedAt: string | null; status: string | null; checkedAt: string | null; error: string | null }>(
    `select host,port,security,"from","user",secret_key is not null "pwSet",${iso('settings_version')} "updatedAt",
      status,${iso('checked_at')} "checkedAt",error from mail_settings`)).rows[0];
  if (!row) return { ...BLANK, pwSet: false, updatedAt: null, check: null };
  return {
    host: row.host ?? '', port: row.port ?? BLANK.port, sec: row.security ?? BLANK.sec, from: row.from ?? '', user: row.user ?? '', pwSet: row.pwSet,
    updatedAt: row.updatedAt,
    check: row.checkedAt && row.status ? { ok: row.status === 'ok', checkedAt: row.checkedAt, error: row.error } : null,
  };
}

const isSecurity = (v: string): v is SmtpSecurity => (SMTP_SECURITY as readonly string[]).includes(v);

export async function putSmtp(client: PoolClient, body: SmtpInput): Promise<SmtpView> {
  await client.query("select pg_advisory_xact_lock(hashtextextended('settings:mail',0))");
  await client.query('select id from mail_settings where singleton for update');
  const before = await getSmtp(client);
  await assertSameVersion(client, before.updatedAt, body.updatedAt, { current: before });
  const errors = [];
  if (!isSecurity(body.sec)) errors.push({ path: 'sec', rule: 'enum', message: `보안 방식은 ${SMTP_SECURITY.join(' · ')} 중 하나입니다.` });
  if (!body.host.trim()) errors.push({ path: 'host', rule: 'required', message: 'SMTP 서버를 입력하세요.' });
  if (!body.from.trim()) errors.push({ path: 'from', rule: 'required', message: '보내는 주소를 입력하세요.' });
  if (errors.length) throw invalid(errors);
  const unchanged = body.password === undefined && before.updatedAt !== null
    && before.host === body.host.trim() && before.port === body.port && before.sec === body.sec && before.from === body.from.trim() && before.user === body.user.trim();
  if (unchanged) return before;
  if (body.password !== undefined) await storeSmtpPassword(client, body.password);
  // 설정이 바뀌면 이전 연결 확인 결과는 더 이상 맞지 않는다. 「확인 전」으로 되돌린다.
  await client.query(`insert into mail_settings(singleton,host,port,security,"from","user",secret_key,settings_version) values(true,$1,$2,$3,$4,$5,$6,clock_timestamp())
    on conflict(singleton) do update set host=excluded.host,port=excluded.port,security=excluded.security,"from"=excluded."from","user"=excluded."user",
      secret_key=coalesce(excluded.secret_key,mail_settings.secret_key),status=null,checked_at=null,error=null,
      settings_version=greatest(clock_timestamp(),mail_settings.settings_version+interval '1 microsecond')`,
  [body.host.trim(), body.port, body.sec, body.from.trim(), body.user.trim(), body.password === undefined ? null : SMTP_SECRET]);
  deferChange(client, null, 'mail', { key: 'smtp' });
  return getSmtp(client);
}

/** worker·연결 확인이 쓰는 SMTP 대상. 서버가 없으면 null */
export async function smtpTarget(client: PoolClient): Promise<(SmtpTarget & { from: string }) | null> {
  const s = await getSmtp(client);
  if (!s.host || !isSecurity(s.sec)) return null;
  return { host: s.host, port: s.port, sec: s.sec, user: s.user, password: await readSmtpPassword(client), from: s.from };
}

/** 연결 확인(G L406 「연결 확인」). 결과를 설정 줄에 적는다. 편집 버전은 그대로다. */
export async function checkSmtpSettings(client: PoolClient, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // 확인을 시작한 설정 버전. 확인하는 동안 설정이 바뀌면 결과를 버린다(리뷰 지적 5).
  // 왜: 연결 확인 결과는 확인한 서버 · 계정에만 맞다. 옛 서버의 「정상」이 새 서버에 붙으면 안 된다.
  const version = (await getSmtp(client)).updatedAt;
  const target = await smtpTarget(client);
  let result = target ? await checkSmtp(target, timeoutMs) : { ok: false, error: 'SMTP 서버가 설정되지 않았습니다. 「SMTP 설정」에서 먼저 저장하세요.' };
  const stored = await client.query<{ at: string }>(`update mail_settings set status=$1,error=$2,checked_at=clock_timestamp()
    where settings_version is not distinct from $3::timestamptz returning ${iso('checked_at')} at`, [result.ok ? 'ok' : 'failed', result.error, version]);
  const exists = (await client.query('select 1 from mail_settings')).rowCount;
  if (exists && !stored.rowCount) result = { ok: false, error: '연결을 확인하는 동안 SMTP 설정이 바뀌었습니다 — 바뀐 설정으로 다시 확인하세요.' };
  const at = stored.rows[0]?.at;
  deferChange(client, null, 'mail', { key: 'smtp' });
  return { ok: result.ok, checkedAt: at ?? (await client.query<{ at: string }>(`select ${iso('clock_timestamp()')} at`)).rows[0]?.at ?? new Date().toISOString(), error: result.error };
}

/* ---- 받는 사람 ---- */

export interface Recipient { id: string; email: string; name: string; daily: boolean; weekly: boolean; view: 'int' | 'ext'; pdf: boolean; external: boolean; active: boolean; createdAt: string; updatedAt: string }
const RECIPIENT = `id,email,name,daily,weekly,view,pdf,external,active,${iso('created_at')} "createdAt",${iso('updated_at')} "updatedAt"`;

export async function listRecipients(client: PoolClient) {
  return { items: (await client.query<Recipient>(`select ${RECIPIENT} from mail_recipients order by created_at,id`)).rows };
}

const noSubscription = () => invalid([
  { path: 'daily', rule: 'oneOf', message: '일간 · 주간 중 하나 이상을 고르세요.' },
  { path: 'weekly', rule: 'oneOf', message: '일간 · 주간 중 하나 이상을 고르세요.' },
], '받을 보고서를 하나 이상 고르세요.');

/**
 * 외부 수신자 설정 검사(Q-13 결정 A). 어긋나는 칸마다 오류 하나. 문제가 없으면 빈 목록.
 * 왜 조용히 고치지 않나: 팀장이 「일간」을 켜 달라고 보냈는데 서버가 몰래 끄면 받을 줄 알았던 메일이 오지 않는다.
 */
function externalProblems(next: { daily: boolean; view: 'int' | 'ext'; pdf: boolean }) {
  const errors = [];
  if (next.daily) errors.push({ path: 'daily', rule: 'external', message: '외부 수신자는 일간 보고를 받을 수 없습니다 — 일간 보고서는 팀장용만 있습니다.' });
  if (next.view !== 'ext') errors.push({ path: 'view', rule: 'external', message: '외부 수신자는 보고용으로만 받습니다.' });
  if (!next.pdf) errors.push({ path: 'pdf', rule: 'external', message: '외부 수신자에게는 PDF를 항상 첨부합니다 — 링크 대신 PDF로 전체 내용을 봅니다.' });
  return errors;
}
const externalInvalid = (errors: ReturnType<typeof externalProblems>) => invalid(errors, errors[0]?.message ?? '외부 수신자 설정이 올바르지 않습니다.');

export async function addRecipient(client: PoolClient, body: { email: string; name: string; daily: boolean; weekly: boolean; view: 'int' | 'ext'; pdf: boolean; external?: boolean }) {
  const email = body.email.trim();
  const external = body.external ?? false;
  // P Sel.mailOk L4045: 최상위 도메인 2글자 이상
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw invalid([{ path: 'email', rule: 'format', message: '이메일 주소 형식이 올바르지 않습니다.' }]);
  if (!body.daily && !body.weekly) throw noSubscription();
  if (external) {
    const errors = externalProblems(body);
    if (errors.length) throw externalInvalid(errors);
  }
  const row = (await client.query<Recipient>(`insert into mail_recipients(email,name,active,daily,weekly,pdf,view,external) values($1,$2,true,$3,$4,$5,$6,$7)
    on conflict do nothing returning ${RECIPIENT}`, [email, body.name.trim(), body.daily, body.weekly, body.pdf, body.view, external])).rows[0];
  if (!row) throw new ApiError('RECIPIENT_DUPLICATE', { email }, [{ path: 'email', rule: 'unique', message: '이미 등록된 주소입니다(대소문자 무시).' }], '이미 등록된 받는 사람입니다.');
  deferChange(client, null, 'mail', { key: 'recipients' });
  return row;
}

async function lockRecipient(client: PoolClient, id: string): Promise<Recipient> {
  const row = (await client.query<Recipient>(`select ${RECIPIENT} from mail_recipients where id=$1 for update`, [id])).rows[0];
  if (!row) throw new ApiError('NOT_FOUND', { resource: 'recipient', id }, [], '받는 사람을 찾을 수 없습니다.');
  return row;
}

export async function updateRecipient(client: PoolClient, id: string, body: { updatedAt: string; daily?: boolean; weekly?: boolean; view?: 'int' | 'ext'; pdf?: boolean; external?: boolean; active?: boolean }) {
  const before = await lockRecipient(client, id);
  await assertSameVersion(client, before.updatedAt, body.updatedAt, { current: before });
  const external = body.external ?? before.external;
  const next = { daily: body.daily ?? before.daily, weekly: body.weekly ?? before.weekly, view: body.view ?? before.view, pdf: body.pdf ?? before.pdf, active: body.active ?? before.active };
  if (external) {
    // 「외부」로 바꿀 때 함께 보내지 않은 칸은 외부 규칙대로 맞춘다: 일간 끔 · 보고용 · PDF 첨부.
    // 왜: 화면의 「외부」 단추 하나로 바꿀 수 있어야 한다. 함께 보낸 칸이 규칙과 어긋나면 고치지 않고 400으로 알린다.
    if (!before.external) {
      if (body.daily === undefined) next.daily = false;
      if (body.view === undefined) next.view = 'ext';
      if (body.pdf === undefined) next.pdf = true;
    }
    const errors = externalProblems(next);
    if (errors.length) throw externalInvalid(errors);
  }
  // 둘 다 끄면 자동 중지(G L400). 구독 없이 다시 받기는 거부한다.
  if (!next.daily && !next.weekly) {
    if (body.active === true) throw noSubscription();
    next.active = false;
  }
  // 구독을 다시 켜면 받는 중으로 돌아간다(P setRecip: 원본도 구독 변경 시 active를 다시 계산한다)
  else if (body.active === undefined && !before.daily && !before.weekly) next.active = true;
  const row = (await client.query<Recipient>(`update mail_recipients set daily=$2,weekly=$3,view=$4,pdf=$5,active=$6,external=$7 where id=$1 returning ${RECIPIENT}`,
    [id, next.daily, next.weekly, next.view, next.pdf, next.active, external])).rows[0];
  deferChange(client, null, 'mail', { key: 'recipients' });
  return row;
}

/** 삭제해도 발송 기록은 주소와 함께 남는다(G L407). 큐 행은 수신자 FK가 없어 그대로다. */
export async function deleteRecipient(client: PoolClient, id: string, updatedAt: string) {
  const before = await lockRecipient(client, id);
  await assertSameVersion(client, before.updatedAt, updatedAt, { current: before });
  await client.query('delete from mail_recipients where id=$1', [id]);
  deferChange(client, null, 'mail', { key: 'recipients' });
  // 삭제한 사람의 실패는 더 이상 다시 보낼 대상이 아니다. 대시보드 알림 건수를 다시 맞춘다(리뷰 지적 3).
  const projectId = (await client.query<{ id: string }>('select id from projects limit 1')).rows[0]?.id ?? null;
  await syncMailAlert(client, projectId);
}
