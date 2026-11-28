import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, expect, inject, test } from 'vitest';
import { harness, projectWith, type Harness, type ProjectFixture } from './m208-fixture.ts';
import { installRunner } from '../src/runner/routes.ts';
import { reissueJobs, openJobs, jobsTable } from '../src/platform/jobs.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { requestEstimate } from '../src/planning/estimate.ts';
import { requestSplit } from '../src/planning/split.ts';
import { requestPlanning } from '../src/planning/sessions.ts';
import { lockTask } from '../src/tasks/write.ts';
import { createPlanningJob, followUpJob, lockPlanningJob, currentRunnerJob } from '../src/project/jobs.ts';
import { BOOT_STEPS, INPUT_STEPS } from '../src/project/steps.ts';
import { jobPayloadErrors } from '@awbs/shared/api';
import { insertCp, inputOf } from '../src/planning/proposals.ts';
import { evaluate } from '../src/planning/evaluate.ts';
import { requestJudgement } from '../src/planning/jobs.ts';

let h: Harness;
let fixture: ProjectFixture;
const secret = 'never-print-payload-secret';
const estimate = () => inEpoch(h.pool, 1, client => requestEstimate(client, fixture.project, [fixture.tasks['TASK-0001'] as string],
  { reason: 'model_disallowed', trigger: '허용 모델 변경', targets: [{ taskKey: 'TASK-0001', roles: ['dev'] }] }, 1, crypto.randomUUID()));
const through = async () => (await openJobs(h.pool)).through;
async function row(id: string) { return (await h.owner.query('select * from runner_jobs where id=$1', [id])).rows[0] as { state: string; fence: number; payload: Record<string, unknown>; record_no: string }; }

beforeAll(async () => {
  h = await harness('jobs_reissue', installRunner);
  fixture = await projectWith(h.owner, ['planning']);
  await h.owner.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,$2,'{}','[]','[]','첫 입력')", [fixture.project, 'a'.repeat(40)]);
});
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await h.owner.query("update runner_jobs set state='cancelled',lease_owner=null,lease_until=null where state not in ('done','failed','cancelled')");
  await h.owner.query("update planning_jobs set status='cancelled' where status in ('queued','running')");
  await h.owner.query("update runner_sessions set last_heartbeat_at=clock_timestamp()-interval '1 hour' where ended_at is null");
});

test('queued 옛 추정은 현재 입력으로 재생성하고 fence·append-only 이력·재실행 멱등을 지킨다', async () => {
  const old = await estimate();
  await h.owner.query("update runner_jobs set payload=payload||jsonb_build_object('obsolete',$2::text),fence=7 where id=$1", [old, secret]);
  await h.owner.query("update tasks set title='지금 제목' where id=$1", [fixture.tasks['TASK-0001']]);
  const cutoff = await through();
  expect(await reissueJobs(h.pool, cutoff)).toEqual([{ old, next: null }]);
  expect((await row(old)).state).toBe('queued');
  const [result] = await reissueJobs(h.pool, cutoff, true);
  expect(result?.next).toBeTruthy();
  expect(await row(old)).toMatchObject({ state: 'cancelled', fence: 8 });
  const next = await row(result?.next as string);
  expect(next.payload).not.toHaveProperty('obsolete');
  expect(JSON.stringify(next.payload)).toContain('지금 제목');
  expect(jobPayloadErrors('estimate', next.payload)).toEqual([]);
  expect(await reissueJobs(h.pool, cutoff, true)).toEqual([]);
  expect((await h.pool.query("select detail from runner_job_events where job=$1 and code='CONTRACT_CHANGED'", [old])).rows).toEqual([{ detail: { replacementJobId: result?.next, through: cutoff } }]);
  expect((await h.pool.query("select ref from task_history where ref->>'oldJobId'=$1", [old])).rows).toEqual([{ ref: { code: 'CONTRACT_CHANGED', oldJobId: old, jobId: result?.next } }]);
  await expect(h.pool.query("update runner_job_events set code='changed' where job=$1", [old])).rejects.toMatchObject({ code: '42501' });
  await expect(h.pool.query("update task_history set text='changed' where ref->>'oldJobId'=$1", [old])).rejects.toMatchObject({ code: '42501' });
});

