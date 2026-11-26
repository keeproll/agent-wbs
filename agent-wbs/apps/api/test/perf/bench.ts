/**
 * Task 대량 목록 성능 측정(srv-perf). 시험이 아니라 손으로 돌리는 측정 도구다.
 *
 *   TEST_DATABASE_URL=postgres://awbs_owner:...@127.0.0.1:<port>/awbs_test_perf \
 *     node --conditions=awbs-source apps/api/test/perf/bench.ts 200 1000 5000
 *
 * - 대상 DB는 awbs_test_로 시작해야 하며 매 크기마다 지우고 다시 만든다(안전장치는 recreateTestDatabase).
 * - 데이터: Phase 4 × Work Package 5, Task N개(Task마다 체크리스트 2·산출물 1·추정 1, 의존성 약 N개, 일부 완료·실행 중).
 * - 측정: listTasks·getSchedule을 한 번 데운 뒤 3회씩 app.inject로 부른 시간(ms)과 응답 크기.
 * - 결과는 표준 출력에 Markdown 표로, `--json <파일>`을 주면 JSON으로도 남긴다.
 */
import { createPool, recreateTestDatabase, runMigrations, seedDemo, seedSystem } from '@awbs/db';
import { writeFileSync } from 'node:fs';
import { buildApp } from '../../src/app.ts';
import { issueLoginLink } from '../../src/platform/credentials.ts';

const origin = 'http://127.0.0.1:3100';
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonFile = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const sizes = args.filter((arg, index) => /^\d+$/.test(arg) && (jsonAt < 0 || index !== jsonAt + 1) && (args.indexOf('--dump') < 0 || index !== args.indexOf('--dump') + 1)).map(Number);
/** `--demo`: M3-02와 같은 모양(demo seed 12건 + 추정·의존성 없는 계획 중 Task)으로 채운다. */
const demo = args.includes('--demo');
/** `--dump <폴더>`: 마지막 응답 본문을 남긴다(고치기 전후 결과 비교용). */
const dumpAt = args.indexOf('--dump');
const dumpDir = dumpAt >= 0 ? args[dumpAt + 1] : undefined;
const url = process.env.TEST_DATABASE_URL;
if (!url || !sizes.length) throw new Error('사용법: TEST_DATABASE_URL=... node bench.ts 200 1000 5000 [--json out.json]');

const STATUSES = ['planning', 'planning', 'ready', 'ready', 'done', 'done', 'done', 'running', 'qa', 'approval'] as const;

/** M3-02 측정과 같은 모양: demo seed 뒤에 추정·의존성 없는 계획 중 Task를 Work Package마다 고르게 더한다. */
async function seedLikeM302(ownerUrl: string, n: number) {
  const owner = createPool(ownerUrl, { max: 2, onError: () => undefined });
  try {
    await runMigrations(owner);
    await seedDemo(owner, ownerUrl);
    const projectId = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id ?? '';
    const wps = (await owner.query<{ id: string }>("select id from wbs_nodes where project_id=$1 and kind='work_package' order by node_key", [projectId])).rows.map((row) => row.id);
    const have = Number((await owner.query<{ n: string }>('select count(*) n from tasks where project_id=$1', [projectId])).rows[0]?.n ?? 0);
    await owner.query(`
      insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state)
      select $1,'TASK-'||lpad(i::text,4,'0'),($2::uuid[])[1+(i % cardinality($2::uuid[]))],1000+i,'대량 Task '||i,'Implementation',
             case when i%2=0 then 'BE' else 'FE' end::domain,'{}'::domain[],2,'Claude','Codex','planning','none'
        from generate_series($3::int,$4::int) i`, [projectId, wps, have + 1, n]);
    await owner.query("update counters set value=$2 where project_id=$1 and kind='task'", [projectId, n]);
    await owner.query(`insert into task_specs(project_id,task,overview,spec,ac,revision)
      select project_id,id,'{"purpose":"p","background":"","scope":[],"out":[],"precond":"","doneCond":"d"}'::jsonb,'{}'::jsonb,'[]'::jsonb,1
        from tasks t where project_id=$1 and not exists(select 1 from task_specs s where s.task=t.id)`, [projectId]);
    await owner.query('analyze');
    return projectId;
  } finally { await owner.end(); }
}

