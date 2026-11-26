/**
 * M6-01 보고서 시나리오(milestones M6-01 완료 조건, G§12 시나리오 16, §4.11, §8.5, §9.6, milestones §4.0).
 *
 * 준비: 빈 시험 DB → 마이그레이션 → demo seed(원본 P MOCK 12 Task·시도·검증·결함·메시지).
 * demo에 없는 실행 PC 세션(중단 구간)·재조정 기록·자정 경계 시각은 아래 `fixture()`가 넣는다.
 * 보고서는 이 기록을 **읽기만** 한다. 그래서 기록을 직접 넣어도 보고서 판정을 대신하지 않는다.
 * 팀장 동작(목록·생성·조회)은 실제 HTTP 요청이다. 정기 생성은 worker가 부르는 같은 함수를 시각만 정해 부른다.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import {
  addDays, externalView, internalKpis, internalTerms, seoulDay, snapshotProblem, type ReportSnapshotData,
} from '../../../packages/shared/src/index.ts';
import { createPool, recreateTestDatabase, runMigrations, seedDemo, type Pool } from '../../../packages/db/src/index.ts';
import { buildApp } from '../../../apps/api/src/app.ts';
import { issueLoginLink } from '../../../apps/api/src/platform/credentials.ts';
import { generateDueReports } from '../../../apps/api/src/reports/service.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
interface Report { id: string; reportKey?: string; kind: string; from: string; to: string; view: string; generatedAt: string; dueAt: string | null; reason: string | null }

let owner: Pool;
let pool: Pool;
let close: () => Promise<void>;
let lead: (method: string, path: string, body?: object) => Promise<{ status: number; body: Body }>;

/** 서울 날짜·시각 → UTC ISO */
const kst = (day: string, hm = '00:00') => new Date(`${day}T${hm}:00+09:00`).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');

async function fixture() {
  // 원본 프로젝트 시작일(P MOCK project.start). 등록 시각 기본값(오늘) 대신 원본 값을 쓴다.
  await owner.query("update projects set start_date='2026-10-27', target_date='2026-11-12'");
  // 자정 경계: TASK-0002는 10-28 23:59:59.999(서울)에, TASK-0003은 10-29 00:00:00(서울)에 완료.
  await owner.query("update tasks set act_start=$1, act_end=$2 where task_key='TASK-0002'", [kst('2026-10-28', '20:00'), '2026-10-28T14:59:59.999Z']);
  await owner.query("update tasks set act_start=$1, act_end=$2 where task_key='TASK-0003'", [kst('2026-10-28', '21:00'), '2026-10-28T15:00:00.000Z']);
  // 실행 PC 세션: 10-29 22:00 재부팅으로 끊겨 10-30 01:00에 다시 연결(자정을 넘는 중단 3시간).
  await owner.query(`insert into runner_sessions(runner_id,started_at,ended_at,end_reason,last_heartbeat_at) values
    ('pc-1',$1,$2,'reboot',$2),('pc-1',$3,null,null,$4)`, [kst('2026-10-27', '09:00'), kst('2026-10-29', '22:00'), kst('2026-10-30', '01:00'), kst('2026-11-27', '00:00')]);
  // 재조정 기록 2건: 기간 시작 전(10-25)과 기간 중(10-31). 두 번째는 TASK-0007을 밀었다.
  const project = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id;
  const t7 = (await owner.query<{ id: string }>("select id from tasks where task_key='TASK-0007'")).rows[0]?.id;
  await owner.query(`insert into replans(project_id,rp_key,trigger,actor,baseline_v,status,before,after,created_at) values
    ($1,'RP-001','초기 WBS 등록','Planning Agent',1,'applied','{"end":null}','{"end":"2026-11-07","lo":"2026-11-06","hi":"2026-11-10"}',$2)`, [project, kst('2026-10-25', '10:00')]);
  const rp2 = (await owner.query<{ id: string }>(`insert into replans(project_id,rp_key,trigger,actor,baseline_v,status,before,after,created_at) values
    ($1,'RP-002','QA FAIL — TASK-0007 재작업','시스템',2,'applied','{"end":"2026-11-07"}','{"end":"2026-11-10","lo":"2026-11-08","hi":"2026-11-14"}',$2) returning id`, [project, kst('2026-10-31', '10:00')])).rows[0]?.id;
  await owner.query(`insert into replan_moves(project_id,task,replan,kind,before,after,created_at) values($1,$2,$3,'delayed','{"end":"2026-11-04"}','{"end":"2026-11-06"}',$4)`, [project, t7, rp2, kst('2026-10-31', '10:00')]);
  // QA FAIL의 Evidence 경로(P verifs V-0007-1 evidence). demo seed는 검증 Evidence 행을 넣지 않는다.
  await owner.query(`insert into evidence(project_id,task,verification,kind,reference_path)
    select v.project_id,a.task,v.id,'log',p from verifications v join task_attempts a on a.id=v.attempt,
    unnest(array['evidence/TASK-0007/qa-1/vitest.txt','evidence/TASK-0007/qa-1/perf.json','evidence/TASK-0007/qa-1/filter-missing-parent.png']) p
    where a.task=$1 and v.result='FAIL'`, [t7]);
  // 확인할 알림 1건(대시보드 알림과 같은 표)
  await owner.query(`insert into alerts(project_id,key,severity,target,created_at) values($1,'usage:Claude','warn','{"message":"Claude 사용량 부족 — 실행 보류"}',$2)`, [project, kst('2026-10-30', '09:00')]);
}

