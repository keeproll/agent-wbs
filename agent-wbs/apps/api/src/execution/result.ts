import type { PoolClient } from '@awbs/db';
import { applyChecklistVerification, finishAttempt, recordVerification, type VerificationResult } from '@awbs/shared';
import { PlatformError } from '../platform/errors.ts';
import { required, RunnerRepository } from '../runner/repository.ts';
import { checkedJob, handover, retryFailedAttempt } from '../runner/service.ts';
import { enqueueIntegration, gateInput } from './gate.ts';
import { deferChange } from '../changes/events.ts';

export interface ResultReport {
  fence: number; summary: string; changedFiles: string[]; evidence: string[]; failure?: string; tokens?: number;
  verification?: { headSha: string; specRevision: number; result: VerificationResult; cmd: string; expected: string; actual: string;
    defects: { text: string; blocking: boolean }[]; checklist: { itemKey: string; done: boolean; evidence?: string; note?: string }[] };
}

export async function reportResult(client: PoolClient, attemptId: string, principal: string, body: ResultReport) {
  if (body.tokens !== undefined && !Number.isSafeInteger(body.tokens) || body.verification && body.verification.specRevision > 2_147_483_647) throw new PlatformError('VALIDATION_FAILED');
  const repo = new RunnerRepository(client);
  await repo.lock();
  const a = await repo.attempt(attemptId);
  if (!a) throw new PlatformError('ATTEMPT_NOT_FOUND');
  const job = await checkedJob(repo,a.job,body.fence,principal);
  if (a.status !== 'running') throw new PlatformError('ATTEMPT_CLOSED');
  const task = await repo.taskById(a.task);
  if (!task) throw new PlatformError('TASK_NOT_FOUND');
  const h = await repo.hold(job.id);
  if (!h || h.slot_state !== 'none' || h.lock_state !== 'held' || !h.release_proof) throw new PlatformError('INVALID_TRANSITION', { reasons:['프로세스 종료 증거와 슬롯 반환이 필요합니다.'] });
  const qa = a.kind === 'qa' || a.kind === 'reverify';
  if (qa !== Boolean(body.verification) || qa && (body.changedFiles.length || body.failure)) throw new PlatformError('VALIDATION_FAILED');
  const executionFailed = !qa && Boolean(body.failure);
  const evidenceIds = [...new Set([...body.evidence,...(body.verification?.checklist.flatMap(c => c.evidence ? [c.evidence] : []) ?? [])])];
  const evidence = await client.query('select id from evidence where id::text=any($1::text[]) and task=$2 and attempt=$3', [evidenceIds,task.id,a.id]);
  if (evidence.rowCount !== evidenceIds.length) throw new PlatformError('VALIDATION_FAILED', { reasons:['이 Task·시도에서 올린 Evidence만 참조할 수 있습니다.'] });
  const gate = await gateInput(client,task.id);
  let status: string, disposition = 'current', taskCheckPlaceholder = false;
  if (body.verification) {
    const v = body.verification;
    const items = (await client.query<{ id: string; item_key: string; required: boolean; done: boolean; note: string | null; evidence: unknown }>('select id,item_key,required,done,note,evidence from checklist_items where task=$1', [task.id])).rows;
    if (new Set(v.checklist.map(c => c.itemKey)).size !== v.checklist.length || v.checklist.some(c => !items.some(i => i.item_key === c.itemKey))) throw new PlatformError('VALIDATION_FAILED');
    const atInput = (await client.query<{ v: number }>('select v from input_versions where id=$1', [a.input_version])).rows[0]?.v ?? 0;
    const transition = recordVerification(task.status,a,gate.basis,{ result:v.result,headSha:v.headSha,specRevision:v.specRevision,inputVersion:atInput,
      invalidated:v.headSha !== a.head_sha || v.specRevision !== a.spec_revision });
    status = transition.taskStatus; disposition = transition.disposition;
    const verification = required((await client.query<{ id: string }>('insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',
      [task.project_id,a.id,v.result,v.headSha,v.specRevision,v.cmd,v.expected,v.actual])).rows[0]);
    if (disposition === 'stale') {
      await client.query('insert into verification_invalidations(project_id,verification,reason) values($1,$2,$3)', [task.project_id,verification.id,'보고한 코드·명세·입력 버전이 현재 근거와 다름']);
    } else {
      // 항목별 FAIL은 전체 PASS에서도 체크를 풀어 Gate를 막는다. BLOCKED는 기존 체크를 보존한다.
      for (const reported of v.checklist) {
        const item = required(items.find(i => i.item_key === reported.itemKey));
        const updated = required(applyChecklistVerification([{ id:item.id,required:item.required,done:item.done,note:item.note ?? '',evidence:typeof item.evidence === 'string' ? item.evidence : '' }],
          [item.id],v.result === 'BLOCKED' ? 'BLOCKED' : v.result === 'PASS' && reported.done ? 'PASS' : 'FAIL',verification.id,reported.evidence ? [reported.evidence] : [])[0]);
        if (v.result !== 'BLOCKED') await client.query('update checklist_items set done=$2,evidence=$3::jsonb,note=$4 where id=$1',
          [item.id,updated.done,JSON.stringify(updated.evidence || null),reported.note ?? updated.note]);
      }
      if (v.result === 'PASS') await client.query(`insert into defect_events(project_id,defect,kind,resolved_by_verification,detail)
        select $1,d.id,'resolved',$2,'{}' from defects d join verifications old on old.id=d.verification join task_attempts old_a on old_a.id=old.attempt
        where old_a.task=$3 and not exists(select 1 from defect_events e where e.defect=d.id and e.kind='resolved')`, [task.project_id,verification.id,task.id]);
    }
    // 원본 registerQa처럼 PASS·BLOCKED에서 보고한 새 결함은 반영하지 않는다.
    for (const defect of v.result === 'FAIL' ? v.defects : []) {
      const n = required((await client.query<{ value: string }>("insert into counters(project_id,kind,value) values($1,'defect',1) on conflict(project_id,kind) do update set value=counters.value+1 returning value", [task.project_id])).rows[0]).value;
      await client.query('insert into defects(project_id,def_key,verification,blocking,content) values($1,$2,$3,$4,$5)', [task.project_id,`DEF-${String(n).padStart(4,'0')}`,verification.id,defect.blocking,defect.text]);
    }
  } else if (executionFailed) {
    status = finishAttempt(task.status,a,'failed',false).taskStatus;
  } else {
    const check = (await client.query<{ head_sha: string; status: string; spec_revision: number; input_version: string }>(`select c.head_sha,c.status,c.spec_revision,c.input_version from ci_runs c
      where c.attempt=$1 and c.stage=1 order by c.created_at desc,c.id desc limit 1`, [a.id])).rows[0];
    const input = await repo.input(task.project_id,task.src_input_version);
    // shortcut: M7-06 전에는 ① 기록이 없을 때만 자리표시로 진행한다. 실제 ① 연결 시 이 대체 경로와 RunnerRepository.taskCheck의 대체 조회를 제거한다.
    taskCheckPlaceholder = !check && a.head_sha === gate.basis.headSha && a.spec_revision === gate.basis.specRevision && a.input_version === input?.id;
    const valid = taskCheckPlaceholder || check?.status === 'pass' && check.spec_revision === gate.basis.specRevision && check.input_version === input?.id;
    status = finishAttempt(task.status,a,'completed',valid).taskStatus;
    const head = check?.head_sha ?? a.head_sha;
    await client.query('update task_attempts set head_sha=$2 where id=$1', [a.id,head]);
    await client.query('update tasks set execution_head_sha=$2 where id=$1',[task.id,head]);
    const outputs = (await client.query<{ id: string; name: string }>('select id,name from task_outputs where task=$1 and not delivered',[task.id])).rows;
    for (const output of outputs) if (body.changedFiles.some(path => path === output.name || output.name.includes('*') && path.startsWith(output.name.split('*')[0] ?? ''))) {
      await client.query('update task_outputs set delivered=true,delivered_attempt=$2 where id=$1',[output.id,a.id]);
      await repo.historyEvent(task,'산출물 제출',{ attemptId:a.id,name:output.name });
    }
  }
  for (const path of new Set(body.changedFiles)) await client.query('insert into attempt_files(project_id,attempt,path) values($1,$2,$3)', [task.project_id,a.id,path]);
  await client.query('update task_attempts set status=$5,ended_at=greatest(started_at,clock_timestamp()),summary=$2,failure=$3,tokens=$4 where id=$1', [a.id,body.summary,body.failure === undefined ? null : { reason:body.failure },body.tokens ?? null,executionFailed ? 'failed' : 'completed']);
  const verifState = !qa ? 'none' : disposition === 'stale' ? 'none' : required(body.verification).result.toLowerCase();
  await client.query('update tasks set status=$2,verif_state=$3 where id=$1', [task.id,status,verifState]);
  await repo.historyEvent(task,'시도 결과',{ attemptId:a.id,result:body.verification?.result ?? 'completed',disposition,before:task.status,after:status });
  await repo.event(job,'finished',null,{ attemptId:a.id,disposition,...(taskCheckPlaceholder && { taskCheckPlaceholder:true }) });
  if (executionFailed) await retryFailedAttempt(client,a.id);
  else if (!qa) await handover(client,job.id,a.kind === 'dev' ? 'qa' : 'reverify',a.id);
  else if (disposition === 'current' && body.verification?.result === 'FAIL') {
    await repo.alert(task.project_id,`qa-fail:${a.id}`,'QA 검증에 실패했습니다.',{ taskKey:task.task_key,attemptId:a.id });
    if (!await handover(client,job.id,'rework',a.id)) await repo.state(job.id,'done');
  } else {
    await repo.state(job.id,'done');
    await repo.release(h,required(h.release_proof),true);
    await enqueueIntegration(client,task.id,job.epoch);
  }
  for (const topic of ['task','attempt',...(qa ? ['verification'] as const : []),'schedule'] as const) deferChange(client,task.project_id,topic,{ taskKey:task.task_key,attemptId:a.id });
}