async function seed(ownerUrl: string, n: number) {
  const owner = createPool(ownerUrl, { max: 2, onError: () => undefined });
  try {
    await runMigrations(owner);
    await seedSystem(owner);
    const projectId = (await owner.query<{ id: string }>(
      "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('성능','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id ?? '';
    const wps: string[] = [];
    for (let p = 0; p < 4; p++) {
      const phase = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,$2,'phase',null,$2,$3) returning id",
        [projectId, `P${String(p)}`, p])).rows[0]?.id;
      for (let w = 0; w < 5; w++) {
        wps.push((await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,$2,'work_package',$3,$2,$4) returning id",
          [projectId, `P${String(p)}W${String(w)}`, phase, w])).rows[0]?.id ?? '');
      }
    }
    // 한 문장으로 N개를 넣는다(generate_series). 상태는 순환, Work Package는 고르게 나눈다.
    await owner.query(`
      insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,
                        act_start,act_end)
      select $1,'TASK-'||lpad(i::text,4,'0'),($2::uuid[])[1+(i % 20)],i/20,'작업 '||i,'Implementation','BE','{}'::domain[],i%4,
             case when i%3=0 then 'Codex' else 'Claude' end::agent,case when i%3=0 then 'Claude' else 'Codex' end::agent,
             ($3::text[])[1+(i % 10)]::task_status,'none',
             case when ($3::text[])[1+(i % 10)] in ('done','running','qa') then now()-make_interval(hours=>i%200+10) end,
             case when ($3::text[])[1+(i % 10)]='done' then now()-make_interval(hours=>i%200) end
        from generate_series(1,$4::int) i`, [projectId, wps, STATUSES, n]);
    await owner.query("insert into counters(project_id,kind,value) values($1,'task',$2)", [projectId, n]);
    await owner.query(`insert into task_specs(project_id,task,overview,spec,ac,revision)
      select project_id,id,'{"purpose":"목적","background":"","scope":[],"out":[],"precond":"","doneCond":"완료"}'::jsonb,'{}'::jsonb,'[]'::jsonb,1 from tasks where project_id=$1`, [projectId]);
    await owner.query(`insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order)
      select t.project_id,t.id,'CL-'||k,'확인 '||k,k=1,t.status='done','',k from tasks t cross join generate_series(1,2) k where t.project_id=$1`, [projectId]);
    await owner.query(`insert into task_outputs(project_id,task,name,kind,required,verify,delivered)
      select project_id,id,'코드','코드',true,'테스트',status='done' from tasks where project_id=$1`, [projectId]);
    await owner.query(`insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by)
      select project_id,id,4+(substring(task_key from 6)::int % 5),3,12,'중','측정','Claude' from tasks where project_id=$1`, [projectId]);
    // 의존성: 같은 Work Package 안의 바로 앞 Task(FS) + 10개마다 다른 Work Package의 앞 Task(SS). 순환은 없다(앞 번호 → 뒤 번호).
    await owner.query(`insert into task_dependencies(project_id,pred,succ,dep_type)
      select s.project_id,p.id,s.id,'FS' from tasks s join tasks p on p.project_id=s.project_id
        and substring(p.task_key from 6)::int=substring(s.task_key from 6)::int-20 where s.project_id=$1`, [projectId]);
    await owner.query(`insert into task_dependencies(project_id,pred,succ,dep_type)
      select s.project_id,p.id,s.id,'SS' from tasks s join tasks p on p.project_id=s.project_id
        and substring(p.task_key from 6)::int=substring(s.task_key from 6)::int-7 where s.project_id=$1 and substring(s.task_key from 6)::int % 10=0`, [projectId]);
    await owner.query('analyze');
    return projectId;
  } finally { await owner.end(); }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const results: { n: number; list: number[]; schedule: number[]; listBytes: number; scheduleBytes: number }[] = [];
for (const n of sizes) {
  await recreateTestDatabase(url);
  const projectId = await (demo ? seedLikeM302 : seed)(url, n);
  const appUrl = new URL(url);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  const pool = createPool(appUrl.href, { max: 10, onError: () => undefined });
  const app = buildApp(pool, false, { origin, lan: false });
  try {
    const token = await issueLoginLink(pool);
    const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
    if (login.statusCode !== 204) throw new Error(`로그인 실패 ${String(login.statusCode)} ${login.body}`);
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const time = async (path: string) => {
      const started = performance.now();
      const response = await app.inject({ url: path, headers: { cookie, origin } });
      const ms = Math.round(performance.now() - started);
      if (response.statusCode !== 200) throw new Error(`${path} ${String(response.statusCode)} ${response.body.slice(0, 300)}`);
      return { ms, bytes: Buffer.byteLength(response.body), body: response.body };
    };
    const listPath = `/api/projects/${projectId}/tasks`;
    await time(listPath);
    await time('/api/schedule');
    const list: number[] = [];
    const schedule: number[] = [];
    let listBytes = 0;
    let scheduleBytes = 0;
    for (let i = 0; i < 3; i++) {
      const a = await time(listPath);
      list.push(a.ms); listBytes = a.bytes;
      const b = await time('/api/schedule');
      schedule.push(b.ms); scheduleBytes = b.bytes;
      if (dumpDir && i === 2) {
        writeFileSync(`${dumpDir}/list-${String(n)}.json`, a.body);
        writeFileSync(`${dumpDir}/schedule-${String(n)}.json`, b.body);
      }
    }
    results.push({ n, list, schedule, listBytes, scheduleBytes });
    console.error(`n=${String(n)} list=${list.join('·')} schedule=${schedule.join('·')}`);
  } finally { await app.close(); await pool.end(); }
}

console.log('| Task 수 | listTasks 3회(ms) | 중앙값 | 응답 크기(byte) | getSchedule 3회(ms) | 중앙값 | 응답 크기(byte) |');
console.log('|---:|---|---:|---:|---|---:|---:|');
for (const r of results) {
  console.log(`| ${String(r.n)} | ${r.list.join(' · ')} | ${String(median(r.list))} | ${String(r.listBytes)} | ${r.schedule.join(' · ')} | ${String(median(r.schedule))} | ${String(r.scheduleBytes)} |`);
}
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(results, null, 2));
