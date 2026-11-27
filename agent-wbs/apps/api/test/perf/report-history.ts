/**
 * M6-01 보고서 상태 이력 성능 측정(재리뷰 3 문제 3). 시험이 아니라 측정 스크립트다.
 *
 *   TEST_DATABASE_URL=postgresql://…/awbs_test_x node --conditions=awbs-source apps/api/test/perf/report-history.ts
 *
 * 자료: Task 1,000개(추정·체크리스트·산출물 1개씩), 제목 전체 10회 변경, 모두 paused(보고서의 진행 중 분류에 들어간다).
 * 잰 것: 스냅샷 계산, 실제 HTTP 기간 지정 생성(화면 버튼)·조회(화면 열기), 일반 쓰기 지연(이력 기록 켬/끔 비교).
 * 시간은 performance.now()로 잰다(이 PC의 벽시계는 뒤로 갈 수 있다).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '../../../../packages/db/src/index.ts';
import { seoulDay } from '../../../../packages/shared/src/index.ts';
import { buildApp } from '../../src/app.ts';
import { issueLoginLink } from '../../src/platform/credentials.ts';
import { reportAnchor } from '../../src/reports/service.ts';
import { buildSnapshot } from '../../src/reports/snapshot.ts';

const base = process.env.TEST_DATABASE_URL;
assert(base, 'TEST_DATABASE_URL이 필요합니다.');
const url = new URL(base);
url.pathname += '_perf';
await recreateTestDatabase(url.href);
const owner = createPool(url.href, { max: 10, onError: () => undefined });
const appUrl = new URL(url);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 10, onError: () => undefined });
const N = Number(process.env.TASKS ?? 1000);
const ms = (t: number) => Math.round(performance.now() - t);
const out: Record<string, number | string> = { tasks: N };

await runMigrations(owner);
await seedSystem(owner);
const p = (await owner.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase,start_date) values('성능','https://github.com/o/r','o','r','','active','2026-11-01') returning id")).rows[0]?.id ?? '';
const ph = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','단계',1) returning id", [p])).rows[0]?.id;
const wp = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'묶음',1) returning id", [p, ph])).rows[0]?.id;
let t0 = performance.now();
await owner.query(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,planning_approved_at,act_start)
  select $1,'TASK-'||lpad(n::text,4,'0'),$2,n,'작업 '||n,'Implementation','BE','{}',1,'Claude','Codex','paused','none',now(),now()-interval '1 day' from generate_series(1,$3) n`, [p, wp, N]);
out.insert1000ms = ms(t0);
await owner.query(`insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by) select project_id,id,4,3,6,'상','측정','Claude' from tasks`);
await owner.query(`insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) select project_id,id,'CL-1','확인',true,false,'시험',1 from tasks`);
await owner.query(`insert into task_outputs(project_id,task,name,kind,required,verify,delivered) select project_id,id,'out.ts','파일',true,'시험',false from tasks`);
await owner.query(`insert into task_specs(project_id,task,overview,spec,ac,revision) select project_id,id,'{"doneCond":"완료"}','{}','[]',1 from tasks`);
t0 = performance.now();
for (let i = 0; i < 10; i++) await owner.query(`update tasks set title='작업 '||sort_order||' 변경 ${String(i)}'`);
out.update1000x10ms = ms(t0);
await owner.query('select awbs_settle_commits()');

/** 일반 쓰기 지연: 한 행 변경 100회(매번 커밋), 8개 연결에서 서로 다른 행 240회 */
async function writes(label: string) {
  let t = performance.now();
  for (let i = 0; i < 100; i++) await pool.query("update tasks set title='단일 '||$1 where task_key='TASK-0001'", [i]);
  out[`${label}_single100ms`] = ms(t);
  t = performance.now();
  await Promise.all(Array.from({ length: 8 }, (_, w) => (async () => {
    for (let i = 0; i < 30; i++) await pool.query("update tasks set title='동시 '||$1 where task_key=$2", [i, `TASK-${String(w * 30 + i + 2).padStart(4, '0')}`]);
  })()));
  out[`${label}_concurrent240ms`] = ms(t);
}
await writes('logOn');

/** 스냅샷 계산(운영 순서: 기준점 → 반복 읽기) */
async function snapshot() {
  const c = await pool.connect();
  const slow: [number, string][] = [];
  if (process.env.PROFILE) {
    type Fn = (...args: unknown[]) => Promise<unknown>;
    const raw = c as unknown as { query: Fn };
    const query = raw.query.bind(c);
    raw.query = async (...args: unknown[]) => { const t = performance.now(); const r = await query(...args); slow.push([ms(t), String(args[0]).replace(/\s+/g, ' ').slice(0, 90)]); return r; };
  }
  try {
    const at = await reportAnchor(c);
    await c.query('begin isolation level repeatable read read only');
    const t = performance.now();
    const s = await buildSnapshot(c, p, { kind: 'custom', from: '2026-11-01', to: seoulDay(at), at });
    const took = ms(t);
    await c.query('commit');
    assert.equal(s.all.length, N);
    if (process.env.PROFILE) console.log(slow.sort((x, y) => y[0] - x[0]).slice(0, 5));
    return took;
  } finally { c.release(); }
}
const runs = [await snapshot(), await snapshot(), await snapshot()];
out.snapshotMs = runs.sort((a, b) => a - b)[1] ?? -1;

// 실제 HTTP: 화면의 「보고서 생성」(POST)과 「보고서 열기」(GET)
const origin = 'http://127.0.0.1:3100';
const app = buildApp(pool, false, { origin, lan: false });
const srv = await app.listen({ host: '127.0.0.1', port: 0 });
const login = await fetch(`${srv}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'link', token: await issueLoginLink(pool) }) });
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const { csrfToken } = await (await fetch(`${srv}/api/session`, { headers: { cookie } })).json() as { csrfToken: string };
const today = seoulDay(new Date());
const created: number[] = [];
const opened: number[] = [];
for (let i = 0; i < 3; i++) {
  let t = performance.now();
  const r = await fetch(`${srv}/api/projects/${p}/reports`, { method: 'POST', headers: { cookie, origin, 'x-csrf-token': csrfToken, 'x-project-epoch': '1', 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: JSON.stringify({ from: today, to: today, view: 'int' }) });
  created.push(ms(t));
  assert.equal(r.status, 201, await r.clone().text());
  const { id } = await r.json() as { id: string };
  t = performance.now();
  const g = await fetch(`${srv}/api/reports/${id}`, { headers: { cookie } });
  await g.text();
  opened.push(ms(t));
}
out.httpCreateMs = created.sort((a, b) => a - b)[1] ?? -1;
out.httpOpenMs = opened.sort((a, b) => a - b)[1] ?? -1;
await app.close();

// 비교: 이력 기록을 끈 같은 표에서 같은 쓰기(관리자만 할 수 있는 측정 전용 조작)
await owner.query('alter table tasks disable trigger state_log');
await writes('logOff');
await owner.query('alter table tasks enable trigger state_log');
out.stateLogRows = (await owner.query<{ n: number }>('select count(*)::int n from state_log')).rows[0]?.n ?? -1;

console.log(JSON.stringify(out, null, 2));
await pool.end();
await owner.end();
