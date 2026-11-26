// 0018: 메시지 읽음 표시(read_at)만 바뀌는 UPDATE는 updated_at을 올리지 않는다(contracts §1.3 「메시지 읽음」).
// 왜: 읽음은 내용·전달 상태를 바꾸지 않는 멱등 표시라 화면의 편집 버전(updatedAt)을 낡게 만들면 안 된다.
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem, type Pool } from '../src/index.ts';

const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_message_read';
let pool: Pool;
let message = '';

beforeAll(async () => {
  pool = createPool(dbUrl.href, { max: 2, onError: () => undefined });
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(pool);
  await seedSystem(pool);
  const p = (await pool.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('m','','','','','active') returning id")).rows[0]?.id;
  const ph = (await pool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','p',0) returning id", [p])).rows[0]?.id;
  const wp = (await pool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'w',0) returning id", [p, ph])).rows[0]?.id;
  const t = (await pool.query<{ id: string }>("insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) values($1,'TASK-0001',$2,0,'t','Test','BE','{}',1,'Claude','Codex','ready','none') returning id", [p, wp])).rows[0]?.id;
  message = (await pool.query<{ id: string }>(
    "insert into messages(project_id,task,msg_key,dir,type,from_agent,body,pending_next,work_state,draft) values($1,$2,'MSG-001','in','응답','Claude','b',false,'',false) returning id", [p, t])).rows[0]?.id ?? '';
});
afterAll(async () => { await pool.end(); });

const version = async () => (await pool.query<{ v: string }>("select to_char(updated_at,'YYYY-MM-DD HH24:MI:SS.US') as v from messages where id=$1", [message])).rows[0]?.v;

test('read_at만 바꾸면 updated_at 유지, created_at도 유지', async () => {
  const before = await version();
  await pool.query('update messages set read_at=now(), created_at=now() where id=$1', [message]);
  expect(await version()).toBe(before);
  const row = (await pool.query<{ same: boolean }>('select created_at<updated_at or created_at=updated_at as same from messages where id=$1', [message])).rows[0];
  expect(row?.same).toBe(true);
});

test('다른 열이 바뀌면(함께 바뀌어도) updated_at은 단조 증가', async () => {
  const before = await version();
  await pool.query("update messages set work_state='done', read_at=null where id=$1", [message]);
  const after = await version();
  expect(after && before && after > before).toBe(true);
  await pool.query('update messages set updated_at=$2 where id=$1', [message, '2000-01-01T00:00:00Z']);
  expect(await version()).toBe(after);
});

test('다른 표는 기존 규칙(모든 UPDATE에서 증가) 그대로', async () => {
  const v = async () => (await pool.query<{ v: string }>("select to_char(updated_at,'YYYY-MM-DD HH24:MI:SS.US') as v from tasks where task_key='TASK-0001'")).rows[0]?.v;
  const before = await v();
  await pool.query("update tasks set title=title where task_key='TASK-0001'");
  expect((await v() ?? '') > (before ?? '')).toBe(true);
});
