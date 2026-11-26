import type { PoolClient } from '@awbs/db';
import { completionGate, lifecycleTransition, type GateInput, type HeadSync, type VerificationResult, type CompletionInput } from '@awbs/shared';
import { PlatformError } from '../platform/errors.ts';
import { RunnerRepository, required } from '../runner/repository.ts';
import { assertExternal } from '../runner/service.ts';
import { record, SYSTEM } from '../tasks/history.ts';
import { deferChange } from '../changes/events.ts';

export async function gateInputs(client: PoolClient, taskIds: string[], headSync: HeadSync | null = null): Promise<Map<string, GateInput>> {
  const rows = (await client.query<{ id: string; planning_approved_at: Date | null; revision: number; input_v: number; head_sha: string; open_qa: boolean;
    verification: { result: VerificationResult; headSha: string; specRevision: number; inputVersion: number; invalidated: boolean } | null;
    check_result: string | null; check_revision: number; check_input: number; defects: number;
    checklist: { required: boolean; done: boolean }[]; outputs: { name: string; required: boolean; delivered: boolean }[] }>(`
    select t.id,t.planning_approved_at,s.revision,iv.v input_v,coalesce(t.execution_head_sha,a.head_sha) head_sha,
      exists(select 1 from task_attempts q where q.task=t.id and q.status='running' and q.kind in ('qa','reverify')) open_qa
      ,v.verification,c.status check_result,c.spec_revision check_revision,c.input_v check_input,
      (select count(*)::int from defects d join verifications dv on dv.id=d.verification join task_attempts da on da.id=dv.attempt
        where da.task=t.id and d.blocking and not exists(select 1 from defect_events e where e.defect=d.id and e.kind='resolved')
        and not exists(select 1 from verification_invalidations vi where vi.verification=dv.id)) defects,
      coalesce((select jsonb_agg(jsonb_build_object('required',required,'done',done)) from checklist_items where task=t.id),'[]') checklist,
      coalesce((select jsonb_agg(jsonb_build_object('name',name,'required',required,'delivered',delivered)) from task_outputs where task=t.id),'[]') outputs
    from tasks t left join task_specs s on s.task=t.id
    left join lateral(select * from input_versions where project_id=t.project_id and (t.src_input_version is null or id=t.src_input_version) order by v desc limit 1) iv on true
    left join lateral(select head_sha from task_attempts where task=t.id order by attempt_no desc limit 1) a on true
    left join lateral(select case when v.id is not null then jsonb_build_object('result',v.result,'headSha',v.head_sha,'specRevision',v.spec_revision,'inputVersion',coalesce(iv.v,0),
      'invalidated',exists(select 1 from verification_invalidations i where i.verification=v.id)) end verification
      from task_attempts qa left join verifications v on v.attempt=qa.id left join input_versions iv on iv.id=qa.input_version
      where qa.task=t.id and qa.kind in ('qa','reverify') order by qa.attempt_no desc limit 1) v on true
    left join lateral(select c.status,c.spec_revision,iv.v input_v from ci_runs c left join input_versions iv on iv.id=c.input_version
      where c.project_id=t.project_id and c.task=t.id and c.stage=1 and c.head_sha=coalesce($2,t.execution_head_sha,a.head_sha) order by c.created_at desc,c.id desc limit 1) c on true
    where t.id=any($1::uuid[])`, [taskIds,headSync?.headSha ?? null])).rows;
  return new Map(rows.map(task => {
    const basis = { headSha:headSync?.headSha ?? task.head_sha ?? '',specRevision:task.revision ?? 0,inputVersion:task.input_v ?? 0 };
    return [task.id,{ checklist:task.checklist,outputs:task.outputs,basis,verification:task.verification,
  ...(task.open_qa ? { verificationState:'running' as const } : {}),
    taskCheck:task.check_result ? { ...basis,specRevision:task.check_revision,inputVersion:task.check_input ?? 0,result:task.check_result === 'pass' ? 'PASS' as const : 'FAIL' as const } : null,
    unresolvedBlockingDefects:task.defects,planningApprovedAt:task.planning_approved_at?.toISOString() ?? null,headSync }];
  }));
}

export async function gateInput(client: PoolClient, taskId: string, headSync: HeadSync | null = null): Promise<GateInput> {
  const input = (await gateInputs(client,[taskId],headSync)).get(taskId);
  if (!input) throw new PlatformError('TASK_NOT_FOUND');
  return input;
}

export async function taskGate(client: PoolClient, taskId: string, taskKey: string) {
  const conditions = completionGate(await gateInput(client,taskId));
  return { taskKey,passed:conditions.every(c => c.result === 'PASS'),conditions };
}

