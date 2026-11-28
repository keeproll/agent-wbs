import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '../../../packages/db/src/index.ts';
import { buildApp } from '../../../apps/api/src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../../../apps/api/src/platform/credentials.ts';
import { installRunner } from '../../../apps/api/src/runner/routes.ts';
import { registerRunnerMessageRoutes } from '../../../apps/api/src/messages/routes.ts';
import { installProjectRunner } from '../../../apps/api/src/project/runner-routes.ts';
import { watchRunner } from '../../../apps/api/src/runner/watch.ts';
import { installCiRunner } from '../../../apps/api/src/ci/routes.ts';
import { recheckMergedTasks } from '../../../apps/api/src/execution/recheck.ts';
import { FakeRunner } from '../runner.ts';

// HTTP 응답의 상세 모양은 각 시나리오가 검증한다. Runner 요청은 생성 클라이언트가 검사한다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
export const HEAD = 'a'.repeat(40);

/** inputCommit: 입력 v1(등록 커밋). 실제 git 저장소로 입력 보고를 시험할 때 그 저장소의 커밋을 넣는다. */
export async function scenario(options: { inputCommit?: string; logger?: Parameters<typeof buildApp>[1] } = {}) {
  const db = new URL(inject('testDatabaseUrl'));
  db.pathname += '_runner_scenario';
  await recreateTestDatabase(db.href);
  const owner = createPool(db.href, { onError: () => undefined });
  const appUrl = new URL(db);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  const pool = createPool(appUrl.href, { onError: () => undefined });
  const dataRoot = await mkdtemp(join(tmpdir(), 'awbs-scenario-data-'));
  const origin = 'http://127.0.0.1:3100';
  const app = buildApp(pool, options.logger ?? false, { origin, lan: false }, { dataRoot });
  installRunner(app, pool);
  registerRunnerMessageRoutes(app);
  // main.ts와 같은 Runner 경로 묶음(M2-03 프로젝트 보고 포함).
  installProjectRunner(app, pool);
  installCiRunner(app);
  try {
    await runMigrations(owner);
    await seedSystem(owner);
    const project = (await owner.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('시나리오','https://github.com/fake/runner','fake','runner','','active') returning id")).rows[0]?.id;
    assert(project);
    const input = (await owner.query<{ id: string }>("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,$2,'[]','[]','[]','') returning id", [project, options.inputCommit ?? HEAD])).rows[0]?.id;
    const phase = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','단계',1) returning id", [project])).rows[0]?.id;
    const wp = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'묶음',1) returning id", [project, phase])).rows[0]?.id;
    for (const [index, agent, model] of [[1, 'Claude', 'claude-sonnet-5-5'], [2, 'Codex', 'gpt-6.1-sol']] as const) {
      const key = `TASK-000${String(index)}`;
      const id = (await owner.query<{ id: string }>(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,planning_approved_at,src_input_version)
        values($1,$2,$3,$4,'시나리오 시험','Implementation','BE','{}',1,$5,'Codex','ready','none',now(),$6) returning id`, [project,key,wp,index,agent,input])).rows[0]?.id;
      await owner.query("insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,'{}','{}','[]',1)", [project,id]);
      await owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,'dev',$3,'high','시나리오 준비',false,now()),($1,$2,'qa','gpt-6.1-sol','high','시나리오 준비',false,now())", [project,id,model]);
      await owner.query("insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) values($1,$2,'CL-1','수용 기준 확인',true,false,'테스트',1)", [project,id]);
      await owner.query("insert into task_outputs(project_id,task,name,kind,required,verify,delivered) values($1,$2,'src/result.ts','파일',true,'테스트',false)", [project,id]);
      await owner.query("insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by) values($1,$2,2,1,3,'상','고정 시험 자료','Claude,Codex')", [project,id]);
    }
    const token = await issueRunnerToken(pool, 'm209-fake', '무료 가짜 실행기');
    const link = await issueLoginLink(pool);
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await fetch(`${baseUrl}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'link', token: link }) });
    assert.equal(login.status, 204);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
    const { csrfToken } = await session.json() as { csrfToken: string };
    const lead = async (method: string, path: string, body?: object) => {
      const response = await fetch(baseUrl + path, { method, headers: { cookie, origin, 'x-csrf-token': csrfToken, 'x-project-epoch': '1', 'idempotency-key': randomUUID(), ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Body };
    };
    const runner = new FakeRunner(baseUrl, token);
    await runner.initialize();
    // 허용 여부는 팀장 설정이다. 준비 단계에서만 고정하며 시나리오 동작을 DB로 대신하지 않는다.
    await owner.query('update agent_models set allowed=true');
    const version = async () => (await lead('GET', '/api/tasks/TASK-0001')).body.updatedAt as string;
    return {
      runner, lead, pool, project,
      rows: async (sql: string) => (await owner.query(sql)).rows,
      run: async (key: string) => lead('POST', `/api/tasks/${key}/runs`, { kind: 'dev', updatedAt: (await lead('GET', `/api/tasks/${key}`)).body.updatedAt }),
      resume: async (attempt: string) => lead('POST', `/api/attempts/${attempt}/resume`, { updatedAt: await version() }),
      message: async (id: string): Promise<Body> => ((await lead('GET', '/api/messages?limit=200')).body.items as { id: string }[]).find(m => m.id === id),
      // 실제 감시 함수를 미래 시각으로 실행한다. 3분을 기다리는 대신 같은 만료 판정을 사용한다.
      watchDisconnected: () => watchRunner(pool, 1, new Date(Date.now() + 240_000)),
      recheckCompletion: () => recheckMergedTasks(pool),
      close: async () => { await app.close(); await pool.end(); await owner.end(); await rm(dataRoot, { recursive: true, force: true }); },
    };
  } catch (error) {
    await app.close(); await pool.end(); await owner.end(); await rm(dataRoot, { recursive: true, force: true }); throw error;
  }
}

export type Scenario = Awaited<ReturnType<typeof scenario>>;
