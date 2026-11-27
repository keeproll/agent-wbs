/**
 * M6-01 보고서 1,000 Task 성능(재리뷰 3 문제 3). 목표: 화면의 「보고서 생성」·「보고서 열기」가 각각 2초 이내.
 * 화면 공용 API 클라이언트의 제한은 10초다(shared/api/client.ts). 이전 구현은 Task마다 과거 행을 다시 되살려 10초를 넘겼다.
 *
 * 자료: Task 1,000개(추정·체크리스트·산출물·명세 1개씩), 제목 전체 10회 변경, 모두 paused(보고서의 진행 중 분류에 들어간다).
 * 시간은 performance.now()로 잰다(이 PC의 벽시계는 뒤로 갈 수 있다). 통계 갱신(ANALYZE)을 하지 않은 직후 상태로 잰다.
 * 자세한 측정(쓰기 지연 비교)은 apps/api/test/perf/report-history.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { seoulDay } from '../../../packages/shared/src/index.ts';
import { createPool, recreateTestDatabase, runMigrations, seedSystem, type Pool } from '../../../packages/db/src/index.ts';
import { buildApp } from '../../../apps/api/src/app.ts';
import { issueLoginLink } from '../../../apps/api/src/platform/credentials.ts';

let owner: Pool;
let pool: Pool;
let projectId = '';
let close: () => Promise<void> = () => Promise.resolve();

beforeAll(async () => {
  const db = new URL(inject('testDatabaseUrl'));
  db.pathname += '_reports_perf';
  await recreateTestDatabase(db.href);
  owner = createPool(db.href, { onError: () => undefined });
  const appUrl = new URL(db);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  pool = createPool(appUrl.href, { onError: () => undefined });
  close = async () => { await pool.end(); await owner.end(); };
  await runMigrations(owner);
  await seedSystem(owner);
  projectId = (await owner.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase,start_date) values('성능','https://github.com/o/r','o','r','','active','2026-11-01') returning id")).rows[0]?.id ?? '';
  const ph = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','단계',1) returning id", [projectId])).rows[0]?.id;
  const wp = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'묶음',1) returning id", [projectId, ph])).rows[0]?.id;
  await owner.query(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,planning_approved_at,act_start)
    select $1,'TASK-'||lpad(n::text,4,'0'),$2,n,'작업 '||n,'Implementation','BE','{}',1,'Claude','Codex','paused','none',now(),now()-interval '1 day' from generate_series(1,1000) n`, [projectId, wp]);
  await owner.query("insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by) select project_id,id,4,3,6,'상','측정','Claude' from tasks");
  await owner.query("insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) select project_id,id,'CL-1','확인',true,false,'시험',1 from tasks");
  await owner.query("insert into task_outputs(project_id,task,name,kind,required,verify,delivered) select project_id,id,'out.ts','파일',true,'시험',false from tasks");
  await owner.query(`insert into task_specs(project_id,task,overview,spec,ac,revision) select project_id,id,'{"doneCond":"완료"}','{}','[]',1 from tasks`);
  for (let i = 0; i < 10; i++) await owner.query(`update tasks set title='작업 '||sort_order||' 변경 ${String(i)}'`);
}, 120_000);
afterAll(async () => { await close(); });

test('Task 1,000개(진행 중 1,000개)에서 화면의 보고서 생성·열기가 각각 2초 이내다', async () => {
  const origin = 'http://127.0.0.1:3100';
  const app = buildApp(pool, false, { origin, lan: false });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const login = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'link', token: await issueLoginLink(pool) }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    const { csrfToken } = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json() as { csrfToken: string };
    const today = seoulDay(new Date());
    let t = performance.now();
    const r = await fetch(`${base}/api/projects/${projectId}/reports`, { method: 'POST', headers: { cookie, origin, 'x-csrf-token': csrfToken, 'x-project-epoch': '1', 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: JSON.stringify({ from: today, to: today, view: 'int' }) });
    const created = performance.now() - t;
    expect(r.status, await r.clone().text()).toBe(201);
    const { id } = await r.json() as { id: string };
    t = performance.now();
    const g = await fetch(`${base}/api/reports/${id}`, { headers: { cookie } });
    const doc = await g.json() as { snapshot: { all: unknown[]; active: unknown[] } };
    const opened = performance.now() - t;
    expect([doc.snapshot.all.length, doc.snapshot.active.length]).toEqual([1000, 1000]);
    console.log(`M6-01 1,000 Task: 생성 ${String(Math.round(created))}ms, 열기 ${String(Math.round(opened))}ms`);
    expect(created).toBeLessThan(2000);
    expect(opened).toBeLessThan(2000);
  } finally { await app.close(); }
}, 60_000);
