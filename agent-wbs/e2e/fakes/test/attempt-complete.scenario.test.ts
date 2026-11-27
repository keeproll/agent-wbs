import { afterEach, beforeEach, expect, test } from 'vitest';
import { completeScenario, type CompleteScenario } from '../attempt-complete.ts';
import { git } from '../../../../agent-runner/test/ci/int-fixture.ts';

let h: CompleteScenario;
beforeEach(async () => { h = await completeScenario(); },30_000);
afterEach(async () => { await h?.close(); },30_000);
const task = async () => (await h.lead('GET','/api/tasks/TASK-0001')).body;
const doneEvents = () => h.rows("select kind from notify_events where kind='done'");

test('Runner CI 실행기가 claim부터 실제 병합 보고까지 수행해 자동 완료한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  h.allowCompletion();
  const merged = await h.integrate(dev.head);
  expect(merged.result.kind).toBe('merged');
  expect((await task()).lifecycleStatus).toBe('done');
  expect(h.state.snapshot.outbox).toEqual([]);
  expect(h.outbox.rejected).toEqual([]);
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
},60_000);

test('병합 직후 Runner 재시작과 만료된 임대에서도 읽기 대조만으로 완료한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  const merged = await h.integrate(dev.head); expect(merged.result.kind).toBe('merged');
  const [before] = await h.rows('select count(*)::int n from ci_runs');
  await h.restartOutbox();
  await h.rows("update runner_jobs set lease_until=clock_timestamp()-interval '1 minute' where kind='integrate'");
  await expect.poll(async () => { await h.recoverCi(); return (await task()).lifecycleStatus; },{ timeout:10_000,interval:50 }).toBe('done');
  expect(await h.rows('select count(*)::int n from ci_runs')).toEqual([before]);
  expect(h.f.github.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
  expect(h.outbox.rejected).toEqual([]);
},60_000);

test('병합 응답 유실과 조회 지연 뒤 재시작해도 실제 병합을 읽기만 해서 대조한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  let reads = 0;
  h.f.github.on('PUT /repos/o/r/pulls/:n/merge',req => {
    const head = (req.body as { sha:string }).sha, base = h.f.ref('main');
    const sha = git(h.f.remote,'commit-tree',git(h.f.remote,'rev-parse',`${head}^{tree}`),'-p',base,'-p',head,'-m','응답 유실 병합');
    git(h.f.remote,'update-ref','refs/heads/main',sha); h.f.merged.set(1,sha);
    return { drop:true };
  });
  h.f.github.on('GET /repos/o/r/pulls/:n',() => {
    if (h.f.merged.has(1) && ++reads <= 2) return { status:503 };
    return { body:{ number:1,state:h.f.merged.has(1) ? 'closed' : 'open',merged:h.f.merged.has(1),merge_commit_sha:h.f.merged.get(1) ?? null,
      head:{ ref:h.f.request.branch,sha:h.f.ref(h.f.request.branch) },base:{ ref:'main',sha:h.f.ref('main') },html_url:'https://example.invalid/pr/1' } };
  });
  expect((await h.integrate(dev.head)).result.kind).toBe('unknown');
  expect((await task()).lifecycleStatus).toBe('gate');
  await h.restartOutbox();
  await expect.poll(async () => { await h.recoverCi(); return (await task()).lifecycleStatus; },{ timeout:10_000,interval:50 }).toBe('done');
  expect(h.f.github.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
},60_000);

test('main이 두 번 바뀌어도 실제 Runner가 H→H′→H″ 사슬과 같은 QA를 보존한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  const heads:string[] = [];
  h.f.beforeWrite(async op => { if (op.kind === 'merge' && heads.length < 2) {
    heads.push(h.f.ref(h.f.request.branch)); await h.f.advance(`변경-${String(heads.length)}`,'다른 작업');
  } });
  h.allowCompletion();
  const merged = await h.integrate(dev.head);
  expect(merged.result).toMatchObject({ kind:'merged',headSync:{ qaHeadSha:dev.head,chain:[
    { qaHeadSha:dev.head,headSha:heads[0] },{ qaHeadSha:heads[0],headSha:heads[1] },{ qaHeadSha:heads[1] },
  ] } });
  expect((await task()).lifecycleStatus).toBe('done');
  expect(await h.rows('select kind from task_attempts order by attempt_no')).toEqual([{ kind:'dev' },{ kind:'qa' }]);
  expect(h.f.github.requests.filter(r => r.method === 'PUT')).toHaveLength(3);
},90_000);

