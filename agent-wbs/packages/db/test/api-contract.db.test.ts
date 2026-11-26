// M1 결합: 실제 DB의 값·제약·초기값 ↔ API 스키마·도메인 타입(M1-01 × M1-02~06)
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import * as v from '@awbs/shared';
import { gradeAdjust, OPERATIONS, proposalReasons } from '@awbs/shared/api';
import * as c from '../../shared/src/api/common.ts';
import * as m from '../../shared/src/api/models.ts';
import {
  CI_STAGE, cleanupResult, createPool, DRIFT_COMPAT, execPolicyToApi, OBSERVATION_GRADE, recreateTestDatabase, seedSystem,
  splitSettingsToDomain,
} from '../src/index.ts';

const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_contract';
const pool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const ajv = new Ajv({ strict: false });
beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  await seedSystem(pool);
});
afterAll(async () => {
  await pool.end();
});

async function transaction(fn: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}
async function rejects(client: pg.PoolClient, sql: string, values: unknown[] = [], code = '23514') {
  await client.query('savepoint invalid');
  await expect(client.query(sql, values)).rejects.toMatchObject({ code });
  await client.query('rollback to savepoint invalid');
}
async function one<T = Record<string, unknown>>(client: pg.ClientBase | pg.Pool, sql: string, values: unknown[] = []) {
  const row = (await client.query(sql, values)).rows[0] as T | undefined;
  assert(row, sql);
  return row;
}

/** 실제 DB가 받는 값: enum이면 그 목록, text면 CHECK의 목록 */
async function allowed(table: string, column: string): Promise<string[]> {
  const type = await one<{ type: string; enum: string[] | null }>(pool, `
    select t.typname as type,
      (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid) as enum
    from pg_attribute a join pg_type t on t.oid=a.atttypid
    where a.attrelid=$1::regclass and a.attname=$2`, [table, column]);
  if (type.enum) return type.enum;
  const defs = (await pool.query<{ def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid=$1::regclass and contype='c'", [table],
  )).rows.map((row) => row.def).filter((def) => new RegExp(`^CHECK \\(\\(${column} = (ANY \\(ARRAY\\[[^\\]]*\\]\\)|'[^']*'::text)\\)\\)$`).test(def));
  assert.equal(defs.length, 1, `${table}.${column}: ${defs.join(' / ')}`);
  return [...(defs[0] ?? '').matchAll(/'((?:[^']|'')*)'(?:::text)?/g)].map((match) => (match[1] ?? '').replaceAll("''", "'"));
}
interface Node { enum?: string[]; anyOf?: Node[]; properties?: Record<string, Node>; items?: Node }
const values = (schema: unknown, ...path: string[]): string[] => {
  const at = schema as Node;
  if (at.anyOf) return [...new Set(at.anyOf.flatMap((item) => values(item, ...path)))];
  const [key, ...rest] = path;
  if (key === undefined) return at.enum ?? [];
  const next = key === '[]' ? at.items : at.properties?.[key];
  return next ? values(next, ...rest) : [];
};
const op = (id: string) => {
  const found = OPERATIONS.find((item) => item.id === id);
  assert(found, id);
  return found;
};
const body = (id: string) => op(id).body;
const sorted = (list: readonly string[]) => [...list].sort();

