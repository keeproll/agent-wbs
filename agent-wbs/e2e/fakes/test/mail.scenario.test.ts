/**
 * M6-03 메일 시나리오(milestones M6-03 완료 조건, G§12 시나리오 25, G§4.11 L398-408, §8.5, §9.6-6 L1049-1052, contracts §2.3·§4.4).
 *
 * 준비: 빈 시험 DB → 마이그레이션 → demo seed(원본 P MOCK). 프로젝트 시작일만 원본 값으로 맞춘다.
 * - SMTP는 로컬 가짜 서버(`e2e/fakes/smtp.ts`)다. 실제 메일 서버에는 연결하지 않는다(Q-13 미결).
 * - 팀장 동작(설정·받는 사람·미리보기·발송·다시 보내기·초기화)은 실제 HTTP 요청이다.
 * - worker 동작(보고서 정기 생성·메일 발송·재시작 정리)은 worker가 부르는 같은 함수를 시각만 정해 부른다.
 * - 「수락 직후 crash」는 worker를 **별도 프로세스**로 띄우고, 가짜 SMTP가 본문을 받은 순간 SIGKILL로 죽여서 만든다.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import { externalView, internalKpis, internalTerms, type ReportSnapshotData } from '../../../packages/shared/src/index.ts';
import { createPool, recreateTestDatabase, runMigrations, seedDemo, type Pool } from '../../../packages/db/src/index.ts';
import { buildApp } from '../../../apps/api/src/app.ts';
import { issueLoginLink } from '../../../apps/api/src/platform/credentials.ts';
import { generateDueReports } from '../../../apps/api/src/reports/service.ts';
import { deliverMail, recoverMail } from '../../../apps/api/src/mail/deliver.ts';
import { checkSmtpSettings, getSmtp, putSmtp } from '../../../apps/api/src/mail/settings.ts';
import { inEpoch } from '../../../apps/api/src/platform/transaction.ts';
import { FakeSmtp, mimeHeader, mimePart } from '../smtp.ts';
import { chromiumRenderer } from '../../../apps/api/src/pdf/render.ts';
import { reportPdf } from '../../../apps/api/src/pdf/service.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
interface Log { id: string; logKey: string; reportId: string; recipientId: string | null; to: string; subject: string; view: 'int' | 'ext'; tryNo: number; state: string; error: string | null; reason: string; at: string }

const SECRET = 'fake-password';
process.env.AWBS_SECRET_KEY ??= '34'.repeat(32);

let owner: Pool;
let pool: Pool;
let dbUrl: string;
let appDbUrl: string;
let close: () => Promise<void>;
let epoch = 1;
let lead: (method: string, path: string, body?: object) => Promise<{ status: number; body: Body }>;
const smtp = new FakeSmtp();

/** 서울 날짜·시각 → UTC ISO */
const kst = (day: string, hm = '00:00') => new Date(`${day}T${hm}:00+09:00`).toISOString();
const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
/** 시험의 SMTP 응답 대기. 짧게 두어 「응답 유실」을 빨리 만든다. */
const TIMEOUT = 600;
const deliver = (now: string) => deliverMail(pool, epoch, { now, timeoutMs: TIMEOUT });
const received = (to: string) => smtp.messages.filter((m) => m.to.includes(to));