test('Gate 복구: 병합 근거가 맞으면 Gate 대기를 구분하고 체크 회복만으로 자동 완료한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  const merged = await h.integrate(dev.head);
  const edit = async (done: boolean) => h.lead('PATCH','/api/tasks/TASK-0001/checklist/CL-1',{ done,updatedAt:(await task()).updatedAt });
  expect((await edit(false)).status).toBe(200);
  await expect(h.complete(merged)).rejects.toMatchObject({ status:409,error:{ code:'GATE_NOT_PASSED',details:{ event:'GATE_UNMET_AFTER_MERGE' } } });
  expect(await h.rows('select status,actual_merge_sha is not null recorded from merge_queue')).toEqual([{ status:'merged',recorded:true }]);
  expect((await h.lead('GET','/api/alerts')).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ key:'ci:gateUnmetAfterMerge|#1',text:expect.stringContaining('Gate 조건 미충족') })]));
  expect(await h.rows("select count(*)::int n from notify_events where dedup_key like 'ci:mergeMismatch|%'")).toEqual([{ n:0 }]);
  expect(await h.rows("select kind from notify_events where dedup_key='ci:gateUnmetAfterMerge|#1'")).toEqual([{ kind:'admin' }]);
  expect(await doneEvents()).toEqual([]);
  expect((await edit(true)).status).toBe(200);
  expect((await task()).lifecycleStatus).toBe('done');
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
},60_000);

// ① 자리표시, QA head 혼용, H′ 동기화 누락, Gate 우회, 중복 완료 알림을 각각 잡는다.
test('시나리오 6 전체: 실제 ①→Codex QA FAIL→등급 상향 재작업→재검증→H′ ①·②→병합→자동 done', async () => {
  // FS(Finish-to-Start, 선행 작업이 끝나야 후속을 시작하는 관계) 시험 자료다.
  await h.rows("insert into task_dependencies(project_id,pred,succ,dep_type) select a.project_id,a.id,b.id,'FS' from tasks a,tasks b where a.task_key='TASK-0001' and b.task_key='TASK-0002'");
  expect(await h.runner.startNext()).toBeUndefined();
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop();
  expect(dev.a.job.payload).toMatchObject({ kind:'dev',agent:'Claude' });
  expect((await task()).lifecycleStatus).toBe('qa');
  const qa = await h.verify(dev.head,'FAIL');
  expect(qa.job.payload.agent).toBe('Codex');
  expect(await h.rows("select kind from notify_events where kind='fail'")).toEqual([{ kind:'fail' }]);
  expect(await doneEvents()).toEqual([]);
  const rework = await h.develop();
  expect(rework.a.job.payload.kind).toBe('rework');
  expect(rework.a.grade).toMatchObject({ model:'claude-sonnet-5-5',effort:'xhigh' });
  expect(rework.head).not.toBe(dev.head);
  await h.verify(rework.head,'PASS');
  expect((await task()).lifecycleStatus).toBe('gate');
  expect((await h.lead('GET','/api/tasks/TASK-0001/gate')).body).toMatchObject({ passed:true,conditions:expect.arrayContaining([
    { key:'verification',result:'PASS',reason:expect.any(String) },
  ]) });
  expect(await doneEvents()).toEqual([]);
  const manual = await h.lead('POST','/api/tasks/TASK-0001/complete',{ updatedAt:(await task()).updatedAt });
  expect(manual.status).toBe(409);

  expect((await h.run('TASK-0002')).status).toBe(409);
  const integration = await h.integrate(rework.head);
  expect(integration.result.kind).toBe('merged');
  if (integration.result.kind !== 'merged') throw new Error('실제 병합 결과가 필요합니다.');
  const merged = integration.result;
  expect(merged).toMatchObject({ qaHeadSha:rework.head,
    headSync:{ parents:[rework.head,merged.baseSha],preserved:true,additionalChanges:false } });
  expect(merged.syncedHeadSha).not.toBe(rework.head);
  expect(merged.task).toMatchObject({ status:'pass',headSha:merged.syncedHeadSha,pipelineSha:dev.result.pipelineSha });
  expect(merged.integration).toMatchObject({ status:'pass',headSha:merged.syncedHeadSha,treeSha:merged.actualTreeSha });
  expect(h.f.ref('main')).toBe(merged.actualMergeSha);
  expect((await task()).lifecycleStatus).toBe('gate');
  expect(await doneEvents()).toEqual([]);
  expect((await Promise.all([h.complete(integration),h.complete(integration),h.complete(integration)])).map(r => r.status)).toEqual([204,204,204]);
  expect(await task()).toMatchObject({ lifecycleStatus:'done',actEnd:expect.any(String) });
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
  expect(await h.rows("select count(*)::int n from task_history where kind='완료'")).toEqual([{ n:1 }]);
  expect(await h.rows('select kind,base_sha,head_sha,spec_revision from task_attempts order by attempt_no')).toEqual([
    { kind:'dev',base_sha:dev.a.job.payload.baseCommit,head_sha:dev.head,spec_revision:1 },
    { kind:'qa',base_sha:dev.a.job.payload.baseCommit,head_sha:dev.head,spec_revision:1 },
    { kind:'rework',base_sha:dev.a.job.payload.baseCommit,head_sha:rework.head,spec_revision:1 },
    { kind:'reverify',base_sha:dev.a.job.payload.baseCommit,head_sha:rework.head,spec_revision:1 },
  ]);
  expect((await h.run('TASK-0002')).status).toBe(202);
  const runs = await h.rows('select stage,status,head_sha,pipeline_sha from ci_runs order by run_no');
  expect(runs).toEqual([
    { stage:1,status:'pass',head_sha:dev.head,pipeline_sha:dev.result.pipelineSha },
    { stage:1,status:'pass',head_sha:rework.head,pipeline_sha:dev.result.pipelineSha },
    { stage:1,status:'pass',head_sha:merged.syncedHeadSha,pipeline_sha:dev.result.pipelineSha },
    { stage:2,status:'pass',head_sha:merged.syncedHeadSha,pipeline_sha:dev.result.pipelineSha },
  ]);
},60_000);