test.each(['leased', 'started', 'reconcile'])('%s가 남으면 queued job을 포함한 변경 전체를 거부한다', async state => {
  const old = await estimate();
  const active = await estimate();
  await h.owner.query('update runner_jobs set state=$2 where id=$1', [active, state]);
  await expect(reissueJobs(h.pool, await through(), true)).rejects.toThrow('임대·실행·대조');
  expect((await row(old)).state).toBe('queued');
  expect((await row(active)).state).toBe(state);
});

test('최근 heartbeat가 있으면 실행과 미리보기를 거부한다', async () => {
  const old = await estimate();
  await h.owner.query("insert into runner_sessions(runner_id,started_at,last_heartbeat_at) values('alive',clock_timestamp(),clock_timestamp())");
  for (const confirm of [false, true]) await expect(reissueJobs(h.pool, await through(), confirm)).rejects.toThrow('heartbeat');
  expect((await row(old)).state).toBe('queued');
});

test('끊긴 heartbeat는 허용하되 queued 행에 남은 활성 임대도 거부한다', async () => {
  const old = await estimate();
  await h.owner.query("insert into runner_sessions(runner_id,started_at,last_heartbeat_at) values('stopped',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour')");
  await h.owner.query("update runner_jobs set lease_until=clock_timestamp()+interval '1 hour' where id=$1", [old]);
  await expect(reissueJobs(h.pool, await through(), true)).rejects.toThrow('임대·실행·대조');
  await h.owner.query('update runner_jobs set lease_until=null where id=$1', [old]);
  expect(await reissueJobs(h.pool, await through(), true)).toHaveLength(1);
});

test('종료 미확인 보유는 끝난 job이어도 거부하고 jobs open에 개수를 표시한다', async () => {
  const old = await estimate();
  await h.owner.query("insert into execution_holds(project_id,job,epoch,host_id,boot_id,fence,agent,slots,heavy,slot_state,lock_state) values($1,$2,1,'host','boot',0,'Codex',1,false,'reserved','none')", [fixture.project, old]);
  await h.owner.query("update execution_holds set slot_state='unconfirmed' where job=$1", [old]);
  try {
    await h.owner.query("update runner_jobs set state='cancelled' where id=$1", [old]);
    expect((await openJobs(h.pool)).holds).toBe(1);
    await expect(reissueJobs(h.pool, await through(), true)).rejects.toThrow('열린 실행 보유');
  } finally {
    await h.owner.query("update execution_holds set slot_state='none',release_proof='no_process',closed_at=clock_timestamp() where job=$1", [old]);
  }
});

test('두 번째 생성이 실패하면 첫 취소·새 job·이력을 모두 되돌린다', async () => {
  const first = await estimate();
  const invalid = (await h.owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'split','{}','queued',1,$2) returning id", [fixture.project, crypto.randomUUID()])).rows[0]?.id as string;
  const cutoff = await through();
  await expect(reissueJobs(h.pool, cutoff, true)).rejects.toThrow('분할 대상');
  expect((await row(first)).state).toBe('queued');
  expect((await row(invalid)).state).toBe('queued');
  expect((await openJobs(h.pool)).through).toBe(cutoff);
  expect((await h.pool.query("select 1 from runner_job_events where job=$1 and code='CONTRACT_CHANGED'", [first])).rowCount).toBe(0);
});

test('동시 재실행도 상한 안의 옛 job당 한 번만 재발급한다', async () => {
  await estimate();
  const cutoff = await through();
  const results = await Promise.all([reissueJobs(h.pool, cutoff, true), reissueJobs(h.pool, cutoff, true)]);
  expect(results.map(result => result.length).sort()).toEqual([0, 1]);
});

test('순번 상한·종류 선택은 생성 시각과 무관하며 목록 조회는 DB를 바꾸지 않는다', async () => {
  const first = await estimate();
  const cutoff = await through();
  const second = await estimate();
  const excluded = (await h.owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key,created_at) values($1,'repo_check','{}','queued',1,$2,'2000-01-01') returning id", [fixture.project, crypto.randomUUID()])).rows[0]?.id as string;
  const before = (await h.owner.query('select id,state,fence,updated_at from runner_jobs order by record_no')).rows;
  const view = await openJobs(h.pool);
  expect(view.jobs.map(job => job.id)).toEqual([first, second, excluded]);
  expect((await h.owner.query('select id,state,fence,updated_at from runner_jobs order by record_no')).rows).toEqual(before);
  expect(await reissueJobs(h.pool, cutoff, true, ['planning'])).toEqual([]);
  expect(await reissueJobs(h.pool, cutoff, true, ['estimate'])).toHaveLength(1);
  expect((await row(second)).state).toBe('queued');
  expect((await row(excluded)).state).toBe('queued');
});