beforeAll(async () => {
  const db = new URL(inject('testDatabaseUrl'));
  db.pathname += '_reports_scenario';
  await recreateTestDatabase(db.href);
  owner = createPool(db.href, { onError: () => undefined });
  const appUrl = new URL(db);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  pool = createPool(appUrl.href, { onError: () => undefined });
  const origin = 'http://127.0.0.1:3100';
  const app = buildApp(pool, false, { origin, lan: false });
  close = async () => { await app.close(); await pool.end(); await owner.end(); };
  await runMigrations(owner);
  await seedDemo(owner, db.href);
  await fixture();
  const link = await issueLoginLink(pool);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await fetch(`${baseUrl}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'link', token: link }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  const { csrfToken } = await (await fetch(`${baseUrl}/api/session`, { headers: { cookie } })).json() as { csrfToken: string };
  lead = async (method, path, body) => {
    const response = await fetch(baseUrl + path, { method, headers: { cookie, origin, 'x-csrf-token': csrfToken, 'x-project-epoch': '1', 'idempotency-key': randomUUID(), ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Body };
  };
}, 60_000);
afterAll(async () => { await close(); });

const projectId = async () => (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id ?? '';
const list = async (kind?: string): Promise<Report[]> => (await lead('GET', `/api/projects/${await projectId()}/reports?limit=200${kind ? `&kind=${kind}` : ''}`)).body.items as Report[];
const open = async (id: string) => (await lead('GET', `/api/reports/${id}`)).body as Report & { snapshot: ReportSnapshotData; changesSince: { replans: number; currentEnd: string | null; reportEnd: string | null } };
const find = async (kind: string, from: string) => {
  const r = (await list(kind)).find((x) => x.from === from);
  assert(r, `${kind} ${from} 보고서가 없다`);
  return open(r.id);
};

describe('정기 생성 · 누락 보충 · 중복 0', () => {
  test('서버 시작 때 누락분을 보충한다: 11-04 07:00(서울) 기준 일간 10-27~11-03, 주간 10-26~11-01', async () => {
    const created = await generateDueReports(pool, 1, { now: kst('2026-11-04', '07:00'), startup: true });
    expect(created).toBe(9);
    const daily = await list('daily');
    expect(daily.map((r) => r.from).sort()).toEqual(['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
    const weekly = await list('weekly');
    expect(weekly.map((r) => [r.from, r.to])).toEqual([['2026-10-26', '2026-11-01']]);
    // 「누락분 보충 — 예정 YYYY-MM-DD 07:00」 표시에 필요한 값(G L377)
    expect(weekly[0]?.dueAt).toBe(kst('2026-11-02', '07:00'));
    expect(weekly[0]?.reason).toBe('서버 시작 시 누락분 보충');
    expect(weekly[0]?.reportKey).toBe('RPT-W-261026');
    expect(daily.find((r) => r.from === '2026-10-27')?.reportKey).toBe('RPT-D-261027');
    // 목록은 최신순(G§8.5)
    expect(daily[0]?.from).toBe('2026-11-03');
  });

  test('같은 시각에 두 worker가 동시에 점검해도, 다시 점검해도 같은 기간 보고서는 하나다', async () => {
    const now = kst('2026-11-05', '07:00');
    const counts = await Promise.all([generateDueReports(pool, 1, { now }), generateDueReports(pool, 1, { now }), generateDueReports(pool, 1, { now })]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await generateDueReports(pool, 1, { now })).toBe(0);
    const dup = (await owner.query("select kind,\"from\",\"to\",count(*)::int n from reports where kind<>'custom' group by 1,2,3 having count(*)>1")).rows;
    expect(dup).toEqual([]);
    const late = (await list('daily')).find((r) => r.from === '2026-11-04');
    expect(late?.reason).toBe('정기 생성');
  });

  test('DB가 막는다: 같은 종류·기간의 정기 보고서를 직접 다시 넣으면 고유 인덱스가 거부한다', async () => {
    await expect(pool.query(`insert into reports(project_id,report_key,kind,"from","to",view,snapshot,generated_at,reason)
      select project_id,'RPT-D-dup',kind,"from","to",view,snapshot,generated_at,reason from reports where kind='daily' limit 1`)).rejects.toThrow(/one_periodic_report/);
  });

  test('07:00 전에는 어제 보고서를 만들지 않는다', async () => {
    expect(await generateDueReports(pool, 1, { now: kst('2026-11-06', '06:59') })).toBe(0);
  });
});

describe('자정(서울) 경계', () => {
  test('23:59:59.999 완료는 그날, 00:00:00 완료는 다음 날 일간에 들어간다', async () => {
    const d28 = await find('daily', '2026-10-28');
    const d29 = await find('daily', '2026-10-29');
    expect(d28.snapshot.done.map((t) => t.taskKey).sort()).toEqual(['TASK-0001', 'TASK-0002']);
    expect(d29.snapshot.done.map((t) => t.taskKey)).toEqual(['TASK-0003']);
  });
  test('자정을 넘는 중단은 두 날에 나뉘어 들어간다(10-29 22:00~24:00 120분, 10-30 00:00~01:00 60분)', async () => {
    expect((await find('daily', '2026-10-29')).snapshot.gaps.map((g) => [g.minutes, g.reason])).toEqual([[120, 'reboot']]);
    expect((await find('daily', '2026-10-30')).snapshot.gaps.map((g) => [g.minutes, g.reason])).toEqual([[60, 'reboot']]);
  });
});

describe('§4.0 보고서 12섹션 필드(값이 있는 주간 RPT-W-261026)', () => {
  let s: ReportSnapshotData;
  beforeAll(async () => { s = (await find('weekly', '2026-10-26')).snapshot; });

  test('스냅샷은 계약 스키마에 맞다', () => { expect(snapshotProblem(s)).toBeNull(); });
  test('1. 완료·작업량 완료율·예상과 범위·가동률, 상태 분포', () => {
    const m = s.summary;
    expect([m.taskCount, m.doneCount, m.doneBefore]).toEqual([12, 3, 0]);
    // 작업량(추정 시간) 가중: (1.5+1+3) / 전체 추정 합
    expect(m.workPct).toBeGreaterThan(0);
    expect([m.forecast, m.lo, m.hi, m.forecastBefore]).toEqual(['2026-11-10', '2026-11-08', '2026-11-14', '2026-11-07']);
    expect(m.uptimePct).toBeGreaterThan(0);
    expect(m.uptimePct).toBeLessThan(100);
    expect(m.statuses.find((x) => x.status === 'done')?.count).toBe(3);
    expect(m.target).toBe('2026-11-12');
  });
  test('2. 알림·보류 CP·전달 실패·재작업', () => {
    const texts = s.issues.map((i) => i.text).join('\n');
    expect(texts).toContain('Claude 사용량 부족');
    expect(texts).toContain('메시지 MSG-003 전달 실패 (TASK-0005)');
    // demo seed의 변경 제안(CP-002 review)은 등록 시각(오늘)에 생겼다. 생성 시각(11-04)보다 늦어 이 보고서에는 없다.
    expect(texts).not.toContain('CP-002');
    expect(s.issues.some((i) => i.taskKey === 'TASK-0007' && i.text.includes('재작업 필요'))).toBe(true);
  });
  test('3. 일별 5지표(주간: 7일)', () => {
    expect(s.series.map((x) => x.day)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    const d28 = s.series[2];
    expect(d28 && [d28.done, d28.attempts, d28.fails]).toEqual([2, 2, 0]);
    const n1 = s.series[6];
    expect(n1 && [n1.attempts, n1.fails, n1.forecast]).toEqual([2, 1, '2026-11-10']);
    expect(s.series[0]?.forecast).toBe('2026-11-07');
  });
  test('4. 완료한 Task: 분류·담당·기간·추정/실제/시도·기준 대비·명령→결과·체크리스트·산출물·완료 조건', () => {
    const t = s.done.find((x) => x.taskKey === 'TASK-0001');
    assert(t);
    expect([t.assignee, t.verifier, t.workType, t.domain, t.estHours, t.attempts]).toEqual(['Claude', 'Codex', expect.any(String), expect.any(String), 1.5, 2]);
    expect(t.actualHours).toBeGreaterThan(0);
    expect(t.verification?.result).toBe('PASS');
    expect(t.verification?.cmd).toBeTruthy();
    expect(t.checklist.total).toBeGreaterThan(0);
    expect(t.outputs.names.length).toBeGreaterThan(0);
    expect(t.doneCond).toBeTruthy();
    expect('slipDays' in t).toBe(true);
  });
  test('5. 진행 중 Task: 상태·진행률·실제 시작·예상/범위·기준 대비·남은 작업량·최근 실행/등급·검증·체크리스트·Gate·미충족 조건·이슈·다음 작업', () => {
    const t = s.active.find((x) => x.taskKey === 'TASK-0007');
    assert(t);
    expect(t.status).toBe('rework');
    expect(t.progressPct).toBeGreaterThan(0);
    expect(t.actStart).toBe(kst('2026-11-01', '10:02'));
    expect(t.end).not.toBeNull();
    expect(t.remainHours).not.toBeNull();
    expect(t.lastAttempt?.attemptKey).toBe('ATT-0007-2');
    expect(t.lastAttempt?.grade?.modelId).toBeTruthy();
    expect(t.verification?.result).toBe('FAIL');
    expect(t.gate.unmet.length).toBeGreaterThan(0);
    expect(t.gate.passed + t.gate.unmet.length).toBe(5);
    expect(t.blockingDefects).toBe(2);
    expect(t.next).toContain('재작업');
  });
  test('6. QA 실패: 명령·기대/실제·결함·Evidence·후속 조치', () => {
    const f = s.failures[0];
    assert(f);
    expect([f.taskKey, f.cmd !== '', f.expected !== '', f.actual !== '']).toEqual(['TASK-0007', true, true, true]);
    expect(f.defects).toHaveLength(2);
    expect(f.evidence).toHaveLength(3);
    expect(f.messages.map((m) => m.msgKey)).toEqual(['MSG-001']);
    expect(f.reworks).toEqual([]);
  });
  test('7. 실행 기록: 시도·Agent·모델/Effort·시간·결과·요약·조정 사유·파일 수/토큰', () => {
    expect(s.attempts.map((a) => a.attemptKey)).toEqual(['ATT-0001-1', 'ATT-0001-2', 'ATT-0007-1', 'ATT-0007-2']);
    const a = s.attempts[0];
    assert(a);
    expect([a.agent, a.grade?.modelId, a.grade?.effort, a.status, a.tokens]).toEqual(['Claude', 'claude-sonnet-5-5', 'low', 'completed', 210]);
    expect(a.endedAt).not.toBeNull();
    expect('adjust' in a && 'files' in a && 'summary' in a).toBe(true);
    expect(s.summary.attempts).toMatchObject({ total: 4, dev: 2, qa: 2, pass: 1, fail: 1, tokens: 880 });
  });
  test('8. 재조정: 계기·예상 변화/범위·이동 Task 전후 날짜/일수', () => {
    expect(s.replans).toHaveLength(1);
    const r = s.replans[0];
    assert(r);
    expect([r.replanId, r.trigger, r.before, r.after, r.lo, r.hi]).toEqual(['RP-002', 'QA FAIL — TASK-0007 재작업', '2026-11-07', '2026-11-10', '2026-11-08', '2026-11-14']);
    expect(r.moved).toEqual([{ taskKey: 'TASK-0007', title: expect.any(String), kind: 'delayed', before: '2026-11-04', after: '2026-11-06', deltaDays: 2 }]);
  });
  test('9. 작업 환경 중단: 기간·시간·사유', () => {
    expect(s.gaps).toEqual([{ from: kst('2026-10-29', '22:00'), to: kst('2026-10-30', '01:00'), minutes: 180, reason: 'reboot' }]);
  });
  test('10. 메시지: 시각·Task·방향·유형·전달 상태·첫 줄', () => {
    expect(s.messages.map((m) => [m.taskKey, m.dir, m.type, m.delivery])).toEqual([['TASK-0007', 'out', '수정 요청', 'Acknowledged'], ['TASK-0007', 'in', '응답', null]]);
    expect(s.messages[0]?.firstLine).toBeTruthy();
    expect(s.messages[0]?.firstLine.includes('\n')).toBe(false);
  });
  test('11. 다음 주 예정: 상태·예상 기간·담당/등급·선행·충돌 묶음', () => {
    expect(s.next.length).toBeGreaterThan(0);
    expect(s.next.length).toBeLessThanOrEqual(8);
    for (const n of s.next) {
      expect(n.start <= addDays('2026-11-01', 7) && n.end >= '2026-11-02').toBe(true);
      expect(['status', 'estHours', 'grade', 'blockers', 'conflictGroup', 'assignee'].every((k) => k in n)).toBe(true);
    }
  });
  test('12. 전체 Task 표의 모든 열', () => {
    expect(s.all).toHaveLength(12);
    const t = s.all.find((x) => x.taskKey === 'TASK-0007');
    expect(t && Object.keys(t).sort()).toEqual(['assignee', 'blocked', 'checklist', 'end', 'progressPct', 'slipDays', 'status', 'taskKey', 'title', 'verifState', 'verifier', 'wbsPath'].sort());
    expect(s.all.map((x) => x.wbsPath)).toEqual([...s.all.map((x) => x.wbsPath)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  });
});

describe('팀장용 ↔ 보고용(같은 스냅샷)', () => {
  test('핵심 숫자가 같고, 보고용 문장에 내부 용어 0건', async () => {
    const s = (await find('weekly', '2026-10-26')).snapshot;
    const int = internalKpis(s);
    const ext = externalView(s, 'weekly');
    expect(ext.kpis[0]?.value).toBe(int[0]?.value);
    expect(ext.kpis[1]?.value).toBe(int[1]?.value);
    expect(ext.kpis[2]?.value.slice(5)).toBe(int[2]?.value);
    expect(ext.trend.map((x) => x.done)).toEqual(s.series.map((x) => x.done));
    // 같은 스냅샷의 팀장용 값에는 내부 용어가 있다(검사기가 실제로 찾는다는 증거).
    expect(internalTerms(JSON.stringify(s)).length).toBeGreaterThan(0);
    expect(internalTerms(JSON.stringify(ext))).toEqual([]);
  });
});

describe('시나리오 16: 주간 보고서 → 생성 이후 재조정 표시 → 기간 지정(지난 주) 생성', () => {
  test('「생성 이후 일정 재조정 N회 — 현재 완료 예상 X (보고서 기준 Y)」 값', async () => {
    const before = await find('weekly', '2026-10-26');
    expect(before.changesSince.replans).toBe(0);
    expect(before.changesSince.reportEnd).toBe('2026-11-10');
    const project = await projectId();
    await owner.query(`insert into replans(project_id,rp_key,trigger,actor,baseline_v,status,before,after) values($1,'RP-003','팀장 재조정','팀장',3,'applied','{"end":"2026-11-10"}','{"end":"2026-11-12","lo":"2026-11-10","hi":"2026-11-16"}')`, [project]);
    const after = await open(before.id);
    expect(after.changesSince.replans).toBe(1);
    expect(after.changesSince.currentEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 스냅샷은 바뀌지 않는다(열 때 다시 계산하지 않음, G L373)
    expect(after.snapshot).toEqual(before.snapshot);
  });

  test('기간 지정 「지난 주」를 보고용으로 만들고 목록에서 연다', async () => {
    const today = seoulDay(new Date());
    const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
    const from = addDays(monday, -7);
    const to = addDays(monday, -1);
    const created = await lead('POST', `/api/projects/${await projectId()}/reports`, { from, to, view: 'ext' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'custom', reportKey: 'RPT-C-001', from, to, view: 'ext', dueAt: null, reason: '팀장 지정' });
    const listed = await list('custom');
    expect(listed.map((r) => r.id)).toContain(created.body.id);
    const doc = await open(created.body.id as string);
    expect(doc.snapshot.series).toHaveLength(7);
    expect(snapshotProblem(doc.snapshot)).toBeNull();
    // 오늘 만든 보고서에는 검토 대기 변경 제안이 「팀장 확인 필요」로 들어간다.
    expect(doc.snapshot.issues.map((i) => i.text)).toContain('CP-002 Change Proposal 검토 대기 — ' + String((await owner.query("select title from change_proposals where cp_key='CP-002'")).rows[0]?.title));
  });
});

describe('기간 지정 입력 · 불변', () => {
  const today = seoulDay(new Date());
  test.each([
    ['시작 > 끝', addDays(today, -1), addDays(today, -2)],
    ['끝 > 오늘', today, addDays(today, 1)],
    ['94일', addDays(today, -93), today],
  ])('%s → 400 VALIDATION_FAILED', async (_name, from, to) => {
    const r = await lead('POST', `/api/projects/${await projectId()}/reports`, { from, to, view: 'int' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
  });
  test.each([['from', '2026-02-30'], ['to', '0000-01-01']])('달력에 없는 날짜 %s=%s → 400, 오류 위치는 그 칸', async (field, bad) => {
    const r = await lead('POST', `/api/projects/${await projectId()}/reports`, { from: addDays(today, -1), to: today, view: 'int', [field]: bad });
    expect(r.status).toBe(400);
    expect((r.body.error.errors as { path: string }[]).map((e) => e.path)).toEqual([field]);
  });
  test('93일은 허용', async () => {
    expect((await lead('POST', `/api/projects/${await projectId()}/reports`, { from: addDays(today, -92), to: today, view: 'int' })).status).toBe(201);
  });
  test('없는 프로젝트 → 404', async () => {
    expect((await lead('POST', `/api/projects/${randomUUID()}/reports`, { from: today, to: today, view: 'int' })).status).toBe(404);
  });
  test('수정·삭제 API가 없고, DB도 앱 권한의 수정·삭제를 거부한다(G§9.6-1)', async () => {
    const id = (await list())[0]?.id;
    assert(id);
    expect((await lead('PATCH', `/api/reports/${id}`, { reason: 'x' })).status).toBe(404);
    expect((await lead('DELETE', `/api/reports/${id}`)).status).toBe(404);
    await expect(pool.query("update reports set reason='x' where id=$1", [id])).rejects.toThrow();
    await expect(pool.query('delete from reports where id=$1', [id])).rejects.toThrow();
  });
  test('없는 보고서 → 404', async () => {
    expect((await lead('GET', `/api/reports/${randomUUID()}`)).status).toBe(404);
  });
});

describe('누락 보충 상한(G L1047)', () => {
  test('오래 꺼져 있었으면 한 번에 31건까지 만들고, 다음 점검이 이어서 만든다', async () => {
    const now = kst('2027-01-31', '08:00');
    const before = (await list('daily')).length;
    await generateDueReports(pool, 1, { now, startup: true });
    expect((await list('daily')).length - before).toBe(31);
    // 남은 것은 다음 점검들이 31건씩 이어서 만든다.
    for (let k = 0; k < 5 && await generateDueReports(pool, 1, { now }) > 0; k++) { /* 이어서 보충 */ }
    const all = (await list('daily')).map((r) => r.from).sort();
    expect(all.at(-1)).toBe('2027-01-30');
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('§4.0 빈 상태(값이 하나도 없을 때)', () => {
  test('기록 없는 날 보고서: 기간 섹션이 모두 비어 있다', async () => {
    const s = (await find('daily', '2026-10-27')).snapshot;
    expect([s.done, s.failures, s.attempts, s.replans, s.gaps, s.messages, s.series]).toEqual([[], [], [], [], [], [], []]);
    expect(s.summary.started).toEqual([]);
    expect(s.summary.attempts.total).toBe(0);
  });
  test('Task가 하나도 없으면 상태 분포·진행 중·예정·전체 표도 비어 있다', async () => {
    await owner.query('update tasks set deleted_at=now()');
    const today = seoulDay(new Date());
    const r = await lead('POST', `/api/projects/${await projectId()}/reports`, { from: today, to: today, view: 'int' });
    expect(r.status).toBe(201);
    const s = (await open(r.body.id as string)).snapshot;
    expect([s.summary.taskCount, s.summary.statuses, s.active, s.next, s.all, s.done]).toEqual([0, [], [], [], [], []]);
    expect(snapshotProblem(s)).toBeNull();
    const ext = externalView(s, 'custom');
    expect(ext.highlights).toEqual([]);
    expect(ext.plan).toEqual([]);
  });
});