test('① 없는 결과는 QA로 넘어가지 않는다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const a = await h.next();
  await expect(h.runner.result(a,'PASS',true)).rejects.toMatchObject({ status:409 });
  expect((await task()).lifecycleStatus).toBe('running');
  expect(await h.rows("select count(*)::int n from runner_jobs where payload->>'kind'='qa'")).toEqual([{ n:0 }]);
},30_000);

test('②의 실제 명령이 실패하면 미병합·재작업이며 성공한 CI 실행은 다시 실행할 수 없다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  const base = h.f.ref('main'); h.fail('int-e2e');
  const failed = await h.integrate(dev.head);
  expect(failed.result).toMatchObject({ kind:'rework',reason:'integration_failed',integration:{ status:'fail',failStep:'e2e' } });
  expect(h.f.ref('main')).toBe(base);
  expect((await task()).lifecycleStatus).toBe('rework');
  expect(await doneEvents()).toEqual([]);
  expect(await h.rows("select kind,ref->>'failStep' step from notify_events where kind='buildFail'")).toEqual([{ kind:'buildFail',step:'e2e' }]);
  const ci = (await h.lead('GET',`/api/projects/${h.project}/ci/runs?stage=int`)).body.items[0];
  expect(ci).toMatchObject({ status:'fail',failStep:'e2e' });
  const retry = await h.lead('POST',`/api/projects/${h.project}/ci/runs/${ci.id}/retry`,{});
  expect(retry.status,JSON.stringify(retry.body)).toBe(202);
  const rerunFail = await h.retryIntegration();
  expect(rerunFail.id).not.toBe(ci.id);
  expect(rerunFail.result).toMatchObject({ status:'fail',failStep:'e2e' });
  expect(h.f.ref('main')).toBe(base);
  expect((await h.lead('POST',`/api/projects/${h.project}/ci/runs/${rerunFail.id}/retry`,{})).status).toBe(202);
  h.fail();
  const rerunPass = await h.retryIntegration();
  expect(rerunPass.id).not.toBe(rerunFail.id);
  expect(rerunPass.result.status).toBe('pass');
  expect(h.f.ref('main')).toBe(base);
  expect((await task()).lifecycleStatus).toBe('rework');
  const passed = (await h.lead('GET',`/api/projects/${h.project}/ci/runs?stage=task`)).body.items[0];
  expect((await h.lead('POST',`/api/projects/${h.project}/ci/runs/${passed.id}/retry`,{})).status).toBe(409);
  h.fail(); const rework = await h.develop(); await h.verify(rework.head,'PASS');
  const merged = await h.integrate(rework.head);
  expect(merged.result.kind).toBe('merged'); await h.complete(merged);
  expect((await task()).lifecycleStatus).toBe('done');
},60_000);