test('분할은 현재 Task·WBS·정책을 원래 생성 함수로 다시 읽는다', async () => {
  const old = await inEpoch(h.pool, 1, async client => requestSplit(client, await lockTask(client, 'TASK-0001'), 1));
  await h.owner.query("update tasks set title='새 분할 제목' where id=$1", [fixture.tasks['TASK-0001']]);
  const [result] = await reissueJobs(h.pool, await through(), true);
  expect(result?.old).toBe(old);
  expect(JSON.stringify((await row(result?.next as string)).payload)).toContain('새 분할 제목');
  expect(jobPayloadErrors('split', (await row(result?.next as string)).payload)).toEqual([]);
});

test('Planning 세션은 현재 제목·범위를 다시 읽는다', async () => {
  const id = (await h.owner.query<{ id: string }>("insert into plannings(project_id,planning_key,title,scope,status) values($1,$2,'이전 제목','\"범위\"','analyzing') returning id", [fixture.project, crypto.randomUUID()])).rows[0]?.id as string;
  const old = await inEpoch(h.pool, 1, client => requestPlanning(client, id, 1));
  await h.owner.query("update plannings set title='현재 Planning' where id=$1", [id]);
  const [result] = await reissueJobs(h.pool, await through(), true);
  expect(result?.old).toBe(old);
  expect((await row(result?.next as string)).payload.planning).toMatchObject({ id, title: '현재 Planning' });
});

test('CP 판단은 원래 제안을 현재 상태로 재평가하여 다시 만든다', async () => {
  const old = await inEpoch(h.pool, 1, async client => {
    const cp = await insertCp(client, fixture.project, { title: '완료 조건 변경', reason: '계약 변경', source: { kind: 'manual' },
      ops: [{ op: 'modify', task: 'TASK-0001', field: 'doneCond', after: '새 완료 조건' }] }, '팀장', 'review');
    const ev = await evaluate(client, inputOf(cp));
    expect(ev.needsJudgement).toBe(true);
    return requestJudgement(client, cp, ev, 1);
  });
  expect(old).toBeTruthy();
  await h.owner.query("update tasks set title='CP 재평가 현재 제목' where id=$1", [fixture.tasks['TASK-0001']]);
  const [result] = await reissueJobs(h.pool, await through(), true);
  expect(result?.old).toBe(old);
  expect(JSON.stringify((await row(result?.next as string)).payload)).toContain('CP 재평가 현재 제목');
  expect(jobPayloadErrors('planning', (await row(result?.next as string)).payload)).toEqual([]);
});

test('등급 변경 추정은 현재 gradeChange와 등급을 다시 읽는다', async () => {
  const marker = crypto.randomUUID();
  await h.owner.query("insert into task_history(project_id,task,kind,actor,text,ref) values($1,$2,'실행 등급','팀장','등급 변경',$3)", [fixture.project, fixture.tasks['TASK-0001'], { gradeChange: marker }]);
  const old = await inEpoch(h.pool, 1, client => requestEstimate(client, fixture.project, [fixture.tasks['TASK-0001'] as string],
    { reason: 'grade_changed', trigger: '등급 변경', targets: [{ taskKey: 'TASK-0001', roles: ['dev'] }] }, 1, crypto.randomUUID()));
  const nextMarker = crypto.randomUUID();
  await h.owner.query("insert into task_history(project_id,task,kind,actor,text,ref) values($1,$2,'실행 등급','팀장','새 등급 변경',$3)", [fixture.project, fixture.tasks['TASK-0001'], { gradeChange: nextMarker }]);
  const [result] = await reissueJobs(h.pool, await through(), true);
  expect(result?.old).toBe(old);
  expect((await row(result?.next as string)).payload.policy).toMatchObject({ gradeChange: nextMarker });
  expect(jobPayloadErrors('estimate', (await row(result?.next as string)).payload)).toEqual([]);
});

