// M2-08 DB 테스트 공용 준비물: 전용 테스트 DB·앱·팀장 세션·Runner 토큰·프로젝트/Task 만들기.
import assert from 'node:assert/strict';
import { createPool, recreateTestDatabase, runMigrations, seedSystem, type Pool } from '@awbs/db';
import { inject } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { registerRunnerMessageRoutes } from '../src/messages/routes.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';

export const origin = 'http://127.0.0.1:3100';

// 테스트는 응답 본문의 여러 필드를 바로 읽는다. 모양 검사는 각 단언이 한다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = any;
export interface Response { status: number; body: Body; headers: Record<string, unknown> }
export interface Harness {
  owner: Pool; pool: Pool; app: FastifyInstance;
  lead: (method: InjectOptions['method'], url: string, payload?: unknown, extra?: Record<string, string>) => Promise<Response>;
  runner: (method: InjectOptions['method'], url: string, payload?: unknown, key?: string) => Promise<Response>;
  close: () => Promise<void>;
}

/** 이름마다 다른 테스트 DB(`awbs_test_..._<name>`)를 만들고 migrate·system seed를 적용한다. */
export async function harness(name: string): Promise<Harness> {
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += `_${name}`;
  const owner = createPool(url.href, { max: 4, onError: () => undefined });
  await recreateTestDatabase(url.href);
  await runMigrations(owner);
  await seedSystem(owner);
  const appUrl = new URL(url);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  const pool = createPool(appUrl.href, { max: 8, onError: () => undefined });
  const app = buildApp(pool, false, { origin, lan: false });
  registerRunnerMessageRoutes(app);
  const bearer = await issueRunnerToken(pool, 'runner-1', 'fake-public-key');
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  assert.equal(login.statusCode, 204, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
  const shape = (res: LightMyRequestResponse): Response => ({ status: res.statusCode, body: res.body ? safeJson(res.body) : null, headers: res.headers });
  return {
    owner, pool, app,
    lead: async (method, url, payload, extra = {}) => shape(await app.inject({
      method, url, headers: { cookie, origin, 'x-csrf-token': csrf, ...extra }, ...(payload === undefined ? {} : { payload: payload as object }),
    } as InjectOptions)),
    runner: async (method, url, payload, key = crypto.randomUUID()) => {
      const epoch = (await owner.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch ?? 1;
      return shape(await app.inject({
        method, url, headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': String(epoch), 'idempotency-key': key },
        ...(payload === undefined ? {} : { payload: payload as object }),
      } as InjectOptions));
    },
    close: async () => { await app.close(); await pool.end(); await owner.end(); },
  };
}

const safeJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };

export interface ProjectFixture { project: string; wp: string; tasks: Record<string, string> }

/** 프로젝트 1개와 Work Package 1개, 지정한 상태의 Task들(TASK-0001부터)을 만든다. */
export async function projectWith(owner: Pool, statuses: readonly string[], extra: { assignee?: string; verifier?: string } = {}): Promise<ProjectFixture> {
  const project = (await owner.query<{ id: string }>(
    "insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('m208','https://github.com/o/r','o','r','base','','active') returning id",
  )).rows[0]?.id as string;
  const phase = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH-1','phase','phase',0) returning id", [project])).rows[0]?.id;
  const wp = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP-1','work_package',$2,'wp',0) returning id", [project, phase])).rows[0]?.id as string;
  const tasks: Record<string, string> = {};
  for (const [index, status] of statuses.entries()) {
    const key = `TASK-${String(index + 1).padStart(4, '0')}`;
    tasks[key] = (await owner.query<{ id: string }>(
      `insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state)
       values($1,$2,$3,$4,$2,'Implementation','BE','{}',1,$5,$6,$7,'none') returning id`,
      [project, key, wp, index, extra.assignee ?? 'Claude', extra.verifier ?? 'Codex', status],
    )).rows[0]?.id as string;
  }
  return { project, wp, tasks };
}

/** Runner 작업(job)과 시도(attempt)를 만든다. 시도 상태는 running/completed/failed/interrupted. */
export async function attemptFor(owner: Pool, project: string, task: string, input: { kind?: string; status?: string; modelId?: string; effort?: string; no?: number; agent?: string }): Promise<string> {
  const job = (await owner.query<{ id: string }>(
    "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{}','done',1,gen_random_uuid()::text) returning id", [project],
  )).rows[0]?.id;
  const status = input.status ?? 'running';
  const no = input.no ?? 1;
  return (await owner.query<{ id: string }>(
    `insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,kind,agent,status,started_at,ended_at,model_id,effort)
     values($1,$2,$3,$4,$5,'base','head',1,$6,$7,$8,now(),case when $9 then null else now() end,$10,$11) returning id`,
    [project, task, `ATT-${String(no)}-${crypto.randomUUID().slice(0, 4)}`, no, job, input.kind ?? 'dev', input.agent ?? 'Claude', status,
      status === 'running', input.modelId ?? 'claude-opus-5-5', input.effort ?? 'high'],
  )).rows[0]?.id as string;
}