test('병합 뒤 연결이 끊겨도 outbox를 다시 열어 한 번만 완료·알림을 기록한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  const merged = await h.integrate(dev.head);
  h.runner.online = false;
  const entry = await h.queueCompletion(merged);
  await h.outbox.flush();
  expect(h.state.snapshot.outbox).toHaveLength(1);
  expect((await task()).lifecycleStatus).toBe('gate');
  expect(await doneEvents()).toEqual([]);
  await h.restartOutbox(); h.runner.online = true;
  await expect.poll(async () => { await h.outbox.flush(); return h.state.snapshot.outbox.length; },{ timeout:10_000,interval:30 }).toBe(0);
  expect(h.outbox.rejected).toEqual([]);
  expect((await task()).lifecycleStatus).toBe('done');
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
  // 응답 유실 뒤 같은 멱등 키를 다시 전송한 경우도 재현한다.
  await h.outbox.enqueue('reportMergeQueue',entry.request as Parameters<typeof h.outbox.enqueue<'reportMergeQueue'>>[1]);
  await h.outbox.flush();
  expect(h.outbox.rejected).toEqual([]);
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
  expect(h.f.github.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
},60_000);

test('같은 종류 프로세스 실패는 자동 2회 뒤 멈추고 수동 재실행도 횟수를 초기화하지 않는다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  for (let i = 0; i < 3; i++) {
    const a = await h.next(); expect(a.job.payload.kind).toBe('dev');
    await h.processFailed(a);
    expect((await task()).lifecycleStatus).toBe('failed');
    expect(await h.rows("select count(*)::int n from notify_events where kind='fail'")).toEqual([{ n:i === 2 ? 1 : 0 }]);
  }
  expect(await h.runner.startNext()).toBeUndefined();
  expect((await h.lead('GET','/api/alerts')).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ text:expect.stringContaining('한도') })]));
  expect((await h.run('TASK-0001')).status).toBe(202);
  expect((await h.run('TASK-0001')).status).toBe(409);
  await h.processFailed(await h.next());
  expect(await h.runner.startNext()).toBeUndefined();
  expect(await h.rows("select count(*)::int n from task_attempts where status='failed'")).toEqual([{ n:4 }]);
  expect(await h.rows("select count(*)::int n from notify_events where kind='fail'")).toEqual([{ n:2 }]);
},30_000);

test('QA·통합 실패의 재작업은 합산 3회이며 BLOCKED·프로세스 재시도는 회차를 늘리지 않는다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'FAIL');
  const reworks: string[] = [];
  for (let round = 0; round < 2; round++) {
    for (let failure = 0; failure < 2; failure++) {
      const a = await h.next(); expect(a.job.payload.kind).toBe('rework');
      await h.processFailed(a);
    }
    const rework = await h.develop(); reworks.push(rework.head);
    if (round === 0) {
      const blocked = await h.verify(rework.head,'BLOCKED');
      expect(await h.runner.startNext()).toBeUndefined();
      expect(await h.rows("select count(*)::int n from notify_events where kind='fail'")).toEqual([{ n:1 }]);
      expect((await h.lead('POST','/api/tasks/TASK-0001/runs',{ kind:'reverify',updatedAt:(await task()).updatedAt })).status).toBe(202);
      const failed = await h.verify(rework.head,'FAIL'); expect(failed.attemptId).not.toBe(blocked.attemptId);
    } else {
      await h.verify(rework.head,'PASS'); h.fail('int-e2e');
      expect((await h.integrate(rework.head)).result).toMatchObject({ kind:'rework',reason:'integration_failed' });
      h.fail();
    }
  }
  const third = await h.develop(); await h.verify(third.head,'FAIL');
  expect(await h.runner.startNext()).toBeUndefined();
  expect((await h.lead('GET','/api/alerts')).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ text:expect.stringContaining('자동 재작업 한도') })]));
  expect(await doneEvents()).toEqual([]);
  // 수동 한 번을 허용해도 다음 QA FAIL 뒤 자동 회차가 새로 생기면 안 된다.
  expect((await h.lead('POST','/api/tasks/TASK-0001/runs',{ kind:'rework',updatedAt:(await task()).updatedAt })).status).toBe(202);
  expect((await h.lead('POST','/api/tasks/TASK-0001/runs',{ kind:'rework',updatedAt:(await task()).updatedAt })).status).toBe(409);
  const manual = await h.develop(); await h.verify(manual.head,'FAIL');
  expect(await h.runner.startNext()).toBeUndefined();
  expect(await h.rows("select count(distinct payload->>'automaticCause')::int n from runner_jobs where payload->>'kind'='rework'")).toEqual([{ n:3 }]);
  expect(reworks[0]).not.toBe(reworks[1]);
},90_000);