beforeAll(async () => {
  const db = new URL(inject('testDatabaseUrl'));
  db.pathname += '_mail_scenario';
  dbUrl = db.href;
  await recreateTestDatabase(db.href);
  owner = createPool(db.href, { onError: () => undefined });
  const appUrl = new URL(db);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  appDbUrl = appUrl.href;
  pool = createPool(appUrl.href, { onError: () => undefined });
  const origin = 'http://127.0.0.1:3100';
  const app = buildApp(pool, false, { origin, lan: false });
  await smtp.start();
  close = async () => { await app.close(); await pool.end(); await owner.end(); await smtp.stop(); };
  await runMigrations(owner);
  await seedDemo(owner, db.href);
  await owner.query("update projects set start_date='2026-10-27', target_date='2026-11-12'");
  await owner.query("update app_settings set app_url='http://127.0.0.1:5173/'");
  const link = await issueLoginLink(pool);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await fetch(`${baseUrl}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'link', token: link }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  const { csrfToken } = await (await fetch(`${baseUrl}/api/session`, { headers: { cookie } })).json() as { csrfToken: string };
  lead = async (method, path, body) => {
    const response = await fetch(baseUrl + path, { method, headers: { cookie, origin, 'x-csrf-token': csrfToken, 'x-project-epoch': String(epoch), 'idempotency-key': randomUUID(), ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Body };
  };
}, 60_000);
afterAll(async () => { await close(); });

const projectId = async () => (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id ?? '';
const reports = async (kind: string) => (await lead('GET', `/api/projects/${await projectId()}/reports?limit=200&kind=${kind}`)).body.items as { id: string; reportKey: string; from: string; to: string }[];
const log = async (failed = false) => (await lead('GET', `/api/mail/log?limit=200${failed ? '&status=failed' : ''}`)).body.items as Log[];
const recipients = async () => (await lead('GET', '/api/settings/mail/recipients')).body.items as { id: string; email: string; active: boolean; daily: boolean; weekly: boolean; view: string; pdf: boolean; updatedAt: string }[];
const recipient = async (email: string) => {
  const r = (await recipients()).find((x) => x.email === email);
  assert(r, `${email} 받는 사람이 없다`);
  return r;
};
const mailAlert = async () => ((await lead('GET', '/api/alerts')).body.items as { key: string; text: string }[]).find((a) => a.key === 'mail:failed');
/** HTML에서 태그를 빼고 글자만 */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');

describe('빈 상태(시나리오 25 「승인 직후 · 기록 없음」)', () => {
  test('SMTP 미설정 · 받는 사람 없음 · 발송 기록 없음', async () => {
    const s = await lead('GET', '/api/settings/mail/smtp');
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ host: '', port: 587, sec: 'STARTTLS', from: '', user: '', pwSet: false, updatedAt: null, check: null });
    expect(await recipients()).toEqual([]);
    expect(await log()).toEqual([]);
    expect(await mailAlert()).toBeUndefined();
  });

  test('SMTP가 없으면 연결 확인은 실패로 답한다(연결을 시도하지 않음)', async () => {
    const before = smtp.connections;
    const r = await lead('POST', '/api/settings/mail/smtp/check');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('SMTP 서버가 설정되지 않았습니다');
    expect(smtp.connections).toBe(before);
  });
});

describe('SMTP 설정(G L406, §9.6-6 7: 비밀번호는 쓰기 전용)', () => {
  test('저장하면 비밀번호는 응답·조회·DB 평문 어디에도 없다', async () => {
    const r = await lead('PUT', '/api/settings/mail/smtp', { updatedAt: null, host: '127.0.0.1', port: smtp.port, sec: '없음', from: 'Agent WBS <agent-wbs@example.com>', user: 'agent-wbs', password: SECRET });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ host: '127.0.0.1', port: smtp.port, sec: '없음', from: 'Agent WBS <agent-wbs@example.com>', user: 'agent-wbs', pwSet: true });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const g = await lead('GET', '/api/settings/mail/smtp');
    expect(JSON.stringify(g.body)).not.toContain(SECRET);
    expect(g.body.updatedAt).toBe(r.body.updatedAt);
    const dump = JSON.stringify((await owner.query('select * from mail_settings')).rows) + JSON.stringify((await owner.query('select * from secrets')).rows);
    expect(dump).not.toContain(SECRET);
  });

  test('본 버전이 낡으면 409 VERSION_CONFLICT, 비밀번호를 빼고 저장하면 저장된 비밀번호를 유지한다', async () => {
    const stale = await lead('PUT', '/api/settings/mail/smtp', { updatedAt: '2020-01-01T00:00:00.000000Z', host: '127.0.0.1', port: smtp.port, sec: '없음', from: 'x@example.com', user: 'agent-wbs' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const current = (await lead('GET', '/api/settings/mail/smtp')).body;
    const keep = await lead('PUT', '/api/settings/mail/smtp', { updatedAt: current.updatedAt, host: current.host, port: current.port, sec: current.sec, user: current.user, from: 'Agent WBS <agent-wbs@example.com>' });
    expect(keep.status).toBe(200);
    expect(keep.body.pwSet).toBe(true);
    const check = await lead('POST', '/api/settings/mail/smtp/check');
    expect(check.body).toMatchObject({ ok: true, error: null });
  });

  test('알 수 없는 보안 방식은 400', async () => {
    const current = (await lead('GET', '/api/settings/mail/smtp')).body;
    const r = await lead('PUT', '/api/settings/mail/smtp', { updatedAt: current.updatedAt, host: '127.0.0.1', port: smtp.port, sec: 'TLS1.0', from: 'a@example.com', user: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.errors[0].path).toBe('sec');
  });

  test('연결 확인: 인증 실패(535)는 원인과 함께 실패로 남고 설정 화면이 그 결과를 읽는다', async () => {
    smtp.mode = 'auth_fail';
    const r = await lead('POST', '/api/settings/mail/smtp/check');
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('535');
    expect(r.body.error).not.toContain(SECRET);
    smtp.mode = 'accept';
    expect((await lead('POST', '/api/settings/mail/smtp/check')).body.ok).toBe(true);
  });
});

describe('받는 사람(시나리오 25: 잘못된 형식 · 중복 · 구독 없음 → qa@example.com 일간 추가)', () => {
  test('형식이 틀리면 400, 구독이 없으면 400, 대소문자만 다른 중복은 409 RECIPIENT_DUPLICATE', async () => {
    const bad = await lead('POST', '/api/settings/mail/recipients', { email: 'qa@', name: '', daily: true, weekly: false, view: 'int', pdf: false });
    expect(bad.status).toBe(400);
    const none = await lead('POST', '/api/settings/mail/recipients', { email: 'qa@example.com', name: '', daily: false, weekly: false, view: 'int', pdf: false });
    expect(none.status).toBe(400);
    expect(none.body.error.errors.map((e: { path: string }) => e.path)).toContain('daily');
    const ok = await lead('POST', '/api/settings/mail/recipients', { email: 'qa@example.com', name: 'QA 담당', daily: true, weekly: false, view: 'int', pdf: false });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ email: 'qa@example.com', name: 'QA 담당', daily: true, weekly: false, active: true });
    const dup = await lead('POST', '/api/settings/mail/recipients', { email: 'QA@Example.com', name: '', daily: true, weekly: false, view: 'int', pdf: false });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('RECIPIENT_DUPLICATE');
  });

  test('상급자(주간 · 보고용)와 팀장(일간 · 주간 · 팀장용)을 더 등록한다', async () => {
    expect((await lead('POST', '/api/settings/mail/recipients', { email: 'boss@example.com', name: '상급자 (주간보고)', daily: false, weekly: true, view: 'ext', pdf: true })).status).toBe(201);
    expect((await lead('POST', '/api/settings/mail/recipients', { email: 'lead@example.com', name: '팀장', daily: true, weekly: true, view: 'int', pdf: false })).status).toBe(201);
    expect((await recipients()).map((r) => r.email).sort()).toEqual(['boss@example.com', 'lead@example.com', 'qa@example.com']);
  });

  test('일간 · 주간을 모두 끄면 자동으로 중지되고, 구독 없이 다시 받기는 400', async () => {
    const tmp = await lead('POST', '/api/settings/mail/recipients', { email: 'tmp@example.com', name: '', daily: true, weekly: false, view: 'int', pdf: false });
    const off = await lead('PATCH', `/api/settings/mail/recipients/${tmp.body.id}`, { updatedAt: tmp.body.updatedAt, daily: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ daily: false, weekly: false, active: false });
    const again = await lead('PATCH', `/api/settings/mail/recipients/${tmp.body.id}`, { updatedAt: off.body.updatedAt, active: true });
    expect(again.status).toBe(400);
    const stale = await lead('PATCH', `/api/settings/mail/recipients/${tmp.body.id}`, { updatedAt: tmp.body.updatedAt, weekly: true });
    expect(stale.status).toBe(409);
    const del = await lead('DELETE', `/api/settings/mail/recipients/${tmp.body.id}?updatedAt=${encodeURIComponent(off.body.updatedAt)}`);
    expect(del.status).toBe(204);
    expect((await recipients()).some((r) => r.email === 'tmp@example.com')).toBe(false);
  });
});

describe('보고서 생성 직후 자동 발송(G L401-402)', () => {
  test('서버 시작 보충으로 만든 보고서는 구독자에게 「서버 시작 · 누락분 보충 후 발송」으로 큐에 들어가고, 보고서 생성은 SMTP와 무관하다', async () => {
    smtp.mode = 'auth_fail';
    // 메일 서버가 실패해도 보고서 생성은 성공한다(G L1050).
    const created = await generateDueReports(pool, epoch, { now: kst('2026-11-03', '07:00'), startup: true });
    expect(created).toBeGreaterThan(0);
    smtp.mode = 'accept';
    const rows = (await owner.query<{ email: string; reason: string; view: string; state: string; kind: string }>(
      'select o.email,o.reason,o.view,o.state,r.kind from mail_outbox o join reports r on r.id=o.report order by r."from",o.email')).rows;
    const daily = (await reports('daily')).length;
    // 일간 구독자 2명(qa·lead) × 일간 보고서 수 + 주간 구독자 2명(boss·lead) × 주간 1건
    expect(rows.filter((r) => r.kind === 'daily')).toHaveLength(daily * 2);
    expect(rows.filter((r) => r.kind === 'weekly').map((r) => [r.email, r.view])).toEqual([['boss@example.com', 'ext'], ['lead@example.com', 'int']]);
    expect(new Set(rows.map((r) => r.reason))).toEqual(new Set(['서버 시작 · 누락분 보충 후 발송']));
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(['queued']));
    // 일간 보고서는 항상 팀장용
    expect(rows.filter((r) => r.kind === 'daily').every((r) => r.view === 'int')).toBe(true);
  });

  test('worker가 큐를 보내면 각 메일이 한 번씩 수락된다(동시에 두 worker가 돌아도 중복 0)', async () => {
    const queued = (await owner.query<{ n: number }>("select count(*)::int n from mail_outbox where state='queued'")).rows[0]?.n ?? 0;
    const now = kst('2026-11-03', '07:01');
    await Promise.all([deliver(now), deliver(now)]);
    expect(smtp.messages).toHaveLength(queued);
    const states = (await owner.query<{ state: string; n: number }>('select state,count(*)::int n from mail_outbox group by state')).rows;
    expect(states).toEqual([{ state: 'accepted', n: queued }]);
    const l = await log();
    expect(l).toHaveLength(queued);
    expect(l.every((x) => x.state === 'accepted' && x.tryNo === 1)).toBe(true);
    // 발송 표시 번호는 ML-0001부터 겹치지 않게 매긴다
    expect(new Set(l.map((x) => x.logKey)).size).toBe(l.length);
    expect(l.map((x) => x.logKey).sort()[0]).toBe('ML-0001');
    // 발송 기록(추가 전용)에도 결과가 한 줄씩 남는다
    expect((await owner.query<{ n: number }>("select count(*)::int n from mail_log where state='accepted'")).rows[0]?.n).toBe(queued);
  });

  test('정시 생성은 「정기 발송」, 기간 지정 보고서는 자동 발송하지 않는다', async () => {
    expect(await generateDueReports(pool, epoch, { now: kst('2026-11-04', '07:00') })).toBe(1);
    const fresh = (await owner.query<{ reason: string; email: string }>("select reason,email from mail_outbox where state='queued' order by email")).rows;
    expect(fresh).toEqual([{ reason: '정기 발송', email: 'lead@example.com' }, { reason: '정기 발송', email: 'qa@example.com' }]);
    await deliver(kst('2026-11-04', '07:01'));
    const custom = await lead('POST', `/api/projects/${await projectId()}/reports`, { from: '2026-10-27', to: '2026-11-02', view: 'int' });
    expect(custom.status).toBe(201);
    expect((await owner.query<{ n: number }>('select count(*)::int n from mail_outbox where report=$1', [custom.body.id])).rows[0]?.n).toBe(0);
  });
});

describe('메일 본문(G L403-404, §9.6-6 5: table · 인라인 스타일 · 640px · text/plain · 보고용 내부 용어 0건)', () => {
  const weekly = async () => {
    const w = (await reports('weekly'))[0];
    assert(w);
    const snapshot = (await lead('GET', `/api/reports/${w.id}`)).body.snapshot as ReportSnapshotData;
    return { ...w, snapshot };
  };

  test('미리보기 HTML은 표 레이아웃 · 인라인 스타일 · 폭 640px이고 외부 CSS · style · script · 외부 이미지 · class가 없다', async () => {
    const w = await weekly();
    const p = await lead('GET', `/api/reports/${w.id}/mail/preview?view=int`);
    expect(p.status).toBe(200);
    const html = p.body.html as string;
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<table role="presentation" width="640"');
    expect(html).toContain('max-width:640px');
    expect(html).not.toMatch(/<style|<link|<script|<img|class=|display:\s*(flex|grid)|@import|url\(/i);
    // 모든 글자 칸에 글꼴 순서를 인라인으로 둔다
    expect(html).toContain("font-family:'Pretendard GOV','Apple SD Gothic Neo','Malgun Gothic',sans-serif;");
    for (const t of ['팀장 확인 필요', '완료한 Task', '진행 중 · 확인 필요', 'QA 실패', '일정 재조정', '다음 주 예정']) expect(html).toContain(t);
    // 핵심 지표 4개는 화면과 같은 계산(같은 스냅샷)
    // 지표 이름은 원본 메일 문구(P mailHtml L4007), 값은 화면과 같은 계산
    for (const label of ['완료 (기간)', '완료율 (작업량)', `완료 예상 (v${String(w.snapshot.summary.baselineVersion)})`, '가동률']) expect(html).toContain(label);
    for (const k of internalKpis(w.snapshot)) expect(html).toContain(k.value);
    expect(html).toContain(`http://127.0.0.1:5173/report/${w.id}`);
    expect(p.body.subject).toBe(`[Agent WBS] 주간 보고 ${w.from} ~ ${w.to} — 완료 ${String(w.snapshot.done.length)}건 · 완료 예상 ${w.snapshot.summary.forecast ? w.snapshot.summary.forecast.slice(5) : '—'}`);
    expect(p.body.from).toBe('Agent WBS <agent-wbs@example.com>');
  });

  test('보고용 미리보기는 내부 용어(Task ID · 시도 · 모델 · Effort · 토큰 · RP) 0건이고 숫자는 팀장용과 같은 스냅샷에서 온다', async () => {
    const w = await weekly();
    const boss = await recipient('boss@example.com');
    const p = await lead('GET', `/api/reports/${w.id}/mail/preview?view=ext&to=${boss.id}`);
    expect(p.status).toBe(200);
    expect(internalTerms(p.body.html as string)).toEqual([]);
    expect(internalTerms(p.body.subject as string)).toEqual([]);
    for (const t of ['요약', '주요 완료 항목', '위험 · 이슈', '다음 계획']) expect(p.body.html).toContain(t);
    for (const k of externalView(w.snapshot, 'weekly').kpis) expect(p.body.html).toContain(k.value);
    expect(p.body.subject).toContain('주간 보고(요약)');
    expect(p.body.to).toBe('boss@example.com');
    expect(p.body.attachment).toBe(`${w.reportKey}_보고용.pdf`);
  });

  test('일간 보고서는 보고용을 요청해도 팀장용으로 만든다', async () => {
    const d = (await reports('daily'))[0];
    assert(d);
    const p = await lead('GET', `/api/reports/${d.id}/mail/preview?view=ext`);
    expect(p.body.html).toContain('일간 보고서 · 팀장용');
    expect(p.body.subject).toBe(`[Agent WBS] 일간 보고 ${d.from} — ${(p.body.subject as string).split(' — ')[1] ?? ''}`);
  });

  test('실제로 보낸 메일은 multipart/alternative(text/plain + text/html)이고, 보고용 메일은 두 본문 모두 내부 용어 0건이다', async () => {
    const boss = received('boss@example.com');
    expect(boss).toHaveLength(1);
    const raw = boss[0]?.raw ?? '';
    expect(raw).toMatch(/content-type:\s*multipart\/alternative/i);
    const html = mimePart(raw, 'text/html') ?? '';
    const text = mimePart(raw, 'text/plain') ?? '';
    expect(html).toContain('주간 보고서 · 보고용');
    expect(text).toContain('주간 보고서 · 보고용');
    expect(text).not.toMatch(/<[a-z]/i);
    expect(internalTerms(html)).toEqual([]);
    expect(internalTerms(text)).toEqual([]);
    expect(internalTerms(mimeHeader(raw, 'Subject') ?? 'x')).toEqual([]);
    // 미리보기와 실제 발송은 같은 생성 함수다(G§8.5)
    const w = await weekly();
    const p = await lead('GET', `/api/reports/${w.id}/mail/preview?view=ext&to=${(await recipient('boss@example.com')).id}`);
    expect(html).toBe(p.body.html);
    expect(mimeHeader(raw, 'Subject')).toBe(p.body.subject);
    // 팀장용 메일 text/plain에는 같은 지표가 있다
    const leadText = mimePart(received('lead@example.com').find((m) => (mimeHeader(m.raw, 'Subject') ?? '').includes('주간'))?.raw ?? '', 'text/plain') ?? '';
    for (const k of internalKpis(w.snapshot)) expect(leadText).toContain(k.value);
    expect(textOf(html)).toContain('Agent WBS에서 전체 보고서 보기');
  });

  test('접속 주소를 비우면 「전체 보고서 보기」 링크가 빠진다', async () => {
    await owner.query('update app_settings set app_url=null');
    const w = await weekly();
    const p = await lead('GET', `/api/reports/${w.id}/mail/preview?view=int`);
    expect(p.body.html).not.toContain('전체 보고서 보기');
    expect(p.body.html).not.toContain('href=');
    await owner.query("update app_settings set app_url='http://127.0.0.1:5173/'");
  });
});