/** M7의 병합 대조가 호출한다. pipeline SHA와 head 보존 증거는 서버가 직접 확인한 값이어야 한다. */
export async function completeMergedTask(client: PoolClient, taskKey: string, basePipelineSha: string | null, headSync: HeadSync | null = null) {
  const repo = new RunnerRepository(client);
  await repo.lock();
  const task = await repo.task(taskKey);
  if (!task) throw new PlatformError('TASK_NOT_FOUND');
  if (task.status !== 'gate') throw new PlatformError('INVALID_TRANSITION');
  const queue = (await client.query<{ qa_head_sha: string; synced_head_sha: string; base_sha: string; actual_merge_sha: string; actual_tree_sha: string;
    status: string; pipeline_sha: string; ci_head: string; ci_base: string; tree_sha: string; job: string; result: string }>(`
    select q.*,c.pipeline_sha,c.head_sha ci_head,c.base_sha ci_base,c.tree_sha,c.status result,c.job from merge_queue q
    left join ci_runs c on c.id=q.ci_run and c.stage=2 where q.task=$1 order by q.created_at desc,q.id desc limit 1`, [task.id])).rows[0];
  if (!basePipelineSha) throw new PlatformError('GATE_NOT_PASSED', { reasons:['병합 기준 main의 파이프라인 정의를 서버가 확인해야 합니다.'] });
  const evidence: CompletionInput = { ...await gateInput(client,task.id,headSync),basePipelineSha,
    integration:queue?.pipeline_sha ? { result:queue.result === 'pass' ? 'PASS' : 'FAIL',qaHeadSha:queue.qa_head_sha,
      headSha:queue.ci_head,baseSha:queue.ci_base,pipelineSha:queue.pipeline_sha,treeSha:queue.tree_sha } : null,
    merge:queue?.status === 'merged' ? { mergeSha:queue.actual_merge_sha,headSha:queue.synced_head_sha,baseSha:queue.base_sha,treeSha:queue.actual_tree_sha } : null };
  lifecycleTransition(task.status,{ type:'complete',evidence });
  const job = queue?.job ? await repo.job(queue.job) : undefined;
  if (!job || job.kind !== 'integrate' || job.payload.taskKey !== taskKey) throw new PlatformError('GATE_NOT_PASSED');
  await assertExternal(repo,job);
  await client.query("update tasks set status='done',act_end=greatest(coalesce(act_start,clock_timestamp()),clock_timestamp()) where id=$1", [task.id]);
  await repo.historyEvent(task,'완료',{ mergeSha:queue?.actual_merge_sha });
  deferChange(client,task.project_id,'task',{ taskKey });
}

/** 명세 편집뿐 아니라 입력 버전·브랜치 head 갱신도 이 함수를 같은 트랜잭션에서 호출한다. */
export async function invalidateTaskGate(client: PoolClient, taskKey: string, headSha?: string) {
  const repo = new RunnerRepository(client);
  const task = await repo.task(taskKey);
  if (!task || task.status === 'done' || task.status === 'cancelled') return false;
  if (headSha !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(headSha)) throw new PlatformError('VALIDATION_FAILED');
    await client.query('update tasks set execution_head_sha=$2 where id=$1',[task.id,headSha]);
  }
  if (task.status !== 'gate') return false;
  const input = await gateInput(client,task.id);
  const next = input.verification ? lifecycleTransition('gate',{ type:'invalidate',basis:input.basis,verification:input.verification }) : 'verifying';
  if (next === 'gate') return false;
  const verification = (await client.query<{ id: string }>('select v.id from verifications v join task_attempts a on a.id=v.attempt where a.task=$1 order by a.attempt_no desc limit 1', [task.id])).rows[0];
  const reason = `명세 revision ${String(input.verification?.specRevision ?? 0)} → ${String(input.basis.specRevision)}, 입력 버전 ${String(input.verification?.inputVersion ?? 0)} → ${String(input.basis.inputVersion)}: 검증 뒤 코드·명세·입력 버전 변경`;
  if (verification) await client.query('insert into verification_invalidations(project_id,verification,reason) select $1,$2,$3 where not exists(select 1 from verification_invalidations where verification=$2)', [task.project_id,verification.id,reason]);
  await client.query("update tasks set status='verifying',verif_state='none' where id=$1", [task.id]);
  await client.query("update runner_jobs set state=case when state='queued' then 'cancelled'::job_state else 'reconcile'::job_state end where kind='integrate' and payload->>'taskKey'=$1 and state in ('queued','leased','started')", [taskKey]);
  await record(client,{ projectId:task.project_id,taskId:task.id,actor:SYSTEM,kind:'재검증',text:reason,before:'gate',after:'verifying',ref:{ field:'lifecycleStatus',verification:verification?.id ?? null } });
  return true;
}

export async function enqueueIntegration(client: PoolClient, taskId: string, epoch: number) {
  const repo = new RunnerRepository(client);
  const task = await repo.taskById(taskId);
  if (!task || task.status !== 'gate' || !(await taskGate(client,task.id,task.task_key)).passed) return;
  const verification = required((await client.query<{ id: string; head_sha: string }>('select v.id,v.head_sha from verifications v join task_attempts a on a.id=v.attempt where a.task=$1 order by a.attempt_no desc limit 1', [task.id])).rows[0]);
  const a = (await repo.history(task.id)).at(-1);
  const pr = a?.pr ?? (await client.query<{ pr: number }>('select pr from ci_runs where task=$1 and head_sha=$2 and pr is not null order by created_at desc,id desc limit 1',[task.id,verification.head_sha])).rows[0]?.pr;
  if (!pr) return;
  await repo.enqueue(task.project_id,epoch,'integrate',{ taskKey:task.task_key,qaHeadSha:verification.head_sha,branch:a?.branch,pr,commit:verification.head_sha },`integrate:${verification.id}`,(await repo.authority())?.generation ?? null);
}