test.each([
  ['checklist',"update checklist_items set done=false","update checklist_items set done=true"],
  ['outputs',"update task_outputs set delivered=false","update task_outputs set delivered=true"],
  ['verification',"update task_specs set revision=revision+1","update task_specs set revision=revision-1"],
  ['defects',"insert into defects(project_id,def_key,verification,blocking,content) select a.project_id,'LATE',v.id,true,'병합 직후 추가된 결함' from verifications v join task_attempts a on a.id=v.attempt",
    "insert into defect_events(project_id,defect,kind,resolved_by_verification,detail) select project_id,id,'resolved',verification,'{}' from defects where def_key='LATE'"],
  ['approval',"update tasks set planning_approved_at=null","update tasks set planning_approved_at=clock_timestamp()"],
])('병합 직후 %s 조건이 바뀌면 완료를 보류하고 회복 뒤 저장된 근거로 수동 완료한다', async (key, sql, restore) => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  const merged = await h.integrate(dev.head);
  // 다른 트랜잭션이 남긴 늦은 변경을 주입한다. 성공 경로의 상태·검사 결과는 DB로 만들지 않는다.
  await h.rows(sql);
  const gate = (await h.lead('GET','/api/tasks/TASK-0001/gate')).body;
  expect(gate.passed).toBe(false);
  expect(gate.conditions).toEqual(expect.arrayContaining([expect.objectContaining({ key,result:expect.not.stringMatching(/^PASS$/),reason:expect.any(String) })]));
  expect((await h.lead('POST','/api/tasks/TASK-0001/complete',{ updatedAt:(await task()).updatedAt })).status).toBe(409);
  await expect(h.complete(merged)).rejects.toMatchObject({ status:409,error:{ code:'GATE_NOT_PASSED',details:{ event:'GATE_UNMET_AFTER_MERGE' } } });
  expect((await task()).lifecycleStatus).toBe('gate');
  expect(await doneEvents()).toEqual([]);
  expect(await h.rows('select status from merge_queue')).toEqual([{ status:'merged' }]);
  await h.rows(restore);
  const completed = await h.lead('POST','/api/tasks/TASK-0001/complete',{ updatedAt:(await task()).updatedAt });
  expect(completed.status,JSON.stringify(completed.body)).toBe(200);
  expect((await task()).lifecycleStatus).toBe('done');
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
  expect(await h.rows("select count(*)::int n from alerts where key='ci:gateUnmetAfterMerge|#1' and resolved_at is null")).toEqual([{ n:0 }]);
},60_000);

test('Gate 회복 감시는 Runner 재보고 없이 착수 승인 회복을 자동 완료한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  const merged = await h.integrate(dev.head);
  await h.rows('update tasks set planning_approved_at=null');
  await expect(h.complete(merged)).rejects.toMatchObject({ error:{ code:'GATE_NOT_PASSED' } });
  await h.rows('update tasks set planning_approved_at=clock_timestamp()');
  await h.recheckCompletion();
  expect((await task()).lifecycleStatus).toBe('done');
  expect(await doneEvents()).toEqual([{ kind:'done' }]);
},60_000);

test('예상 head와 다른 실제 병합 근거는 경고로 남고 done 알림을 만들지 않는다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.develop(); await h.verify(dev.head,'PASS');
  const merged = await h.integrate(dev.head);
  await expect(h.complete(merged,{ mergeParents:['f'.repeat(40),dev.head] })).rejects.toMatchObject({ status:409,error:{ code:'MERGE_MISMATCH' } });
  expect((await task()).lifecycleStatus).toBe('gate');
  expect(await doneEvents()).toEqual([]);
  expect((await h.lead('GET','/api/alerts')).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ key:'ci:mergeMismatch|#1' })]));
  // 같은 SHA의 첫 부모 기록은 바꿀 수 없으므로 올바른 값으로 덮어써도 완료하지 않는다.
  await expect(h.complete(merged)).rejects.toMatchObject({ status:409,error:{ code:'MERGE_MISMATCH' } });
  expect((await task()).lifecycleStatus).toBe('gate');
},60_000);