describe('테스트 발송 · 수동 발송(시나리오 25 「테스트」 · 「메일로 보내기」)', () => {
  test('테스트는 최신 보고서를 그 사람에게 보내고 발송 기록에 「테스트 발송」으로 남는다', async () => {
    const qa = await recipient('qa@example.com');
    const before = received('qa@example.com').length;
    const r = await lead('POST', `/api/settings/mail/recipients/${qa.id}/test`);
    expect(r.status).toBe(202);
    expect(r.body.ids).toHaveLength(1);
    await deliver(kst('2026-11-04', '08:00'));
    expect(received('qa@example.com')).toHaveLength(before + 1);
    const row = (await log()).find((x) => x.id === r.body.ids[0]);
    expect(row).toMatchObject({ state: 'accepted', reason: '테스트 발송', to: 'qa@example.com' });
  });

  test('수동 발송은 고른 보기로 보내고, 같은 보고서 · 같은 사람에게 다시 보내면 발송 번호가 하나 늘어난다', async () => {
    const w = (await reports('weekly'))[0];
    assert(w);
    const qa = await recipient('qa@example.com');
    const r = await lead('POST', `/api/reports/${w.id}/mail`, { recipientIds: [qa.id], view: 'ext' });
    expect(r.status).toBe(202);
    const again = await lead('POST', `/api/reports/${w.id}/mail`, { recipientIds: [qa.id] });
    expect(again.status).toBe(202);
    await deliver(kst('2026-11-04', '08:05'));
    const rows = (await log()).filter((x) => x.reportId === w.id && x.to === 'qa@example.com').sort((a, b) => a.tryNo - b.tryNo);
    expect(rows.map((x) => [x.tryNo, x.view, x.reason, x.state])).toEqual([[1, 'ext', '수동 발송', 'accepted'], [2, 'int', '수동 발송', 'accepted']]);
  });

  test('없는 받는 사람으로 발송하면 404, 없는 보고서 미리보기는 404', async () => {
    const w = (await reports('weekly'))[0];
    assert(w);
    expect((await lead('POST', `/api/reports/${w.id}/mail`, { recipientIds: [randomUUID()] })).status).toBe(404);
    expect((await lead('GET', `/api/reports/${randomUUID()}/mail/preview`)).status).toBe(404);
  });
});

describe('실패 · 15분 후 1회 자동 재시도 · 대시보드 알림 · 다시 보내기(시나리오 25, G L407)', () => {
  let failedAt = '';
  test('SMTP 인증 실패면 발송 기록에 원인을 남기고 15분 뒤에 한 번만 다시 시도한다', async () => {
    smtp.mode = 'auth_fail';
    const qa = await recipient('qa@example.com');
    const t = await lead('POST', `/api/settings/mail/recipients/${qa.id}/test`);
    failedAt = kst('2026-11-04', '09:00');
    await deliver(failedAt);
    let row = (await log()).find((x) => x.id === t.body.ids[0]);
    expect(row?.state).toBe('retry_wait');
    expect(row?.error).toContain('535');
    expect(await mailAlert()).toBeUndefined();
    const tries = smtp.connections;
    await deliver(plus(failedAt, 14));
    expect(smtp.connections).toBe(tries);
    await deliver(plus(failedAt, 15));
    expect(smtp.connections).toBe(tries + 1);
    row = (await log()).find((x) => x.id === t.body.ids[0]);
    expect(row?.state).toBe('failed');
    expect(row?.reason).toContain('자동 재시도');
    await deliver(plus(failedAt, 60));
    expect(smtp.connections).toBe(tries + 1);
  });

  test('그래도 실패하면 대시보드 알림과 실패 목록에 나타난다', async () => {
    const alert = await mailAlert();
    expect(alert?.text).toContain('보고서 메일 발송 실패 1건');
    expect(alert?.text).toContain('설정 → 보고서 · 메일');
    const failed = await log(true);
    expect(failed.map((x) => x.state)).toEqual(['failed']);
  });

  test('정상 복구 후 「실패 건 모두 다시 보내기」는 같은 스냅샷 내용을 보내고 알림을 해제한다', async () => {
    smtp.mode = 'accept';
    const failed = (await log(true))[0];
    assert(failed);
    const qa = await recipient('qa@example.com');
    const pv = (await lead('GET', `/api/reports/${failed.reportId}/mail/preview?view=${failed.view}&to=${qa.id}`)).body as { html: string };
    const r = await lead('POST', '/api/mail/log/resend-failed');
    expect(r.status).toBe(202);
    expect(r.body.ids).toHaveLength(1);
    await deliver(plus(failedAt, 61));
    const sent = received('qa@example.com').at(-1)?.raw ?? '';
    // 같은 보고서·같은 보기면 같은 본문(스냅샷이라 다시 보내도 같은 내용, G L407)
    expect(mimePart(sent, 'text/html')).toBe(pv.html);
    const row = (await log()).find((x) => x.id === r.body.ids[0]);
    // 원본처럼 「다시 보내기 (ML-0001)」 — 어떤 실패 기록을 다시 보냈는지 발송 표시 번호로 보인다(P resend L4970)
    expect(failed.logKey).toMatch(/^ML-\d{4}$/);
    expect(row).toMatchObject({ state: 'accepted', reason: `다시 보내기 (${failed.logKey})`, tryNo: failed.tryNo + 1 });
    expect(row?.logKey).not.toBe(failed.logKey);
    expect(await log(true)).toEqual([]);
    expect(await mailAlert()).toBeUndefined();
    // 이미 해소된 실패 행을 다시 보내기는 409(중복 발송 방지)
    expect((await lead('POST', `/api/mail/log/${failed.id}/resend`)).status).toBe(409);
  });
});

