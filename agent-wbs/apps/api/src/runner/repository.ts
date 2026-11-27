import type { PoolClient, schema, ExecPolicyRow } from '@awbs/db';
import { attemptKey, placeModel, modelRanks, type ModelSettings, type Agent, type AttemptKind } from '@awbs/shared';
import assert from 'node:assert/strict';
import { syncPlanningJob } from '../project/jobs.ts';

export function required<T>(value: T | null | undefined): T { assert(value !== null && value !== undefined); return value; }

type PgRow<T> = { [K in keyof T]: K extends `${string}_at` | 'lease_until' | 'effective_from' ? Date | Extract<T[K], null> : T[K] };
export type Job = PgRow<typeof schema.runnerJobs.$inferSelect> & { payload: Record<string, unknown> };
export type Hold = PgRow<typeof schema.executionHolds.$inferSelect>;
export type Task = PgRow<typeof schema.tasks.$inferSelect>;
export type Attempt = PgRow<typeof schema.taskAttempts.$inferSelect> & { verification_result: 'PASS' | 'FAIL' | 'BLOCKED' | null; automatic_cause: string | null; verification_disposition: 'current' | 'stale' };

/** 같은 트랜잭션의 잠금 순서: epoch → Runner 조정 잠금 → Task/job/보유. */
export class RunnerRepository {
  readonly client: PoolClient;
  constructor(client: PoolClient) { this.client = client; }
  async lock() { await this.client.query("select pg_advisory_xact_lock(hashtextextended('runner-dispatch',0))"); }
  async now() { return required((await this.client.query<{ at: Date }>('select clock_timestamp() as at')).rows[0]).at; }
  async host() { return (await this.client.query<typeof schema.runnerHosts.$inferSelect>('select * from runner_hosts order by seen_at desc,created_at desc limit 1')).rows[0]; }
  async hostBoot(host: string) { return (await this.client.query<{ boot_id: string }>('select boot_id from runner_hosts where host_id=$1 order by seen_at desc,created_at desc limit 1', [host])).rows[0]?.boot_id; }
  async authority() { return (await this.client.query<typeof schema.externalWriteAuthority.$inferSelect>('select * from external_write_authority where singleton for update')).rows[0]; }
  async cleanup() { return Boolean((await this.client.query("select 1 from system_state where cleanup_status='pending' union all select 1 from runner_commands where status<>'done' limit 1")).rowCount); }
  async task(key: string) { return (await this.client.query<Task>('select * from tasks where task_key=$1 and deleted_at is null for update', [key])).rows[0]; }
  async taskById(id: string) { return (await this.client.query<Task>('select * from tasks where id=$1 and deleted_at is null for update', [id])).rows[0]; }
  async versionMatches(id: string, version: string, table: 'tasks' | 'task_attempts' = 'tasks') {
    return Boolean((await this.client.query(`select 1 from ${table} where id=$1 and updated_at=$2::timestamptz`, [id, version])).rowCount);
  }
  async job(id: string) { return (await this.client.query<Job>('select * from runner_jobs where id::text=$1 for update', [id])).rows[0]; }
  async candidates(kinds: readonly string[], epoch: number) {
    return (await this.client.query<Job>(`select * from runner_jobs where epoch=$1 and kind=any($2::job_kind[]) and
      (state='queued' or kind='repo_check' and state in ('leased','started') and lease_until<=clock_timestamp())
      order by created_at,id for update skip locked`, [epoch, kinds])).rows;
  }
  async holds() { return (await this.client.query<Hold>('select * from execution_holds where closed_at is null for update')).rows; }
  async ownedHolds(principal: string, epoch: number) {
    return (await this.client.query<Hold & { lease_owner: string; lease_until: Date | null }>(`select h.*,j.lease_owner,j.lease_until
      from execution_holds h join runner_jobs j on j.id=h.job
      where h.closed_at is null and h.epoch=$2 and j.epoch=$2 and j.lease_owner=$1 order by h.created_at,h.id`, [principal, epoch])).rows;
  }
  async hold(job: string) { return (await this.client.query<Hold>('select * from execution_holds where job=$1 for update', [job])).rows[0]; }
  async history(task: string) {
    return (await this.client.query<Attempt>(`select a.*,v.result as verification_result,j.payload->>'automaticCause' as automatic_cause,
      case when exists(select 1 from verification_invalidations i where i.verification=v.id) then 'stale' else 'current' end verification_disposition
      from task_attempts a join runner_jobs j on j.id=a.job left join verifications v on v.attempt=a.id where a.task=$1 order by a.attempt_no`, [task])).rows;
  }
  async attempt(id: string) { return (await this.client.query<Attempt>('select * from task_attempts where id::text=$1 for update', [id])).rows[0]; }
  async grades(task: string) { return (await this.client.query<typeof schema.taskGrades.$inferSelect>('select * from task_grades where task=$1', [task])).rows; }
  async models(agent: string) { return (await this.client.query<typeof schema.agentModels.$inferSelect>('select * from agent_models where agent=$1 order by rank,model_id', [agent])).rows; }
  async policy() { return required((await this.client.query<ExecPolicyRow>('select * from exec_policy where singleton')).rows[0]); }
  async settings() { return (await this.client.query<typeof schema.concurrencySettings.$inferSelect>('select * from concurrency_settings where singleton')).rows[0]; }
  async appSettings() { return required((await this.client.query<typeof schema.appSettings.$inferSelect>('select * from app_settings where singleton')).rows[0]); }
  async usage(agent: string) { return (await this.client.query<{ remain_pct: string }>('select remain_pct from agent_usage where agent=$1 order by created_at desc limit 1', [agent])).rows[0]; }
  async readiness() { return (await this.client.query<typeof schema.runnerReadiness.$inferSelect>('select * from runner_readiness')).rows; }
  async concurrency() { return (await this.client.query<PgRow<typeof schema.runnerConcurrencyLog.$inferSelect>>('select * from runner_concurrency_log where host_id=(select host_id from runner_hosts order by seen_at desc,created_at desc limit 1) order by created_at desc limit 1')).rows[0]; }
  async observations() { return (await this.client.query<typeof schema.cliObservationGrades.$inferSelect>('select * from cli_observation_grades')).rows; }
  async latestObservation(attempt: string) { return (await this.client.query<typeof schema.attemptObservations.$inferSelect>('select * from attempt_observations where attempt=$1 order by at desc,created_at desc limit 1', [attempt])).rows[0]; }
  async dependencies(task: string) {
    return (await this.client.query<{ dep_type: 'FS' | 'SS'; status: Task['status'] }>('select d.dep_type,t.status from task_dependencies d join tasks t on t.id=d.pred where d.succ=$1', [task])).rows;
  }
  async taskCheck(task: Task, head?: string) {
    const check = (await this.client.query<{ passed: boolean }>(`select c.status='pass' and c.spec_revision=s.revision
      and c.input_version is not distinct from coalesce(t.src_input_version,(select id from input_versions where project_id=t.project_id order by v desc limit 1)) passed
      from ci_runs c join task_specs s on s.task=c.task join tasks t on t.id=c.task
      where c.task=$1 and c.stage=1 and c.head_sha=$2 order by c.created_at desc,c.id desc limit 1`, [task.id, head ?? null])).rows[0];
    if (check) return Boolean(check.passed);
    // shortcut: M7-06에서 제거할 흐름 전용 자리표시다. 실제 CI가 있으면 그 결과가 우선하며 Gate의 ① 근거로 쓰지 않는다.
    return Boolean((await this.client.query(`select 1 from task_attempts a join tasks t on t.id=a.task join task_specs s on s.task=t.id
      where a.task=$1 and a.head_sha=$2 and a.kind in ('dev','rework') and a.status='completed' and a.spec_revision=s.revision
      and a.input_version is not distinct from coalesce(t.src_input_version,(select id from input_versions where project_id=t.project_id order by v desc limit 1))
      and exists(select 1 from runner_job_events e where e.job=a.job and e.kind='finished' and e.detail->>'taskCheckPlaceholder'='true') limit 1`, [task.id,head ?? null])).rowCount);
  }
  async spec(task: string) { return (await this.client.query<{ revision: number; overview: object; spec: object; ac: unknown[] }>('select revision,overview,spec,ac from task_specs where task=$1', [task])).rows[0]; }
  async input(project: string, id: string | null = null) { return (await this.client.query<{ id: string; v: number; commit_sha: string }>('select id,v,commit_sha from input_versions where project_id=$1 and ($2::uuid is null or id=$2) order by v desc limit 1', [project,id])).rows[0]; }
  async subagents(task: string, role: string) {
    return (await this.client.query<typeof schema.subagentDefs.$inferSelect>(`select d.* from task_subagents s join subagent_defs d on d.id=s.subagent_id where s.task=$1 and s.role=$2`, [task, role])).rows;
  }
  async event(job: Job, kind: string, code: string | null = null, detail: object = {}) {
    await this.client.query('insert into runner_job_events(project_id,job,kind,code,detail) values($1,$2,$3,$4,$5)', [job.project_id, job.id, kind, code, detail]);
  }
  async historyEvent(task: Task, event: string, detail: object) {
    await this.client.query("insert into task_history(project_id,task,kind,actor,text,ref) values($1,$2,$3,'runner',$3,$4)", [task.project_id, task.id, event, detail]);
  }
  async enqueue(project: string | null, epoch: number, kind: string, payload: object, dedup: string, generation: number | null = null) {
    const id = (await this.client.query<{ id: string }>(`insert into runner_jobs(project_id,epoch,kind,payload,dedup_key,state,generation) values($1,$2,$3,$4,$5,'queued',$6)
      on conflict(dedup_key) do nothing returning id`, [project, epoch, kind, payload, dedup, generation])).rows[0]?.id;
    if (id && ['bootstrap', 'input_diff'].includes(kind)) await syncPlanningJob(this.client, id, 'queued');
    return id;
  }
  async openJob(taskKey: string) { return (await this.client.query<Job>("select * from runner_jobs where kind='attempt' and payload->>'taskKey'=$1 and state in ('queued','leased','started','reconcile') limit 1", [taskKey])).rows[0]; }
  async lease(job: Job, owner: string, generation: number | null) {
    return required((await this.client.query<Job>(`update runner_jobs set state='leased',lease_owner=$2,lease_until=clock_timestamp()+interval '60 seconds',fence=fence+1,attempts=attempts+1,generation=$3::int,
      payload=case when kind='attempt' then payload||jsonb_build_object('branch','agent/'||(payload->>'taskKey')||'-h'||$3::text) else payload end where id=$1 returning *`, [job.id, owner, generation])).rows[0]);
  }
  async renew(job: string) { return required((await this.client.query<{ lease_until: Date }>("update runner_jobs set lease_until=clock_timestamp()+interval '60 seconds' where id=$1 returning lease_until", [job])).rows[0]).lease_until; }
  async state(job: string, state: string, error?: { code: string; message: string }) {
    await this.client.query('update runner_jobs set state=$2 where id=$1', [job, state]);
    await syncPlanningJob(this.client, job, state, error);
  }
  async reserve(job: Job, host: string, boot: string, agent: string, slots: number, heavy: boolean, task?: Task) {
    const existing = await this.hold(job.id);
    if (existing) {
      await this.client.query("update execution_holds set host_id=$2,boot_id=$3,fence=$4,slot_state='reserved',slots=$5,heavy=$6 where job=$1", [job.id, host, boot, job.fence, slots, heavy]);
    } else await this.client.query(`insert into execution_holds(project_id,job,epoch,host_id,boot_id,fence,task,conflict_group,agent,slots,heavy,slot_state,lock_state)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved',$12)`, [job.project_id, job.id, job.epoch, host, boot, job.fence, task?.id ?? null, task?.conflict_group ?? null, agent, slots, heavy, task ? 'held' : 'none']);
  }
  async process(job: string, pgid: number, cgroup: string | null) { await this.client.query("update execution_holds set slot_state='active',pgid=$2,cgroup=$3 where job=$1", [job, pgid, cgroup]); }
  async release(hold: Hold, proof: string, unlock: boolean) {
    const lock = unlock && hold.lock_state === 'held' ? 'released' : hold.lock_state;
    await this.client.query(`update execution_holds set slot_state='none',lock_state=$2::lock_state,release_proof=case when slot_state<>'none' then $3 else release_proof end,
      closed_at=case when $2::lock_state='held' then null else clock_timestamp() end where job=$1`, [hold.job, lock, proof]);
  }
  async createAttempt(job: Job, task: Task, kind: AttemptKind, host: string, head: string, model: string, effort: string, adjust: object | null, resumed: string | null) {
    const spec = await this.spec(task.id);
    const input = await this.input(task.project_id,task.src_input_version);
    const n = (await this.history(task.id)).length + 1;
    const row = required((await this.client.query<{ id: string }>(`insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,input_version,kind,agent,status,started_at,model_id,effort,grade_adjust,resumed_from,branch,generation)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'running',clock_timestamp(),$12,$13,$14,$15,$16,$17) returning id`,
    [task.project_id, task.id, attemptKey(task.task_key, n), n, job.id, job.payload.baseCommit, head, required(spec).revision, input?.id ?? task.src_input_version, kind,
      job.payload.agent, model, effort, adjust, resumed, job.payload.branch, job.generation])).rows[0]);
    await this.client.query('update execution_holds set attempt=$2 where job=$1', [job.id, row.id]);
    await this.client.query("update tasks set status=$2,verif_state=$3,execution_head_sha=$4,act_start=coalesce(act_start,clock_timestamp()) where id=$1", [task.id, kind === 'qa' ? 'qa' : kind === 'reverify' ? 'verifying' : 'running',kind === 'qa' || kind === 'reverify' ? 'running' : 'none',head]);
    await this.state(job.id, 'started');
    await this.event(job, 'started', null, { attemptId: row.id, host });
    return row.id;
  }
  async closeAttempt(a: Attempt, status: 'failed' | 'interrupted', at: Date, detail: object) {
    await this.client.query('update task_attempts set status=$2,ended_at=greatest(started_at,$3),failure=$4 where id=$1', [a.id, status, at, detail]);
    await this.client.query("update tasks set status=$2,verif_state='none' where id=$1", [a.task, status === 'failed' ? 'failed' : 'paused']);
  }
  async transfer(from: Hold, next: string) {
    await this.client.query("update execution_holds set lock_state='handed_over',handed_to_job=$2,closed_at=clock_timestamp() where job=$1", [from.job, next]);
    await this.client.query(`insert into execution_holds(project_id,job,epoch,task,conflict_group,agent,slots,heavy,slot_state,lock_state,lock_from_job)
      select project_id,$2,epoch,task,conflict_group,$3,0,false,'none','held',job from execution_holds where job=$1`, [from.job, next,
      required((await this.job(next))).payload.agent]);
  }
  async unconfirm(job: string, orphan = false) {
    await this.client.query(`update execution_holds set slot_state=case when slot_state='none' then 'none' else 'unconfirmed' end::slot_state,
      lock_state=case when $2 and lock_state='held' then 'orphaned' else lock_state end,
      closed_at=case when $2 and slot_state='none' then clock_timestamp() else closed_at end where job=$1 and closed_at is null`, [job, orphan]);
  }
  async expired(at: Date) { return (await this.client.query<Job>(`select * from runner_jobs j where state in ('leased','started') and kind<>'repo_check' and
    (lease_until<=$1 or exists(select 1 from runner_sessions s join app_settings cfg on cfg.singleton
      where s.runner_id=substring(j.lease_owner from 8) and s.ended_at is null and s.last_heartbeat_at<= $1 - make_interval(secs=>cfg.heartbeat_seconds*cfg.heartbeat_misses))) for update`, [at])).rows; }
  /** 끊긴 세션을 닫고 닫은 수를 돌려준다. */
  async closeSessions(at: Date) { return (await this.client.query(`update runner_sessions s set ended_at=last_heartbeat_at,end_reason='unknown' from app_settings cfg
    where cfg.singleton and ended_at is null and last_heartbeat_at<=$1::timestamptz-make_interval(secs=>cfg.heartbeat_seconds*cfg.heartbeat_misses)`, [at])).rowCount ?? 0; }
  async liveSession() { return Boolean((await this.client.query('select 1 from runner_sessions where ended_at is null limit 1')).rowCount); }
  /** 열린 입력 이력 재작성 경고의 복구 확인 번호(없으면 0). Runner 정책 inputRecheck. */
  async inputRecheck() { return (await this.client.query<{ n: number }>("select coalesce(max((target->>'recheck')::int),0)::int n from alerts where key='input_history_rewritten' and resolved_at is null")).rows[0]?.n ?? 0; }
  async inputCheckRequest() { return (await this.client.query<{ n: number }>('select input_check_request n from projects')).rows[0]?.n ?? 0; }
  async heartbeat(runner: string) { await this.client.query('update runner_sessions set last_heartbeat_at=clock_timestamp() where runner_id=$1 and ended_at is null', [runner]); }
  async sessions() { return (await this.client.query<PgRow<typeof schema.runnerSessions.$inferSelect>>('select * from runner_sessions order by started_at')).rows; }
  async session(runner: string, event: string, at: string, reason?: string) {
    if (event === 'start') await this.client.query('insert into runner_sessions(runner_id,started_at,last_heartbeat_at) values($1,$2,$2)', [runner, at]);
    else await this.client.query('update runner_sessions set ended_at=$2,end_reason=$3 where runner_id=$1 and ended_at is null', [runner, at, reason ?? 'manual']);
  }
  async saveHost(b: { hostId: string; bootId: string; cpu: string; cores: number; memGB: number; swapGB: number; diskFreeGB: number; os: string; perSessionGB?: number; samples?: number }) {
    await this.client.query(`insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,per_session_gb,samples,seen_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())`, [b.hostId,b.bootId,b.cpu,b.cores,b.memGB,b.swapGB,b.diskFreeGB,b.os,b.perSessionGB ?? null,b.samples ?? 0]);
  }
  async setAuthority(host: string, changed: boolean) {
    if (changed) await this.client.query("update external_write_authority set host_id=$1,generation=generation+1,state='blocked',blocked_reason='PC 변경 후 이전 쓰기 중지 확인과 외부 상태 대조가 필요합니다.',reconciled_at=null where singleton", [host]);
    else await this.client.query("insert into external_write_authority(singleton,host_id,generation,state) values(true,$1,1,'granted') on conflict do nothing", [host]);
  }
  async saveReadiness(at: string, items: { key: string; status: string; detail: string; fix?: string }[]) {
    for (const item of items) await this.client.query('insert into runner_readiness(key,status,detail,fix,at) values($1,$2,$3,$4,$5) on conflict(key) do update set status=excluded.status,detail=excluded.detail,fix=excluded.fix,at=excluded.at where runner_readiness.at<=excluded.at', [item.key,item.status,item.detail,item.fix ?? '',at]);
  }
  async saveModels(agent: Agent, models: { id: string; label: string; efforts: string[] | null }[]) {
    const added: string[] = [];
    const settings = (await this.appSettings()).model_settings as unknown as ModelSettings;
    let order = [...settings.rankOrder[agent]];
    for (const model of models) order = placeModel(order,model.id,agent,settings.codexFamilyOrder);
    const ranks = modelRanks(order);
    for (const model of models) {
      const exists = (await this.client.query('select 1 from agent_models where agent=$1 and model_id=$2', [agent, model.id])).rowCount;
      await this.client.query(`insert into agent_models(agent,model_id,rank,report) values($1,$2,$3,$4)
        on conflict(agent,model_id) do update set rank=excluded.rank,report=agent_models.report||excluded.report`, [agent,model.id,ranks.get(model.id),model]);
      if (!exists) added.push(model.id);
    }
    if (JSON.stringify(order) !== JSON.stringify(settings.rankOrder[agent])) {
      await this.client.query('update app_settings set model_settings=$1', [{ ...settings,rankOrder:{ ...settings.rankOrder,[agent]:order } }]);
      await this.client.query('update agent_models set rank=ordering.ordinality from unnest($2::text[]) with ordinality as ordering(id,ordinality) where agent=$1 and model_id=ordering.id', [agent,order]);
    }
    return added;
  }
  async saveUsage(b: { agent: string; remainPct: number; resetAt?: string; tokensUsed?: number }) {
    await this.client.query('insert into agent_usage(agent,remain_pct,reset_at,tokens_used) values($1,$2,$3,$4)', [b.agent,b.remainPct,b.resetAt ?? null,b.tokensUsed ?? null]);
  }
  async saveConcurrency(host: string, b: { limit: number; running: { Claude: number; Codex: number }; subagents: number; heavyJobs: number; resources: object; adjust?: object }) {
    await this.client.query('insert into runner_concurrency_log(host_id,"limit",running,subagents,heavy,resources,adjust) values($1,$2,$3,$4,$5,$6,$7)', [host,b.limit,b.running.Claude+b.running.Codex,JSON.stringify({ observed: b.subagents }),b.heavyJobs,b.resources,b.adjust ?? null]);
  }
  async saveObservation(h: Hold, cli: string, version: string, grade: string, observed: number, reserved: number, state: string, at: string) {
    await this.client.query("insert into attempt_observations(project_id,attempt,cli,version,grade,observed,reserved,state,process_state,at) values($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9)", [h.project_id,h.attempt,cli,version,grade,observed,reserved,state,at]);
    if (h.slot_state !== 'none') await this.client.query("update execution_holds set slots=$2,slot_state=case when $3='unconfirmed' then 'unconfirmed' else slot_state end where job=$1", [h.job,1+reserved,state]);
  }
  async observationConfig(agent: string) { return (await this.client.query<{ conditions: object }>("select report->'cli' as conditions from agent_models where agent=$1 and report->'cli' is not null limit 1", [agent])).rows[0]; }
  async saveObservationConfig(agent: string, detail: object) { await this.client.query("update agent_models set report=jsonb_set(coalesce(report,'{}'),'{cli}',$2::jsonb) where agent=$1", [agent,JSON.stringify(detail)]); }
  async saveInstalled(task: Task, attemptId: string, defs: { id: string; version: number; hash: string }[]) {
    for (const d of defs) await this.client.query("insert into attempt_subagents(project_id,attempt,subagent,designated,installed,version,def_hash) values($1,$2,$3,true,true,$4,$5)", [task.project_id,attemptId,d.id,d.version,d.hash]);
  }
  async allTasks() { return (await this.client.query<Task>('select * from tasks where deleted_at is null')).rows; }
  async hostHistory() { return (await this.client.query<PgRow<typeof schema.runnerHosts.$inferSelect>>('select * from runner_hosts order by seen_at desc,created_at desc limit 20')).rows; }
  async allUsage() { return (await this.client.query<PgRow<typeof schema.agentUsage.$inferSelect>>("select distinct on(agent) * from agent_usage order by agent,created_at desc")).rows; }
  async ciSettings() { return required((await this.client.query<typeof schema.ciSettings.$inferSelect>('select * from ci_settings where singleton')).rows[0]); }
  async githubSettings() { return (await this.client.query<typeof schema.githubSettings.$inferSelect>('select * from github_settings where singleton')).rows[0]; }
  async grantAuthority(generation: number) { return (await this.client.query("update external_write_authority set state='granted',blocked_reason=null,reconciled_at=clock_timestamp() where singleton and generation=$1 returning generation", [generation])).rowCount; }
  async reportStatus(a: Attempt, model: string, effort: string, adjust: object | null) {
    await this.client.query('update task_attempts set model_id=$2,effort=$3,grade_adjust=$4 where id=$1', [a.id,model,effort,adjust]);
  }
  async alert(project: string | null, key: string, message: string, target: object = {}, kind = 'admin') {
    await this.client.query("insert into alerts(project_id,key,severity,target) values($1,$2,'warn',$3) on conflict do nothing", [project,key,{ ...target, message }]);
    await this.client.query('insert into notify_events(project_id,dedup_key,kind,ref) values($1,$2,$3,$4) on conflict do nothing', [project,key,kind,{ ...target, message }]);
  }
}