describe('DB 값 = API 값 = 도메인 값', () => {
  test.each<[string, string, readonly string[]]>([
    ['tasks', 'status', v.TASK_STATUSES], ['tasks', 'work_type', v.WORK_TYPES], ['tasks', 'primary_domain', v.DOMAINS],
    ['tasks', 'assignee_agent', v.AGENTS], ['tasks', 'verif_state', values(c.VerifState)],
    ['task_attempts', 'kind', v.ATTEMPT_KINDS], ['task_attempts', 'status', v.ATTEMPT_STATUSES],
    ['verifications', 'result', v.VERIFICATION_RESULTS], ['task_dependencies', 'dep_type', v.DEPENDENCY_TYPES],
    ['task_designs', 'kind', v.DESIGN_KINDS], ['task_estimates', 'confidence', v.CONFIDENCES],
    ['task_grades', 'role', v.RUN_ROLES],
    ['change_proposals', 'status', values(m.ProposalStatus)], ['change_proposals', 'source', values(m.ProposalSource)],
    ['ci_runs', 'status', values(c.CiStatus)], ['merge_queue', 'status', values(c.QueueStatus)],
    ['replans', 'status', values(op('listReplans').responses[200], 'items', '[]', 'status')],
    ['exec_policy', 'on_usage', values(body('putExecPolicy'), 'onUsage')],
    ['exec_policy', 'on_rework', values(body('putExecPolicy'), 'onRework')],
    ['attempt_observations', 'state', values(c.ObservationState)],
    ['runner_readiness', 'status', values(c.ReadinessStatus)],
    ['runner_sessions', 'end_reason', values(m.RunnerState, 'gaps', '[]', 'reason')],
    ['notify_rules', 'key', values(body('previewNotify') ?? op('previewNotify').query, 'event')],
    ['messages', 'type', values(m.Message, 'type')], ['messages', 'dir', values(m.Message, 'dir')],
    ['messages', 'delivery', values(m.Message, 'delivery')],
    ['tech_decisions', 'authority', values(m.Decision, 'authority')], ['tech_decisions', 'status', values(m.Decision, 'status')],
    ['wbs_nodes', 'kind', values(m.WbsNode, 'kind')], ['system_state', 'cleanup_status', values(m.ProjectState, 'cleanup')],
    ['concurrency_settings', 'mode', values(body('putConcurrency'), 'mode')],
  ])('%s.%s', async (table, column, api) => {
    expect(sorted(await allowed(table, column))).toEqual(sorted(api));
  });

  test.each<[string, string, Record<string, string>, unknown]>([
    ['design_drifts', 'compat', DRIFT_COMPAT, m.Drift],
    ['design_versions', 'compat', DRIFT_COMPAT, m.Drift],
    ['attempt_observations', 'grade', OBSERVATION_GRADE, m.RunnerState],
    ['cli_observation_grades', 'grade', OBSERVATION_GRADE, m.RunnerState],
  ])('%s.%s는 경계에서 바꾼다', async (table, column, map, schema) => {
    const api = table.includes('drift') || table === 'design_versions' ? values(schema, 'compat') : values(schema, 'sessions', '[]', 'grade');
    expect(sorted(Object.keys(map))).toEqual(sorted(api));
    expect(sorted(Object.values(map))).toEqual(sorted(await allowed(table, column)));
  });

  test('CI 단계는 계약 순서의 번호다', async () => {
    expect(Object.keys(CI_STAGE)).toEqual(values(c.CiStage));
    expect(Object.values(CI_STAGE)).toEqual([1, 2, 3, 4]);
    const def = await one<{ def: string }>(pool,
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname='ci_stage'");
    expect(def.def).toContain('stage >= 1');
    expect(def.def).toContain('stage <= 4');
  });

  test('job 종류·Runner 명령 종류', async () => {
    expect(sorted(await allowed('runner_jobs', 'kind'))).toEqual(sorted(values(body('claimJob'), 'kinds', '[]')));
    expect(await allowed('runner_commands', 'kind')).toEqual(values(op('getCommands').responses[200], 'commands', '[]', 'kind'));
  });
});

describe('초기값 = 도메인 기본값', () => {
  test('실행 정책: 계약 이름으로 바꾸면 기본 정책과 같고 응답 스키마를 통과한다', async () => {
    const row = await one(pool, 'select * from exec_policy');
    const api = execPolicyToApi(row as unknown as Parameters<typeof execPolicyToApi>[0], v.DEFAULT_EXEC_POLICY);
    const { onUsage, lowPct, onRework, notifyAt, floors } = v.DEFAULT_EXEC_POLICY;
    expect(api).toEqual({ onUsage, lowPct, onRework, notifyAt, floors, autoRetryLimit: 2, autoReworkLimit: 3 });
    expect(row.low_pct).toBeNull(); // 저장하지 않은 값은 도메인 기본값으로 채운다
    expect(ajv.validate(op('getExecPolicy').responses[200] ?? false, { ...api, updatedAt: null }), ajv.errorsText()).toBe(true);
  });

  test('분할 기준·진행률·effort 매핑', async () => {
    const settings = await one<{ split: Record<string, unknown>; stage_pct: Record<string, number> }>(pool, 'select split,stage_pct from app_settings');
    expect(splitSettingsToDomain(settings.split)).toEqual(v.DEFAULT_SPLIT_SETTINGS);
    expect(settings.stage_pct).toEqual(v.STAGE_PCT);
    const { maxH, minH, ...rest } = settings.split;
    expect(ajv.validate(body('putSplitSettings') ?? false, { updatedAt: null, maxHours: maxH, minHours: minH, ...rest }), ajv.errorsText()).toBe(true);
    const efforts = (await pool.query<{ agent: v.Agent; model_id: string; value: string; common_level: number }>(
      'select agent,model_id,value,common_level from agent_efforts')).rows;
    expect(efforts).toHaveLength(74);
    for (const row of efforts) expect(v.effortLevel(row.agent, row.model_id, row.value), `${row.model_id} ${row.value}`).toBe(row.common_level);
    for (const agent of v.AGENTS) for (const [model, map] of v.EFFORT_MAP[agent]) {
      expect(efforts.filter((row) => row.model_id === model).length, model).toBe(Object.keys(map).length);
    }
  });
});

async function project(client: pg.PoolClient) {
  return (await one<{ id: string }>(client,
    "insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('p','https://github.com/o/r','o','r','base','','active') returning id")).id;
}

describe('API가 요구하는 저장 위치', () => {
  test('CP 제목·사유·출처 ID. 분할 CP는 원래 Task가 필수다', () => transaction(async (client) => {
    const p = await project(client);
    const insert = (key: string, source: string, sourceId: string | null, title = '제목', reason = '사유') => client.query(
      "insert into change_proposals(project_id,cp_key,title,reason,source,source_id,status,ops) values($1,$2,$3,$4,$5,$6,'draft','[]')",
      [p, key, title, reason, source, sourceId]);
    await insert('CP-1', 'manual', null);
    await insert('CP-2', 'split', 'TASK-0001');
    await rejects(client, "insert into change_proposals(project_id,cp_key,title,reason,source,status,ops) values($1,'CP-3','t','r','split','draft','[]')", [p]);
    for (const [title, reason] of [['', 'r'], ['t', ' ']]) {
      await rejects(client, "insert into change_proposals(project_id,cp_key,title,reason,source,status,ops) values($1,'CP-4',$2,$3,'manual','draft','[]')", [p, title, reason]);
    }
    await rejects(client, "insert into change_proposals(project_id,cp_key,source,status,ops) values($1,'CP-5','manual','draft','[]')", [p], '23502');
    const row = await one(client, "select title,reason,source,source_id from change_proposals where cp_key='CP-2'");
    const proposal = { title: row.title, reason: row.reason, source: { kind: row.source, id: row.source_id } };
    expect(ajv.validate(m.Proposal.properties.source, proposal.source)).toBe(true);
  }));

  test('CP 판단·보류 JSON은 API·도메인 결과 그대로 저장된다', () => transaction(async (client) => {
    const p = await project(client);
    const judgement = { result: 'met', agreedBy: ['Claude', 'Codex'], basis: 'b', judgedAt: '2026-11-26T00:00:00Z', sourceRef: 'job-1', subjectHash: 'a'.repeat(64) };
    const split = { schemaVersion: 1, items: [{ rule: 'ac_meaning', ...judgement }] };
    const tasks = [{ taskKey: 'TASK-0001', judgedRules: { schemaVersion: 1, items: [{ rule: 'revert', ...judgement }] } }];
    expect(ajv.validate(m.SplitJudgements, split)).toBe(true);
    expect(ajv.validate(m.Proposal.properties.taskJudgements, tasks)).toBe(true);
    const reasons = proposalReasons([
      { code: 'JUDGEMENT_MISSING', taskKey: 'TASK-0001', rule: 'revert', message: 'm' },
      { code: 'COMPLETED_TASK', index: 0, taskKey: 'TASK-0002', message: 'm' },
      { code: 'EMPTY_PROPOSAL', index: null, message: 'm' },
    ]);
    await client.query(
      "insert into change_proposals(project_id,cp_key,title,reason,source,source_id,status,ops,split_judgements,task_judgements,hold_reasons) values($1,'CP-1','t','r','split','TASK-0001','held','[]',$2,$3,$4)",
      [p, split, JSON.stringify(tasks), reasons]);
    expect((await one(client, 'select hold_reasons from change_proposals')).hold_reasons).toEqual(reasons);
  }));

  test('host 보고의 부팅 ID', () => transaction(async (client) => {
    const { body: host } = { body: { hostId: 'h1', cpu: 'c', cores: 20, memGB: 23, swapGB: 4, diskFreeGB: 952, os: 'WSL2', perSessionGB: 1, samples: 3, bootId: 'b1' } };
    expect(ajv.validate(body('reportHost') ?? false, host)).toBe(true);
    await client.query(
      'insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,per_session_gb,samples,seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())',
      [host.hostId, host.bootId, host.cpu, host.cores, host.memGB, host.swapGB, host.diskFreeGB, host.os, host.perSessionGB, host.samples]);
    expect((await one(client, 'select boot_id from runner_hosts')).boot_id).toBe('b1');
    // host 기록은 추가 전용이라 보고마다 새 행이다.
    await rejects(client, "insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('h1',' ','c',1,1,0,1,'o',0,now())");
  }));

  test('CI 실행은 시작한 job과 fence를 저장한다. job 없는 실행은 야간 점검뿐', () => transaction(async (client) => {
    const p = await project(client);
    const job = (await one<{ id: string }>(client,
      "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'integrate','{}','leased',1,'k') returning id", [p])).id;
    const run = (key: string, stage: keyof typeof CI_STAGE, jobId: string | null, fence: number | null) => client.query(
      "insert into ci_runs(project_id,run_key,stage,pipeline_sha,ref,trigger,status,job,fence,artifacts) values($1,$2,$3,'sha','main','t','queued',$4,$5,'[\"report.xml\"]')",
      [p, key, CI_STAGE[stage], jobId, fence]);
    await run('CI-1', 'int', job, 3);
    await run('CI-2', 'night', null, null);
    await rejects(client, "insert into ci_runs(project_id,run_key,stage,pipeline_sha,ref,trigger,status) values($1,'CI-3',2,'s','main','t','queued')", [p]);
    await rejects(client, "insert into ci_runs(project_id,run_key,stage,pipeline_sha,ref,trigger,status,job) values($1,'CI-4',1,'s','main','t','queued',$2)", [p, job]);
    await rejects(client, "update ci_runs set artifacts='{}' where run_key='CI-1'");
    expect(ajv.validate(body('startCiRun') ?? false, { jobId: job, fence: 3, stage: 'int', ref: 'main', pipelineSha: 'a'.repeat(40), trigger: 't' })).toBe(true);
    // DB에 기본값이 없는 열은 API 시작 요청에서도 필수다.
    expect(ajv.validate(body('startCiRun') ?? false, { jobId: job, fence: 3, stage: 'int', ref: 'main' })).toBe(false);
    expect(ajv.validate(body('startCiRun') ?? false, { stage: 'night', ref: 'main', pipelineSha: 'a'.repeat(40), trigger: '02:00' })).toBe(true);
    const row = await one(client, "select created_at,artifacts from ci_runs where run_key='CI-1'");
    expect(row.artifacts).toEqual(['report.xml']);
  }));

  test('정리 결과: API 본문의 보유별 증거가 DB 함수의 증거가 된다', () => transaction(async (client) => {
    const p = await project(client);
    const node = async (kind: string, parent: string | null) => (await one<{ id: string }>(client,
      'insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,$2,$3,$4,$2,0) returning id', [p, kind, kind, parent])).id;
    const wp = await node('work_package', await node('phase', null));
    const task = (await one<{ id: string }>(client,
      "insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) values($1,'TASK-0001',$2,0,'t','Test','BE','{}',1,'Claude','Codex','ready','none') returning id",
      [p, wp])).id;
    const job = (await one<{ id: string }>(client,
      "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{}','leased',1,'k') returning id", [p])).id;
    await client.query(
      "insert into execution_holds(project_id,job,task,epoch,agent,slots,heavy,host_id,boot_id,fence,slot_state,lock_state) values($1,$2,$3,1,'Claude',1,false,'host','boot',5,'reserved','held')",
      [p, job, task]);
    await client.query("select reset_project(1,'p',true,'lead')");
    const command = await one<{ id: string; epoch: number; payload: { holds: { job: string }[] } }>(client, 'select id,epoch,payload from runner_commands');
    expect(ajv.validate(op('getCommands').responses[200] ?? false, { currentEpoch: 2, commands: [{ id: command.id, kind: 'reset-cleanup', epoch: command.epoch, payload: command.payload }] })).toBe(true);
    const report = (holds: unknown[], status = 'done') => ({ status, items: [{ name: 'worktree', ok: true, detail: '' }], holds });
    const proof = { job, hostId: 'host', bootId: 'boot', proof: 'no_process' };
    expect(ajv.validate(body('reportCommandResult') ?? false, report([proof])), ajv.errorsText()).toBe(true);
    expect(ajv.validate(body('reportCommandResult') ?? false, { status: 'done', items: [] })).toBe(false);
    expect(ajv.validate(body('reportCommandResult') ?? false, { status: 'failed', items: [] })).toBe(true);
    expect(ajv.validate(body('reportCommandResult') ?? false, report([{ ...proof, proof: 'gone' }]))).toBe(false);
    await client.query('set local role awbs_app');
    const call = (value: ReturnType<typeof report>) => {
      const { succeeded, result } = cleanupResult(value as Parameters<typeof cleanupResult>[0]);
      return client.query('select complete_cleanup($1,$2,$3,$4)', [command.id, command.epoch, succeeded, result]);
    };
    await client.query('savepoint wrong');
    await expect(call(report([{ ...proof, bootId: 'other' }]))).rejects.toMatchObject({ code: 'AW002' });
    await client.query('rollback to savepoint wrong');
    await call(report([proof]));
    expect((await one(client, 'select cleanup_status from system_state')).cleanup_status).toBe('none');
  }));

  test('등급 조정 저장 형식은 API GradeAdjust다', () => {
    const result = v.resolveRunGrade({
      kind: 'rework', taskGrade: { modelId: 'gpt-5.5', effort: 'medium', locked: false },
      task: { primaryDomain: 'BE', relatedDomains: [], devLevel: 2 },
      history: [{ kind: 'dev', status: 'completed', modelId: 'gpt-5.5', effort: 'medium' }],
      catalog: { agent: 'Codex', models: [{ modelId: 'gpt-5.5', rank: 1, allowed: true, efforts: ['low', 'medium', 'high', 'xhigh'] }] },
      policy: v.DEFAULT_EXEC_POLICY, remainPct: 50,
    });
    assert(result.ok);
    const adjust = gradeAdjust(result, '재작업 상향');
    expect(ajv.validate(m.GradeAdjust, adjust)).toBe(true);
    return transaction(async (client) => {
      const p = await project(client);
      const { rows } = await client.query("select column_name,data_type from information_schema.columns where table_name='task_attempts' and column_name='grade_adjust'");
      expect(rows).toEqual([{ column_name: 'grade_adjust', data_type: 'jsonb' }]);
      expect(p).toBeTruthy();
    });
  });
});