test.each(['bootstrap', 'input_diff'] as const)('%s는 현재 DB 입력으로 만들고 현재 실행 순번을 갱신한다', async kind => {
  if (kind === 'input_diff') await h.owner.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,2,$2,'{}','[]','[]','현재 입력')", [fixture.project, 'b'.repeat(40)]);
  const old = await inEpoch(h.pool, 1, async client => {
    const id = await createPlanningJob(client, { projectId: fixture.project, kind, instruction: '현재 지시', stepKeys: kind === 'bootstrap' ? BOOT_STEPS : INPUT_STEPS });
    return followUpJob(client, await lockPlanningJob(client, id), 1, { resumeStep: null });
  });
  await h.owner.query("update runner_jobs set payload=payload||jsonb_build_object('obsolete',$2::text) where id=$1", [old, secret]);
  const [result] = await reissueJobs(h.pool, await through(), true);
  const next = await row(result?.next as string);
  expect(next.payload).not.toHaveProperty('obsolete');
  expect(next.payload).toMatchObject({ commit: (kind === 'input_diff' ? 'b' : 'a').repeat(40), instruction: '현재 지시' });
  expect(await currentRunnerJob(h.pool, String(next.payload.planningJobId))).toBe(result?.next);
  expect(jobPayloadErrors(kind, next.payload)).toEqual([]);
  expect((await h.pool.query('select 1 from planning_job_logs where job=$1 and text like $2', [next.payload.planningJobId, '계약 변경 재발급%'])).rowCount).toBe(1);
});

test('늦은 일반 Runner 보고와 Planning 보고는 상태·fence 변경 후 각각 LEASE_LOST다', async () => {
  const old = await estimate();
  await h.owner.query("update runner_jobs set fence=12,lease_owner='runner:runner-1',lease_until=clock_timestamp()-interval '1 hour' where id=$1", [old]);
  await reissueJobs(h.pool, await through(), true);
  for (const fence of [12, 13]) {
    const general = await h.runner('POST', `/api/runner/jobs/${old}/finish`, { fence, status: 'done', result: {} });
    expect(general.status).toBe(409);
    expect(general.body.error.code).toBe('LEASE_LOST');
    const planning = await h.runner('POST', '/api/planning/estimates', { jobId: old, fence, items: [{ taskKey: 'TASK-0001', estHours: 2, loHours: 1, hiHours: 3, confidence: '중', basis: '늦은 보고', agreedBy: ['Claude', 'Codex'] }] });
    expect(planning.status).toBe(409);
    expect(planning.body.error.code).toBe('LEASE_LOST');
  }
});

test('실제 관리 CLI는 기본 미리보기·순번·계약 버전·임대를 표로 출력하고 비밀은 숨긴다', async () => {
  const old = await estimate();
  await h.owner.query("update runner_jobs set payload=payload||jsonb_build_object('secret',$2::text),schema_version=9 where id=$1", [old, secret]);
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += '_jobs_reissue';
  url.searchParams.set('options', '-c role=awbs_app');
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--conditions=awbs-source', new URL('../src/platform/auth-cli.ts', import.meta.url).pathname, 'jobs', ...args], { env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8' });
  const open = cli('open');
  expect(open.status, open.stderr).toBe(0);
  expect(open.stdout).toContain('record\tid\tkind\tstate\tcontract\tcreated\towner\tuntil\tfence\tholds');
  expect(open.stdout).toContain(`${old}\testimate\tqueued\t9\t`);
  expect(open.stdout + open.stderr).not.toContain(secret);
  expect(jobsTable((await openJobs(h.pool)).jobs)).not.toContain(secret);
  const cutoff = await through();
  expect(cli('reissue', '--through', cutoff).stdout).toContain('미리보기 (변경 없음): 1개');
  expect((await row(old)).state).toBe('queued');
  expect(cli('reissue', '--through', cutoff, '--confirm').status).toBe(0);
  expect(cli('reissue', '--through', cutoff, '--confirm').stdout).toContain('재발급 완료: 0개');
  expect(cli('reissue', '--confirm').status).toBe(1);
  expect(cli('reissue', '--through', cutoff, '--confirm', '--dry-run').status).toBe(1);
});