describe('수락 여부를 모를 때 자동으로 다시 보내지 않는다(contracts §4.4, G§9.6-6 「두 번 나가지 않게」)', () => {
  test('본문을 보낸 뒤 응답이 없으면(timeout) unknown — 15분 자동 재시도 0, 알림에 「수락 여부 불명」', async () => {
    smtp.mode = 'hold';
    const lead1 = await recipient('lead@example.com');
    const t = await lead('POST', `/api/settings/mail/recipients/${lead1.id}/test`);
    const at = kst('2026-11-04', '10:00');
    const before = received('lead@example.com').length;
    await deliver(at);
    expect(received('lead@example.com')).toHaveLength(before + 1);
    smtp.mode = 'accept';
    const row = (await log()).find((x) => x.id === t.body.ids[0]);
    expect(row?.state).toBe('unknown');
    expect(row?.error).toContain('수락 여부 불명');
    await deliver(plus(at, 16));
    await deliver(plus(at, 120));
    expect(received('lead@example.com')).toHaveLength(before + 1);
    expect((await mailAlert())?.text).toContain('수락 여부 불명');
    // 팀장이 중복 가능 안내를 보고 직접 다시 보내면 새 발송 번호로 나간다
    const resend = await lead('POST', `/api/mail/log/${t.body.ids[0]}/resend`);
    expect(resend.status).toBe(202);
    await deliver(plus(at, 121));
    expect(received('lead@example.com')).toHaveLength(before + 2);
    expect(await mailAlert()).toBeUndefined();
  });

  test('명시적 거부(451)는 수락되지 않은 것이 확실하므로 자동 재시도 대상이다', async () => {
    smtp.mode = 'temp_fail';
    const lead1 = await recipient('lead@example.com');
    const t = await lead('POST', `/api/settings/mail/recipients/${lead1.id}/test`);
    await deliver(kst('2026-11-04', '11:00'));
    expect((await log()).find((x) => x.id === t.body.ids[0])?.state).toBe('retry_wait');
    smtp.mode = 'accept';
    await deliver(kst('2026-11-04', '11:15'));
    const row = (await log()).find((x) => x.id === t.body.ids[0]);
    expect(row?.state).toBe('accepted');
    expect(row?.reason).toContain('자동 재시도');
  });

  test('수락 직후 worker 프로세스가 죽으면(crash) 재시작 때 unknown으로 정리하고 자동 재발송 0', async () => {
    const qa = await recipient('qa@example.com');
    const t = await lead('POST', `/api/settings/mail/recipients/${qa.id}/test`);
    const id = t.body.ids[0] as string;
    const at = kst('2026-11-04', '12:00');
    const before = received('qa@example.com').length;
    const script = fileURLToPath(new URL('../mail-worker.ts', import.meta.url));
    const child = spawn(process.execPath, ['--conditions=awbs-source', script, appDbUrl, String(epoch), at, '10000'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => { resolve(signal); }));
    // 서버가 본문을 받아 저장한 순간, 250 응답을 보내기 전에 worker를 죽인다.
    smtp.onMessage = async () => { child.kill('SIGKILL'); await exited; };
    try {
      expect(await exited, stderr).toBe('SIGKILL');
    } finally { smtp.onMessage = null; }
    expect(received('qa@example.com')).toHaveLength(before + 1);
    expect((await owner.query<{ state: string }>('select state from mail_outbox where id=$1', [id])).rows[0]?.state).toBe('sending');
    // worker 재시작: 남은 sending은 결과를 모르는 발송이다.
    expect(await recoverMail(pool, epoch)).toBe(1);
    const row = (await log()).find((x) => x.id === id);
    expect(row?.state).toBe('unknown');
    expect(row?.error).toContain('수락 여부 불명');
    await deliver(plus(at, 20));
    await deliver(plus(at, 240));
    expect(received('qa@example.com')).toHaveLength(before + 1);
    expect((await mailAlert())?.text).toContain('1건');
    await lead('POST', `/api/mail/log/${id}/resend`);
    await deliver(plus(at, 241));
    expect(await mailAlert()).toBeUndefined();
  }, 30_000);
});


/**
 * Codex 리뷰(review-codex.md) 재현을 올바른 동작으로 고정한 시험(fix2).
 * 각 시험은 리뷰어가 재현한 잘못된 동작이 다시 생기면 실패한다.
 */
