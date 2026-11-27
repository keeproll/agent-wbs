import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect } from 'vitest';
import { type ApiRequest } from '../../../agent-runner/src/api/client.ts';
import { Outbox } from '../../../agent-runner/src/api/outbox.ts';
import { IntegrationQueue, type IntegrationResult } from '../../../agent-runner/src/ci/integration/queue.ts';
import { runIntegrationCheck } from '../../../agent-runner/src/ci/integration/check.ts';
import { parsePipeline } from '../../../agent-runner/src/ci/pipeline.ts';
import { runTaskCheck, type TaskCheckResult } from '../../../agent-runner/src/ci/task.ts';
import { State } from '../../../agent-runner/src/state/state.ts';
import { installFakeCli, runCli } from '../../../agent-runner/test/fakes/cli.ts';
import { commit, file, fixture, git } from '../../../agent-runner/test/ci/int-fixture.ts';
import { scenario } from './test/scenario.ts';
import type { Running } from './runner.ts';

const write = () => ({ epoch:1,idempotencyKey:randomUUID() });
type QueueBody = ApiRequest<'reportMergeQueue'>['body'];

/** shortcut: M5-05가 아직 없다, 병합되면 claim·CLI·결과 연결 준비 코드를 그 실행기로 교체한다. */
export async function completeScenario() {
  const f = await fixture('agent/TASK-0001-h1');
  // 입력 관측도 실제 git 트리를 읽게 한다. 이 파일은 시험용 저장소에만 있다.
  await file(join(f.source,'prototype/docs/guide.md'),'고정 시험 입력\n');
  commit(f.source); git(f.source,'push',f.remote,'main');
  const h = await scenario({ inputCommit:f.ref('main') });
  let state = await State.open(join(f.root,'outbox'));
  await state.update(d => { d.epoch = 1; });
  let outbox = new Outbox(state,h.runner.api);
  const claude = installFakeCli(join(f.root,'cli'),'claude');
  let codex = installFakeCli(join(f.root,'cli'),'codex');
  const checks = installFakeCli(join(f.root,'checks'),'codex',{ lines:['검사 통과'] });
  let failStep: string | undefined;
  let queue: IntegrationQueue | undefined;
  let inputHead = f.ref('main');
  await h.rows("update notify_settings set enabled=true where singleton");
  await h.rows("insert into notify_rules(key,enabled) values('done',true),('fail',true),('buildFail',true),('buildOk',true) on conflict(key) do update set enabled=true");
  const observe = async (basis: Awaited<ReturnType<typeof f.repo.mainPipeline>>) => {
    const pipeline = parsePipeline(basis.source);
    await h.runner.api('reportInputChanges',{ ...write(),body:{ base:inputHead,head:basis.baseSha,
      ...await f.repo.inputObservation(inputHead,basis.baseSha),pipelineObservation:{ baseSha:basis.baseSha,pipelineSha:basis.pipelineSha,
        definition:{ path:'.agentwbs/pipeline.yaml',commit:basis.baseSha,status:'ok',error:null,raw:basis.source,
          stages:Object.entries(pipeline.stages).map(([stage,steps]) => ({ stage:stage as 'task'|'int'|'night'|'deploy',when:'시험',gate:'시험',steps:steps.map(s => s.name) })) } } } });
    inputHead = basis.baseSha;
  };
  const execute = async (argv: readonly string[], cwd: string) => {
    // 명령은 실제 자식 프로세스로 끝까지 실행한다. 유료 CLI나 외부 서비스는 호출하지 않는다.
    const failed = argv[1] === failStep;
    installFakeCli(join(f.root,'checks'),'codex',{ lines:[failed ? '검사 실패' : '검사 통과'],exitCode:failed ? 1 : 0 });
    return runCli(checks.path,argv.slice(1),{ cwd });
  };
  const reportCheck = async (job: { id:string;fence:number }, result: TaskCheckResult | Extract<IntegrationResult,{ kind:'merged' }>['integration'], attemptId?: string) => {
    const run = await h.runner.api('startCiRun',{ ...write(),body:{ jobId:job.id,fence:job.fence,stage:result.stage,taskKey:'TASK-0001',
      ...(attemptId && { attemptId }),ref:f.request.branch,pr:1,trigger:'attempt-complete',baseSha:result.baseSha,headSha:result.headSha,pipelineSha:result.pipelineSha,
      ...('treeSha' in result && { treeSha:result.treeSha }) } });
    await h.runner.api('updateCiRun',{ ...write(),params:{ id:run.body.id },body:{ fence:job.fence,status:'run' } });
    await h.runner.api('updateCiRun',{ ...write(),params:{ id:run.body.id },body:{ fence:job.fence,status:result.status,steps:result.steps.map(({ name,status,durationMs }) => ({ name,status,durationMs })),
      ...('failScope' in result && result.failScope && { failScope:result.failScope }) } });
    return run.body.id;
  };
  const next = async (head?: string) => {
    let running: Running | undefined;
    await expect.poll(async () => { running = await h.runner.startNext(head); return Boolean(running); },{ timeout:10_000,interval:30 }).toBe(true);
    assert(running); return running;
  };
  const develop = async () => {
    const a = await next();
    assert(['dev','rework'].includes(a.job.payload.kind));
    const id = `dev-${randomUUID()}`;
    const branch = `agent/${id}`;
    const path = await f.repo.createWorktree(id,branch,await f.repo.fetchBranch(f.request.branch));
    try {
      const output = await runCli(claude.path,['--model',a.grade.model,'--effort',a.grade.effort],{ cwd:path });
      expect(output.code).toBe(0);
      assert(output.stdout.includes('"is_error":false'));
      await file(join(path,'src/result.ts'),`export const attempt = ${JSON.stringify(a.attemptId)};\n`);
      const head = commit(path);
      const basis = await f.repo.mainPipeline(); await observe(basis);
      const result = await runTaskCheck({ ...f.deps,execute,basis,worktreeId:id,branch });
      expect(result.status).toBe('pass'); expect(result.headSha).toBe(head);
      await reportCheck(a.job,result,a.attemptId);
      await f.repo.pushCommit(head,a.job.payload.branch);
      // FakeRunner에 ① 대체 기록을 만들지 않게 한다. 위 실제 실행 기록만 서버가 사용한다.
      await h.runner.result(a,'PASS',true);
      return { a,head,result };
    } finally { await f.repo.removeWorktree(id); }
  };
  const verify = async (head: string, outcome: 'PASS'|'FAIL'|'BLOCKED') => {
    const a = await next(head);
    assert(['qa','reverify'].includes(a.job.payload.kind));
    codex = installFakeCli(join(f.root,'cli'),'codex',{ lines:[{ result:outcome }] });
    const id = `qa-${randomUUID()}`;
    const path = await f.repo.createTaskCheckWorktree(id,head);
    try {
      const output = await runCli(codex.path,['exec','--json','--model',a.grade.model],{ cwd:path });
      expect(output.code).toBe(0);
      const report = JSON.parse(output.stdout) as { result:'PASS'|'FAIL'|'BLOCKED' };
      await f.repo.taskCheckPath(id,head);
      await h.runner.result(a,report.result,true);
      return a;
    } finally { await f.repo.removeWorktree(id); }
  };
  const integrate = async (head: string) => {
    const claimed = await h.runner.api('claimJob',{ ...write(),body:{ kinds:['integrate'],capacity:20 } });
    assert(claimed.status === 200 && claimed.body.job.kind === 'integrate','서버가 통합 job을 만들어야 합니다.');
    const job = claimed.body.job;
    await h.runner.api('startJob',{ ...write(),params:{ id:job.id },body:{ fence:job.fence,hostId:h.runner.hostId,bootId:h.runner.bootId,headSha:head,installedSubagents:[] } });
    await h.runner.api('releaseJobSlots',{ ...write(),params:{ id:job.id },body:{ fence:job.fence,hostId:h.runner.hostId,proof:{ kind:'no_process',bootId:h.runner.bootId },at:new Date().toISOString() } });
    const queued: QueueBody = { jobId:job.id,fence:job.fence,pr:1,taskKey:'TASK-0001',status:'queued',qaHeadSha:head };
    await h.runner.api('reportMergeQueue',{ ...write(),body:queued });
    await queue?.close();
    queue = await IntegrationQueue.open({ ...f.deps,execute,observeMainPipeline:observe,readVerification:async () => {
      const verifications = (await h.lead('GET','/api/tasks/TASK-0001/verifications')).body.items as { result:string;headSha:string;specRevision:number }[];
      const v = verifications.find(v => v.headSha === head);
      return { passed:v?.result === 'PASS',headSha:v?.headSha ?? '',specRevision:v?.specRevision ?? 0 };
    } });
    const result = await queue.run({ ...f.request,qaHeadSha:head });
    let taskRun: string | undefined, intRun: string | undefined;
    if ('task' in result && result.task) taskRun = await reportCheck(job,result.task);
    if ('integration' in result && result.integration) intRun = await reportCheck(job,result.integration);
    const evidence = { ...queued,...('baseSha' in result && result.baseSha && { baseSha:result.baseSha }),
      ...('syncedHeadSha' in result && result.syncedHeadSha && { syncedHeadSha:result.syncedHeadSha }),
      ...('headSync' in result && result.headSync && { headSync:result.headSync }),
      ...(intRun && { ciRunId:intRun }),...('integration' in result && result.integration && { testedTreeSha:result.integration.treeSha }) };
    if (result.kind === 'merged') await h.runner.api('reportMergeQueue',{ ...write(),body:{ ...evidence,status:'checking' } });
    else if (result.kind === 'rework' || result.kind === 'baseline_failed') {
      const ciRunId = intRun ?? taskRun;
      await h.runner.api('reportMergeQueue',{ ...write(),body:{ ...evidence,status:'failed',...(ciRunId && { ciRunId }) } });
    }
    else await h.runner.api('reportMergeQueue',{ ...write(),body:{ ...evidence,status:'removed' } });
    return { job,result,evidence };
  };
  const completionBody = (integration: Awaited<ReturnType<typeof integrate>>, changes: Partial<QueueBody> = {}): QueueBody => {
    const { result } = integration; assert(result.kind === 'merged');
    return { ...integration.evidence,status:'merged',actualMergeSha:result.actualMergeSha,actualTreeSha:result.actualTreeSha,
      mergeParents:result.mergeParents,mergedAt:new Date().toISOString(),...changes };
  };
  const processFailed = async (a: Running) => {
    const cli = installFakeCli(join(f.root,'failed'),'claude',{ exitCode:1,stderr:'프로세스 실패' });
    const output = await runCli(cli.path,[],{ cwd:f.source });
    expect(output.code).toBe(1);
    await h.runner.api('releaseJobSlots',{ ...write(),params:{ id:a.job.id },body:{ fence:a.job.fence,hostId:h.runner.hostId,
      proof:{ kind:'group_empty',bootId:a.bootId,processGroup:a.processGroup },at:new Date().toISOString() } });
    await h.runner.api('reportAttemptResult',{ ...write(),params:{ attemptId:a.attemptId },body:{ fence:a.job.fence,summary:output.stderr,changedFiles:[],evidence:[],failure:'process_failed' } });
  };
  const retryIntegration = async () => {
    const claimed = await h.runner.api('claimJob',{ ...write(),body:{ kinds:['ci_retry'],capacity:20 } });
    assert(claimed.status === 200 && claimed.body.job.kind === 'ci_retry');
    const job = claimed.body.job;
    await h.runner.api('startJob',{ ...write(),params:{ id:job.id },body:{ fence:job.fence,hostId:h.runner.hostId,bootId:h.runner.bootId,headSha:job.payload.commit,installedSubagents:[] } });
    const basis = await f.repo.mainPipeline(); await observe(basis);
    const result = await runIntegrationCheck({ ...f.deps,execute },basis,job.payload.commit);
    const id = await reportCheck(job,result);
    await h.runner.api('releaseJobSlots',{ ...write(),params:{ id:job.id },body:{ fence:job.fence,hostId:h.runner.hostId,proof:{ kind:'no_process',bootId:h.runner.bootId },at:new Date().toISOString() } });
    await h.runner.api('finishJob',{ ...write(),params:{ id:job.id },body:{ fence:job.fence,status:result.status === 'pass' ? 'done' : 'failed' } });
    await h.runner.api('releaseJob',{ ...write(),params:{ id:job.id },body:{ fence:job.fence,hostId:h.runner.hostId,proof:{ kind:'no_process',bootId:h.runner.bootId },at:new Date().toISOString() } });
    return { id,result };
  };
  return { ...h,f,next,develop,verify,integrate,reportCheck,observe,execute,processFailed,retryIntegration,
    get state() { return state; },get outbox() { return outbox; },
    complete: (integration: Awaited<ReturnType<typeof integrate>>, changes: Partial<QueueBody> = {}) => h.runner.api('reportMergeQueue',{ ...write(),body:completionBody(integration,changes) }),
    queueCompletion: async (integration: Awaited<ReturnType<typeof integrate>>) => {
      const entry = await outbox.enqueue('reportMergeQueue',{ epoch:1,body:completionBody(integration) });
      await queue?.acknowledge(); return entry;
    },
    restartOutbox: async () => { await state.close(); state = await State.open(join(f.root,'outbox')); outbox = new Outbox(state,h.runner.api); },
    fail: (step?: string) => { failStep = step; },
    close: async () => { await queue?.close(); await state.close(); await h.close(); await f.close(); } };
}

export type CompleteScenario = Awaited<ReturnType<typeof completeScenario>>;