describe('리뷰 지적 회귀(fix2)', () => {
  test('[지적 1] 한 통의 결과 저장이 계속 실패해도 큐가 멈추지 않는다 — 그 행만 unknown, 나머지는 보낸다', async () => {
    const a = await recipient('lead@example.com');
    const b = await recipient('boss@example.com');
    const first = (await lead('POST', `/api/settings/mail/recipients/${a.id}/test`)).body.ids[0] as string;
    const second = (await lead('POST', `/api/settings/mail/recipients/${b.id}/test`)).body.ids[0] as string;
    // 첫 행의 accepted 저장만 DB 오류가 나게 한다(일시 장애 흉내). 상태를 unknown으로 적는 것은 막지 않는다.
    await owner.query(`create function public.fix2_fail_record() returns trigger language plpgsql as $$ begin
      if new.state='accepted' and new.id='${first}' then raise exception 'fix2 injected result write failure'; end if; return new; end $$`);
    await owner.query('create trigger fix2_fail_record before update on mail_outbox for each row execute function public.fix2_fail_record()');
    const before = smtp.messages.length;
    try {
      // 예외로 worker 단계가 끝나지 않는다.
      await expect(deliver(kst('2026-11-04', '12:55'))).resolves.toBeDefined();
    } finally {
      await owner.query('drop trigger fix2_fail_record on mail_outbox');
      await owner.query('drop function public.fix2_fail_record()');
    }
    expect(smtp.messages.length - before).toBe(2);
    const rows = (await owner.query<{ id: string; state: string; error: string | null }>('select id,state,error from mail_outbox where id=any($1::uuid[])', [[first, second]])).rows;
    expect(rows.find((r) => r.id === first)).toMatchObject({ state: 'unknown' });
    expect(rows.find((r) => r.id === first)?.error).toContain('수락 여부 불명');
    expect(rows.find((r) => r.id === second)?.state).toBe('accepted');
    // 다시 돌려도 이미 나간 메일을 또 보내지 않는다.
    await deliver(kst('2026-11-04', '13:55'));
    expect(smtp.messages.length - before).toBe(2);
    expect((await mailAlert())?.text).toContain('수락 여부 불명');
    await lead('POST', `/api/mail/log/${first}/resend`);
    await deliver(kst('2026-11-04', '13:56'));
    expect(await mailAlert()).toBeUndefined();
  });

  test('[지적 1] 기록조차 못 한 채 sending에 남은 행은 다음 주기에 unknown으로 드러난다(프로세스 재시작 없이)', async () => {
    const a = await recipient('lead@example.com');
    const id = (await lead('POST', `/api/settings/mail/recipients/${a.id}/test`)).body.ids[0] as string;
    // 기록 경로가 모두 막혀 sending으로 남은 상태를 만든다.
    await owner.query("update mail_outbox set state='sending',sent_at=$2 where id=$1", [id, kst('2026-11-04', '14:00')]);
    const before = smtp.messages.length;
    await deliver(kst('2026-11-04', '14:30'));
    expect((await owner.query<{ state: string }>('select state from mail_outbox where id=$1', [id])).rows[0]?.state).toBe('unknown');
    expect(smtp.messages.length).toBe(before);
    await lead('POST', `/api/mail/log/${id}/resend`);
    await deliver(kst('2026-11-04', '14:31'));
  });

  test('[지적 3] 삭제한 받는 사람에게는 다시 보내지 않는다(행별 409 · 전체 재발송 제외 · 발송 직전 확인)', async () => {
    const add = async (email: string) => (await lead('POST', '/api/settings/mail/recipients', { email, name: '삭제 재현', daily: true, weekly: false, view: 'int', pdf: false })).body as { id: string };
    const r1 = await add('removed@example.com');
    const failed = (await lead('POST', `/api/settings/mail/recipients/${r1.id}/test`)).body.ids[0] as string;
    smtp.mode = 'auth_fail';
    await deliverMail(pool, epoch, { now: kst('2026-11-04', '15:00'), timeoutMs: TIMEOUT });
    await deliverMail(pool, epoch, { now: kst('2026-11-04', '15:15'), timeoutMs: TIMEOUT });
    smtp.mode = 'accept';
    expect((await owner.query<{ state: string }>('select state from mail_outbox where id=$1', [failed])).rows[0]?.state).toBe('failed');
    // 큐에만 들어 있고 아직 보내지 않은 발송(다른 사람)
    const r2 = await add('removed2@example.com');
    const queuedOnly = (await lead('POST', `/api/settings/mail/recipients/${r2.id}/test`)).body.ids[0] as string;
    for (const email of ['removed@example.com', 'removed2@example.com']) {
      const current = await recipient(email);
      expect((await lead('DELETE', `/api/settings/mail/recipients/${current.id}?updatedAt=${encodeURIComponent(current.updatedAt)}`)).status).toBe(204);
    }
    const resend = await lead('POST', `/api/mail/log/${failed}/resend`);
    expect(resend.status).toBe(409);
    expect(resend.body.error.message).toContain('삭제');
    const all = await lead('POST', '/api/mail/log/resend-failed');
    expect(all.status).toBe(202);
    expect(all.body.ids).toEqual([]);
    await deliver(kst('2026-11-04', '15:16'));
    expect(received('removed@example.com')).toHaveLength(0);
    expect(received('removed2@example.com')).toHaveLength(0);
    const skipped = (await owner.query<{ state: string; error: string | null }>('select state,error from mail_outbox where id=$1', [queuedOnly])).rows[0];
    expect(skipped?.state).toBe('failed');
    expect(skipped?.error).toContain('받는 사람이 삭제');
    // 삭제한 사람의 실패는 다시 보낼 대상이 아니므로 실패 목록 · 알림에서 빠진다(기록은 남는다).
    expect((await log()).filter((x) => x.to === 'removed@example.com').length).toBeGreaterThan(0);
    expect((await log(true)).filter((x) => x.to.startsWith('removed'))).toEqual([]);
    expect(await mailAlert()).toBeUndefined();
  });

  test('[지적 5] 연결 확인 중에 설정이 바뀌면 옛 확인 결과를 새 설정에 붙이지 않는다', async () => {
    let arrived!: () => void;
    const connected = new Promise<void>((r) => { arrived = r; });
    let greet!: () => void;
    const server = createServer((socket) => {
      greet = () => socket.write('220 review smtp\r\n');
      arrived();
      socket.on('data', (chunk) => {
        const cmd = chunk.toString();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250 review smtp\r\n');
        if (cmd.startsWith('QUIT')) { socket.write('221 bye\r\n'); socket.end(); }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const input = (v: Awaited<ReturnType<typeof getSmtp>>) => ({ updatedAt: v.updatedAt, host: v.host, port: v.port, sec: v.sec, from: v.from, user: v.user });
    const before = await inEpoch(pool, epoch, getSmtp);
    await inEpoch(pool, epoch, (c) => putSmtp(c, { ...input(before), host: '127.0.0.1', port, sec: '없음', user: '' }));
    const checking = inEpoch(pool, epoch, (c) => checkSmtpSettings(c, 5000));
    await connected;
    const current = await inEpoch(pool, epoch, getSmtp);
    await inEpoch(pool, epoch, (c) => putSmtp(c, { ...input(current), port: 1 }));
    greet();
    const result = await checking;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('설정이 바뀌');
    const after = await inEpoch(pool, epoch, getSmtp);
    expect(after.port).toBe(1);
    expect(after.check).toBeNull();
    await new Promise<void>((r) => server.close(() => r()));
    await inEpoch(pool, epoch, (c) => putSmtp(c, { ...input(after), port: smtp.port, user: smtp.user }));
  });

  test('[지적 6] 15분 재시도는 실제 실패를 확인한 DB 시각부터 센다', async () => {
    const target = await recipient('lead@example.com');
    const id = (await lead('POST', `/api/settings/mail/recipients/${target.id}/test`)).body.ids[0] as string;
    smtp.mode = 'temp_fail';
    // 서버가 본문을 받고 3초 뒤에 451로 거부한다(느린 서버).
    smtp.onMessage = async () => { await new Promise((r) => setTimeout(r, 3000)); };
    try { await deliverMail(pool, epoch, { timeoutMs: 15000 }); }
    finally { smtp.onMessage = null; smtp.mode = 'accept'; }
    const row = (await owner.query<{ state: string; afterStart: number; remaining: number }>(
      `select state,extract(epoch from (next_at - sent_at))::float8 "afterStart",extract(epoch from (next_at - clock_timestamp()))::float8 remaining from mail_outbox where id=$1`, [id])).rows[0];
    expect(row?.state).toBe('retry_wait');
    // 호출 시작이 아니라 실패를 안 뒤부터 15분: 시작 기준이면 900초, 지금은 900초 + 서버 대기(약 3초)
    expect(row?.afterStart).toBeGreaterThan(902);
    expect(row?.remaining).toBeGreaterThan(895);
    await deliverMail(pool, epoch, { now: '2099-01-01T00:00:00.000Z', timeoutMs: TIMEOUT });
  }, 30_000);
});


/**
 * Codex 재리뷰(review2-codex.md) P1 회귀(fix3). 결과 기록은 그 시도(attempt)가 현재일 때만 상태를 바꾸고,
 * unknown에서는 늦은 accepted만 받는다. 늦은 실패는 이력에만 남기고 자동 재시도를 다시 켜지 않는다.
 */
describe('늦은 결과와 정리 · 수동 발송 경합(fix3)', () => {
  const hold = () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => { entered = r; });
    const held = new Promise<void>((r) => { release = r; });
    let first = true;
    smtp.onMessage = async () => { if (first) { first = false; entered(); await held; } };
    return { reached, release };
  };
  const stateOf = async (id: string) => (await owner.query<{ state: string }>('select state from mail_outbox where id=$1', [id])).rows[0]?.state;

  test.each(['sweep', 'restart'] as const)('[재리뷰 P1] %s 정리 → 수동 다시 보내기 성공 → 원래 시도의 늦은 451: 원본은 unknown 그대로, 자동 추가 발송 0', async (recovery) => {
    const a = await recipient('lead@example.com');
    const id = (await lead('POST', `/api/settings/mail/recipients/${a.id}/test`)).body.ids[0] as string;
    const at = kst('2026-11-04', recovery === 'sweep' ? '20:00' : '21:00');
    const h = hold();
    const active = deliverMail(pool, epoch, { now: at, timeoutMs: 60_000 });
    await h.reached;
    try {
      if (recovery === 'sweep') expect((await deliver(plus(at, 30))).unknown).toBe(1);
      else expect(await recoverMail(pool, epoch, { now: plus(at, 1) })).toBe(1);
      expect(await stateOf(id)).toBe('unknown');
      const manual = await lead('POST', `/api/mail/log/${id}/resend`);
      expect(manual.status).toBe(202);
      const manualId = manual.body.ids[0] as string;
      await deliver(plus(at, 30));
      expect(await stateOf(manualId)).toBe('accepted');
      // 원래 요청에는 뒤늦게 확실한 451 거부를 돌려준다.
      smtp.mode = 'temp_fail';
    } finally { h.release(); }
    await active;
    smtp.onMessage = null;
    smtp.mode = 'accept';
    expect(await stateOf(id)).toBe('unknown');
    const before = smtp.messages.length;
    const auto = await deliver(plus(at, 50));
    expect(auto.accepted).toBe(0);
    expect(smtp.messages.length).toBe(before);
    // 늦은 거부는 이력에는 남는다(무슨 일이 있었는지 알 수 있게).
    const late = (await owner.query<{ state: string; error: string | null }>("select state,error from mail_log where outbox=$1 order by created_at desc limit 1", [id])).rows[0];
    expect(late?.state).toBe('failed');
    expect(late?.error).toContain('늦은 응답');
  }, 30_000);

  test('정리로 unknown이 된 뒤 원래 시도의 늦은 250 수락은 accepted로 고친다', async () => {
    const a = await recipient('lead@example.com');
    const id = (await lead('POST', `/api/settings/mail/recipients/${a.id}/test`)).body.ids[0] as string;
    const at = kst('2026-11-04', '22:00');
    const h = hold();
    const active = deliverMail(pool, epoch, { now: at, timeoutMs: 60_000 });
    await h.reached;
    try { expect(await recoverMail(pool, epoch, { now: plus(at, 1) })).toBe(1); } finally { h.release(); }
    await active;
    smtp.onMessage = null;
    expect(await stateOf(id)).toBe('accepted');
    expect(await mailAlert()).toBeUndefined();
  }, 30_000);

  test('현재 시도가 아닌(낡은) 결과는 상태를 바꾸지 않는다', async () => {
    const a = await recipient('lead@example.com');
    const id = (await lead('POST', `/api/settings/mail/recipients/${a.id}/test`)).body.ids[0] as string;
    const at = kst('2026-11-04', '23:00');
    const h = hold();
    const active = deliverMail(pool, epoch, { now: at, timeoutMs: 60_000 });
    await h.reached;
    // 그 사이에 같은 줄이 새 시도로 바뀐 상황(예: 운영 도구로 다시 찜)
    try { await owner.query("update mail_outbox set attempt=gen_random_uuid(),state='retry_wait',next_at=$2 where id=$1", [id, plus(at, 15)]); } finally { h.release(); }
    await active;
    smtp.onMessage = null;
    expect(await stateOf(id)).toBe('retry_wait');
    await owner.query("update mail_outbox set state='accepted',next_at=null where id=$1", [id]);
  }, 30_000);
});

/**
 * M6 통합: PDF 첨부(M6-03 README §9 연결 지점 + M6-02 reportPdf). worker와 같은 연결(runner/worker.ts)을 시험에서 그대로 만든다.
 * - 받는 사람의 「PDF 첨부」가 켜져 있으면 팀장 다운로드와 같은 PDF가 `RPT-…_보고용.pdf` 이름으로 붙는다.
 * - PDF를 만들지 못하면 보내기 전 실패(rejected)라 15분 뒤 한 번 다시 시도한다(수락되지 않은 것이 확실하다).
 */
describe('M6 통합: 보고서 PDF 첨부', () => {
  test('PDF 변환이 실패하면 보내지 않고 15분 재시도, 다시 시도 때는 보고용 PDF를 붙여 보낸다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awbs-mail-pdf-'));
    const renderer = chromiumRenderer();
    try {
      const boss = await recipient('boss@example.com');
      expect(boss.pdf).toBe(true);
      const w = (await reports('weekly'))[0];
      assert(w);
      const queued = await lead('POST', `/api/reports/${w.id}/mail`, { recipientIds: [boss.id] });
      expect(queued.status).toBe(202);
      const id = queued.body.ids[0] as string;
      const before = received('boss@example.com').length;
      const at = kst('2026-11-06', '09:00');
      // 1) 변환 실패 → 보내지 않음, 기록에 원인, 15분 재시도 대기
      await deliverMail(pool, epoch, { now: at, timeoutMs: TIMEOUT, pdf: () => Promise.reject(new Error('브라우저 없음')) });
      expect(received('boss@example.com')).toHaveLength(before);
      expect((await owner.query<{ state: string }>('select state from mail_outbox where id=$1', [id])).rows[0]?.state).toBe('retry_wait');
      expect((await owner.query<{ error: string | null }>("select error from mail_log where outbox=$1 and error is not null order by created_at desc limit 1", [id])).rows[0]?.error).toContain('PDF 첨부를 만들지 못함');
      // 2) 15분 뒤 다시 시도: 실제 PDF(팀장 다운로드와 같은 reportPdf)를 붙인다
      await deliverMail(pool, epoch, { now: plus(at, 16), timeoutMs: 60_000, pdf: async (reportId, view) => (await reportPdf(pool, root, renderer, epoch, reportId, view)).file });
      expect((await owner.query<{ state: string }>('select state from mail_outbox where id=$1', [id])).rows[0]?.state).toBe('accepted');
      const raw = received('boss@example.com').at(-1)?.raw ?? '';
      expect(raw).toMatch(/content-type:\s*multipart\/mixed/i);
      const pdfPart = raw.split(/\r\n--/).find((part) => /content-type:\s*application\/pdf/i.test(part)) ?? '';
      // 파일 이름은 RFC 2231 이어 쓰기(filename*0*=utf-8''…; filename*1=…)로 나뉘어 온다. 조각을 이어 붙여 푼다.
      const fileName = decodeURIComponent([...pdfPart.matchAll(/filename\*\d+\*?=(?:utf-8'')?([^;\r\n]+)/gi)].map((m) => m[1] ?? '').join(''));
      expect(fileName).toBe(`${w.reportKey}_보고용.pdf`);
      const body = pdfPart.slice(pdfPart.indexOf('\r\n\r\n') + 4).replace(/\s+/g, '');
      const file = Buffer.from(body, 'base64');
      expect(file.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // 다운로드와 같은 파일이다(같은 문서 hash 캐시)
      expect(file.equals((await reportPdf(pool, root, renderer, epoch, w.id, 'ext')).file)).toBe(true);
      // 본문(text/plain + text/html)은 첨부 안쪽의 multipart/alternative로 그대로 들어 있다
      expect(raw).toMatch(/content-type:\s*multipart\/alternative/i);
      expect(raw).toMatch(/content-type:\s*text\/html/i);
      expect(raw).toMatch(/content-type:\s*text\/plain/i);
    } finally {
      await renderer.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * Q-13 결정 A: 외부 수신자에게는 owner SMTP로 링크 없이 보고용 + PDF만 보낸다(G L1052 · L1153).
 * - 외부 수신자는 보고용 · PDF로 고정이고 일간을 받지 않는다(일간 보고서는 팀장용만 있다).
 * - 한 번 발송에 내부 · 외부가 섞여도 받는 사람마다 따로 한 통씩 나간다. 외부 메일에는 링크 · 내부 경로가 0건이다.
 * - 멱등(한 줄 = 보고서 + 받는 사람 + 발송 번호)과 결과 전이표(보내기 전 실패 → 15분 재시도, 응답 유실 → unknown · 자동 재발송 0)는 그대로다.
 */
describe('Q-13 결정 A: 외부 수신자(링크 없이 보고용 + PDF)', () => {
  const PARTNER = 'partner@outside.example';
  const FAKE_PDF = () => Promise.resolve(Buffer.from('%PDF-1.4 fake external'));
  /** 링크 · 내부 경로(앱 주소, /report/·/settings/ 경로, 「설정 →」 안내, 「전체 보고서 보기」)를 모두 찾는다. 외부 메일은 0건이어야 한다. */
  const links = (body: string) => body.match(/href=|https?:\/\/|127\.0\.0\.1|\/report\/|\/settings\/|설정 →|전체 보고서 보기/g) ?? [];
  const rowOf = async (id: string) => (await owner.query<{ state: string; external: boolean; view: string; pdf: boolean; try_no: number; error: string | null; kind: string }>(
    'select o.state::text state,o.external,o.view::text view,o.pdf,o.try_no,o.error,r.kind::text kind from mail_outbox o join reports r on r.id=o.report where o.id=$1', [id])).rows[0];
  const at = kst('2026-11-07', '09:00');

  test('외부 수신자는 일간을 고르면 400, 보고용 · PDF가 아니면 400, 주간 · 보고용 · PDF로 등록된다', async () => {
    const daily = await lead('POST', '/api/settings/mail/recipients', { email: PARTNER, name: '협력사', daily: true, weekly: true, view: 'ext', pdf: true, external: true });
    expect(daily.status).toBe(400);
    expect(daily.body.error.errors.map((e: { path: string }) => e.path)).toEqual(['daily']);
    const view = await lead('POST', '/api/settings/mail/recipients', { email: PARTNER, name: '협력사', daily: false, weekly: true, view: 'int', pdf: false, external: true });
    expect(view.body.error.errors.map((e: { path: string }) => e.path)).toEqual(['view', 'pdf']);
    const ok = await lead('POST', '/api/settings/mail/recipients', { email: PARTNER, name: '협력사', daily: false, weekly: true, view: 'ext', pdf: true, external: true });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ external: true, daily: false, weekly: true, view: 'ext', pdf: true, active: true });
    // 외부 수신자에게 일간을 켜려 하면 400. 기존 받는 사람은 모두 내부(false)다(0038 기본값).
    const on = await lead('PATCH', `/api/settings/mail/recipients/${ok.body.id}`, { updatedAt: ok.body.updatedAt, daily: true });
    expect(on.status).toBe(400);
    expect((await recipients()).filter((r) => r.email !== PARTNER).every((r) => (r as unknown as { external: boolean }).external === false)).toBe(true);
    // DB 검사도 같은 규칙이다(API를 거치지 않은 쓰기도 막는다).
    await expect(owner.query("update mail_recipients set daily=true where email=$1", [PARTNER])).rejects.toMatchObject({ constraint: 'recipient_external' });
  });

  test('「외부」 단추 하나로 바꾸면 일간 끔 · 보고용 · PDF로 맞춰진다', async () => {
    const r = await lead('POST', '/api/settings/mail/recipients', { email: 'turn@example.com', name: '바뀔 사람', daily: true, weekly: true, view: 'int', pdf: false });
    const ext = await lead('PATCH', `/api/settings/mail/recipients/${r.body.id}`, { updatedAt: r.body.updatedAt, external: true });
    expect(ext.status).toBe(200);
    expect(ext.body).toMatchObject({ external: true, daily: false, weekly: true, view: 'ext', pdf: true, active: true });
    // 함께 보낸 칸이 규칙과 어긋나면 조용히 고치지 않고 400
    const back = await lead('PATCH', `/api/settings/mail/recipients/${r.body.id}`, { updatedAt: ext.body.updatedAt, external: false });
    expect(back.body).toMatchObject({ external: false, daily: false, view: 'ext', pdf: true });
    const bad = await lead('PATCH', `/api/settings/mail/recipients/${r.body.id}`, { updatedAt: back.body.updatedAt, external: true, daily: true });
    expect(bad.status).toBe(400);
    expect((await lead('DELETE', `/api/settings/mail/recipients/${r.body.id}?updatedAt=${encodeURIComponent(back.body.updatedAt)}`)).status).toBe(204);
  });

  test('내부 · 외부가 섞인 수동 발송은 받는 사람마다 따로 나가고, 외부 메일은 링크 0건 · 보고용 · PDF 첨부다', async () => {
    const w = (await reports('weekly'))[0];
    assert(w);
    const [leadR, boss, partner] = [await recipient('lead@example.com'), await recipient('boss@example.com'), await recipient(PARTNER)];
    // 「모두 팀장용」을 골라도 외부 수신자는 보고용으로 간다.
    const q = await lead('POST', `/api/reports/${w.id}/mail`, { recipientIds: [leadR.id, boss.id, partner.id], view: 'int' });
    expect(q.status).toBe(202);
    expect(q.body.ids).toHaveLength(3);
    const rows = (await owner.query<{ email: string; external: boolean; view: string; pdf: boolean }>(
      'select email,external,view::text view,pdf from mail_outbox where id=any($1::uuid[]) order by email', [q.body.ids])).rows;
    expect(rows).toEqual([
      { email: 'boss@example.com', external: false, view: 'int', pdf: true },
      { email: 'lead@example.com', external: false, view: 'int', pdf: false },
      { email: PARTNER, external: true, view: 'ext', pdf: true },
    ]);
    const before = smtp.messages.length;
    await deliverMail(pool, epoch, { now: at, timeoutMs: TIMEOUT, pdf: FAKE_PDF });
    const sent = smtp.messages.slice(before);
    expect(sent).toHaveLength(3);
    // 한 통에 받는 사람 한 명: 외부 수신자가 내부 메일의 받는 사람(To · Cc · Bcc 봉투)에 끼지 않는다.
    expect(sent.map((m) => m.to)).toEqual(expect.arrayContaining([[PARTNER], ['lead@example.com'], ['boss@example.com']]));
    expect(sent.every((m) => m.to.length === 1)).toBe(true);
    const out = sent.find((m) => m.to[0] === PARTNER)?.raw ?? '';
    const html = mimePart(out, 'text/html') ?? '';
    const text = mimePart(out, 'text/plain') ?? '';
    expect(links(html)).toEqual([]);
    expect(links(text)).toEqual([]);
    expect(links(mimeHeader(out, 'Subject') ?? '')).toEqual([]);
    expect(internalTerms(html)).toEqual([]);
    expect(internalTerms(text)).toEqual([]);
    expect(html).toContain('주간 보고서 · 보고용');
    expect(text).toContain('전체 내용은 첨부한 PDF에 있습니다.');
    expect(mimeHeader(out, 'Subject')).toContain('주간 보고(요약)');
    expect(out).toMatch(/content-type:\s*application\/pdf/i);
    // 내부 수신자 메일은 지금처럼 링크가 있다.
    const inside = mimePart(sent.find((m) => m.to[0] === 'lead@example.com')?.raw ?? '', 'text/html') ?? '';
    expect(inside).toContain(`http://127.0.0.1:5173/report/${w.id}`);
    // 미리보기도 같은 함수 · 같은 규칙이다.
    const p = await lead('GET', `/api/reports/${w.id}/mail/preview?view=int&to=${partner.id}`);
    expect(p.body).toMatchObject({ external: true, attachment: `${w.reportKey}_보고용.pdf`, to: PARTNER });
    expect(p.body.html).toBe(html);
    // 발송 기록에도 외부 여부가 남는다.
    const l = (await log()).filter((x) => (q.body.ids as string[]).includes(x.id));
    expect(l.map((x) => [x.to, (x as unknown as { external: boolean }).external, x.state]).sort()).toEqual([
      ['boss@example.com', false, 'accepted'], ['lead@example.com', false, 'accepted'], [PARTNER, true, 'accepted'],
    ]);
  });

  test('일간 보고서는 외부 수신자에게 보내지 않는다: 수동 발송 400(한 통도 큐에 넣지 않음), 미리보기 400, 테스트는 최신 주간 · 기간 보고서로', async () => {
    // 새 일간 보고서를 만든다(정기 생성). 외부 수신자는 일간 구독자가 아니므로 큐에 들어가지 않는다.
    expect(await generateDueReports(pool, epoch, { now: kst('2026-11-05', '07:00') })).toBe(1);
    const queuedTo = (await owner.query<{ email: string }>("select email from mail_outbox where state='queued' order by email")).rows.map((x) => x.email);
    expect(queuedTo).not.toContain(PARTNER);
    await deliverMail(pool, epoch, { now: at, timeoutMs: TIMEOUT, pdf: FAKE_PDF });
    const d = (await reports('daily'))[0];
    assert(d);
    const [leadR, partner] = [await recipient('lead@example.com'), await recipient(PARTNER)];
    const count = async () => (await owner.query<{ n: number }>('select count(*)::int n from mail_outbox')).rows[0]?.n ?? 0;
    const before = await count();
    const r = await lead('POST', `/api/reports/${d.id}/mail`, { recipientIds: [leadR.id, partner.id] });
    expect(r.status).toBe(400);
    expect(r.body.error.errors[0].path).toBe('recipientIds');
    expect(await count()).toBe(before);
    expect((await lead('GET', `/api/reports/${d.id}/mail/preview?to=${partner.id}`)).status).toBe(400);
    const t = await lead('POST', `/api/settings/mail/recipients/${partner.id}/test`);
    expect(t.status).toBe(202);
    // 가장 최근 보고서가 일간이어도, 외부 수신자 테스트는 일간이 아닌 것 중 최신(여기서는 앞 시험이 만든 기간 지정 보고서)이다.
    const latest = (await owner.query<{ kind: string }>('select kind::text kind from reports order by record_no desc limit 1')).rows[0]?.kind;
    expect(await rowOf(t.body.ids[0] as string)).toMatchObject({ external: true, view: 'ext', pdf: true });
    expect([latest, (await rowOf(t.body.ids[0] as string))?.kind]).toEqual(['daily', 'custom']);
    await deliverMail(pool, epoch, { now: plus(at, 1), timeoutMs: TIMEOUT, pdf: FAKE_PDF });
    expect((await rowOf(t.body.ids[0] as string))?.state).toBe('accepted');
  });

  test('PDF가 없으면 외부 수신자에게 요약만 보내지 않는다: 보내기 전 실패 → 15분 뒤 한 번 다시(같은 줄), 그때 PDF와 함께 수락', async () => {
    const partner = await recipient(PARTNER);
    const t = await lead('POST', `/api/settings/mail/recipients/${partner.id}/test`);
    const id = t.body.ids[0] as string;
    const before = received(PARTNER).length;
    await deliverMail(pool, epoch, { now: plus(at, 2), timeoutMs: TIMEOUT });
    expect(received(PARTNER)).toHaveLength(before);
    const tryNo = (await rowOf(id))?.try_no;
    expect(await rowOf(id)).toMatchObject({ state: 'retry_wait' });
    expect((await rowOf(id))?.error).toContain('PDF 첨부를 만들지 못해 외부 수신자에게 보내지 않음');
    await deliverMail(pool, epoch, { now: plus(at, 18), timeoutMs: TIMEOUT, pdf: FAKE_PDF });
    // 자동 재시도는 새 줄이 아니라 같은 줄(같은 발송 번호)이다.
    expect(await rowOf(id)).toMatchObject({ state: 'accepted', try_no: tryNo });
    expect(received(PARTNER)).toHaveLength(before + 1);
  });

  test('외부 메일도 응답 유실은 unknown · 자동 재발송 0, 다시 보내기는 발송 번호를 올린 새 줄(외부 규칙 유지)', async () => {
    const w = (await reports('weekly'))[0];
    assert(w);
    const partner = await recipient(PARTNER);
    const q = await lead('POST', `/api/reports/${w.id}/mail`, { recipientIds: [partner.id] });
    const id = q.body.ids[0] as string;
    smtp.mode = 'drop';
    try { await deliverMail(pool, epoch, { now: plus(at, 30), timeoutMs: TIMEOUT, pdf: FAKE_PDF }); } finally { smtp.mode = 'accept'; }
    expect((await rowOf(id))?.state).toBe('unknown');
    const count = received(PARTNER).length;
    await deliverMail(pool, epoch, { now: plus(at, 60), timeoutMs: TIMEOUT, pdf: FAKE_PDF });
    expect(received(PARTNER)).toHaveLength(count);
    const again = await lead('POST', `/api/mail/log/${id}/resend`);
    expect(again.status).toBe(202);
    const next = await rowOf(again.body.ids[0] as string);
    expect(next).toMatchObject({ external: true, view: 'ext', pdf: true, state: 'queued' });
    expect(next?.try_no).toBe(((await rowOf(id))?.try_no ?? 0) + 1);
    expect((await lead('POST', `/api/mail/log/${id}/resend`)).status).toBe(409);
    await deliverMail(pool, epoch, { now: plus(at, 61), timeoutMs: TIMEOUT, pdf: FAKE_PDF });
    expect((await rowOf(again.body.ids[0] as string))?.state).toBe('accepted');
  });

  test('큐에 넣은 뒤 외부로 바뀌면: 주간은 보내기 직전 외부 규칙(링크 없음 · 보고용 · PDF)으로, 일간은 보내지 않고 실패(다시 보낼 대상 아님)', async () => {
    const r = await lead('POST', '/api/settings/mail/recipients', { email: 'moved@example.com', name: '옮긴 사람', daily: true, weekly: true, view: 'int', pdf: false });
    const [d, w] = [(await reports('daily'))[0], (await reports('weekly'))[0]];
    assert(d && w);
    const daily = (await lead('POST', `/api/reports/${d.id}/mail`, { recipientIds: [r.body.id] })).body.ids[0] as string;
    const weekly = (await lead('POST', `/api/reports/${w.id}/mail`, { recipientIds: [r.body.id] })).body.ids[0] as string;
    expect(await rowOf(weekly)).toMatchObject({ external: false, view: 'int' });
    const ext = await lead('PATCH', `/api/settings/mail/recipients/${r.body.id}`, { updatedAt: r.body.updatedAt, external: true });
    expect(ext.status).toBe(200);
    const before = received('moved@example.com').length;
    await deliverMail(pool, epoch, { now: plus(at, 90), timeoutMs: TIMEOUT, pdf: FAKE_PDF });
    expect(await rowOf(daily)).toMatchObject({ state: 'failed', external: false });
    expect((await rowOf(daily))?.error).toContain('외부 수신자로 바뀌어 보내지 않음');
    expect(await rowOf(weekly)).toMatchObject({ state: 'accepted', external: true, view: 'ext', pdf: true });
    const sent = received('moved@example.com').slice(before);
    expect(sent).toHaveLength(1);
    expect(links(mimePart(sent[0]?.raw ?? '', 'text/html') ?? '')).toEqual([]);
    expect(links(mimePart(sent[0]?.raw ?? '', 'text/plain') ?? '')).toEqual([]);
    // 보낼 수 없는 일간 실패는 「해소되지 않은 실패」(실패만 · 배지 · 알림)에서 빠지고, 다시 보내기는 409다.
    expect((await log(true)).some((x) => x.id === daily)).toBe(false);
    const resend = await lead('POST', `/api/mail/log/${daily}/resend`);
    expect(resend.status).toBe(409);
    expect(resend.body.error.message).toContain('외부 수신자');
    expect((await lead('DELETE', `/api/settings/mail/recipients/${r.body.id}?updatedAt=${encodeURIComponent(ext.body.updatedAt)}`)).status).toBe(204);
  });

  test('정리: 외부 수신자를 지운다(뒤 시험의 받는 사람 목록 · 보내는 중 0건을 그대로 둔다)', async () => {
    const partner = await recipient(PARTNER);
    expect((await lead('DELETE', `/api/settings/mail/recipients/${partner.id}?updatedAt=${encodeURIComponent(partner.updatedAt)}`)).status).toBe(204);
    expect((await owner.query<{ n: number }>("select count(*)::int n from mail_outbox where state in ('queued','sending','retry_wait')")).rows[0]?.n).toBe(0);
  });
});

describe('수신자 삭제 · 초기화 경합(G L407-408, data-model §5)', () => {
  test('받는 사람을 삭제해도 발송 기록은 주소와 함께 남는다', async () => {
    const qa = await recipient('qa@example.com');
    const before = (await log()).filter((x) => x.to === 'qa@example.com').length;
    expect((await lead('DELETE', `/api/settings/mail/recipients/${qa.id}?updatedAt=${encodeURIComponent(qa.updatedAt)}`)).status).toBe(204);
    const rows = (await log()).filter((x) => x.to === 'qa@example.com');
    expect(rows).toHaveLength(before);
    expect(rows.every((x) => x.recipientId === null)).toBe(true);
  });

  test('발송 중(응답 대기)에 초기화하면 옛 발송 결과는 새 세대에 다시 생기지 않고, 설정 유지 시 SMTP · 받는 사람은 남는다', async () => {
    const boss = await recipient('boss@example.com');
    const t = await lead('POST', `/api/settings/mail/recipients/${boss.id}/test`);
    expect(t.status).toBe(202);
    const preview = (await lead('GET', '/api/project/reset-preview')).body;
    expect(preview.sending.mail).toBe(0);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let arrived: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    smtp.onMessage = async () => { arrived(); await held; };
    const sending = deliverMail(pool, epoch, { now: kst('2026-11-04', '13:00'), timeoutMs: 10_000 });
    await reached;
    // 이미 SMTP로 보내기 시작한 건수는 초기화 확인 화면에 보인다(회수 불가).
    expect((await lead('GET', '/api/project/reset-preview')).body.sending.mail).toBe(1);
    const name = (await owner.query<{ name: string }>('select name from projects')).rows[0]?.name;
    const reset = await lead('POST', '/api/project/reset', { confirmName: name, keepSettings: true, epoch });
    expect(reset.status).toBe(200);
    const oldEpoch = epoch;
    epoch = reset.body.epoch as number;
    release();
    smtp.onMessage = null;
    // 옛 세대 worker는 결과를 쓰지 못하고 조용히 끝난다(예외로 worker가 죽지 않음).
    await expect(sending).resolves.toBeDefined();
    expect((await owner.query<{ n: number }>('select ((select count(*) from mail_outbox)+(select count(*) from mail_log))::int n')).rows[0]?.n).toBe(0);
    expect(await log()).toEqual([]);
    expect(await mailAlert()).toBeUndefined();
    // 옛 세대 번호로 다시 돌려도 아무것도 보내지 않는다
    const count = smtp.messages.length;
    await expect(deliverMail(pool, oldEpoch, { now: kst('2026-11-04', '13:30'), timeoutMs: TIMEOUT })).rejects.toMatchObject({ code: 'AW001' });
    await deliver(kst('2026-11-04', '13:30'));
    expect(smtp.messages).toHaveLength(count);
    expect((await lead('GET', '/api/settings/mail/smtp')).body).toMatchObject({ host: '127.0.0.1', pwSet: true });
    expect((await recipients()).map((r) => r.email).sort()).toEqual(['boss@example.com', 'lead@example.com']);
  }, 30_000);

  test('설정 삭제 초기화는 SMTP · 비밀번호 · 받는 사람을 모두 지운다', async () => {
    await seedDemo(owner, dbUrl).catch(() => undefined);
    const name = (await owner.query<{ name: string }>('select name from projects')).rows[0]?.name;
    if (!name) {
      // demo를 다시 넣지 못하면 빈 프로젝트를 만든다(초기화에는 프로젝트가 하나 필요하다).
      await owner.query("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('메일 시험','https://github.com/fake/mail','fake','mail','','active')");
    }
    const confirm = (await owner.query<{ name: string }>('select name from projects')).rows[0]?.name;
    const reset = await lead('POST', '/api/project/reset', { confirmName: confirm, keepSettings: false, epoch });
    expect(reset.status).toBe(200);
    epoch = reset.body.epoch as number;
    expect((await lead('GET', '/api/settings/mail/smtp')).body).toMatchObject({ host: '', pwSet: false, updatedAt: null });
    expect(await recipients()).toEqual([]);
    expect((await owner.query<{ n: number }>("select count(*)::int n from secrets where key='smtp-password'")).rows[0]?.n).toBe(0);
  });
});
