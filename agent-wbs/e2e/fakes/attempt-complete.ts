import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect } from 'vitest';
import { ApiTransportError, type ApiClient, type ApiRequest } from '../../../agent-runner/src/api/client.ts';
import { Outbox } from '../../../agent-runner/src/api/outbox.ts';
import { type IntegrationResult } from '../../../agent-runner/src/ci/integration/queue.ts';
import { CiJobs, type CiJobResult } from '../../../agent-runner/src/ci/jobs.ts';
import { parsePipeline } from '../../../agent-runner/src/ci/pipeline.ts';
import { runTaskCheck, type TaskCheckResult } from '../../../agent-runner/src/ci/task.ts';
import { openPullRequest } from '../../../agent-runner/src/jobs/task-check.ts';
import { State } from '../../../agent-runner/src/state/state.ts';
import { installFakeCli, runCli } from '../../../agent-runner/test/fakes/cli.ts';
import { commit, file, fixture, git } from '../../../agent-runner/test/ci/int-fixture.ts';
import { scenario } from './test/scenario.ts';
import type { Running } from './runner.ts';

const write = () => ({ epoch:1,idempotencyKey:randomUUID() });
type QueueBody = ApiRequest<'reportMergeQueue'>['body'];

/**
 * CI 실행기(M7-06) 시나리오의 준비 코드. 시도 흐름(M5-05) 자체의 실제 연결은 attempt-flow.scenario.test.ts의 「M5·M7 통합」 시나리오가 확인한다.
 * 여기서도 PR은 실제 M4 GitHub 계층으로 연다(조정자 결정 1). PR 번호를 주입하지 않는다.
 */
export async function completeScenario() {
  const f = await fixture('agent/TASK-0001-h1');
  // 입력 관측도 실제 git 트리를 읽게 한다. 이 파일은 시험용 저장소에만 있다.
  await file(join(f.source,'prototype/docs/guide.md'),'고정 시험 입력\n');
  commit(f.source); git(f.source,'push',f.remote,'main');
  const h = await scenario({ inputCommit:f.ref('main') });
  let state = await State.open(join(f.root,'outbox'));
  await state.update(d => { d.epoch = 1; });
  let outbox:Outbox;
  const claude = installFakeCli(join(f.root,'cli'),'claude');
  let codex = installFakeCli(join(f.root,'cli'),'codex');
  const checks = installFakeCli(join(f.root,'checks'),'codex',{ lines:['검사 통과'] });
  let failStep: string | undefined;
  let deferCompletion = true;
  const ciApi:ApiClient = async (operation,request) => {
    if (deferCompletion && operation === 'reportMergeQueue' && (request as { body?:{status?:string} }).body?.status === 'merged') throw new ApiTransportError(operation);
    return h.runner.api(operation,request);
  };
  outbox = new Outbox(state,ciApi);
  const ci = () => new CiJobs({ ...f.deps,directory:join(f.root,'ci-jobs'),api:ciApi,outbox,runnerId:state.snapshot.runnerId,epoch:()=>1,ready:()=>true,
    identity:{ hostId:h.runner.hostId,bootId:h.runner.bootId },execute:(_job,argv,cwd) => execute(argv,cwd),warn:()=>undefined });
  let flow:CiJobs;
  let inputHead = f.ref('main');
  await h.rows("update notify_settings set enabled=true where singleton");
  await h.rows("insert into notify_rules(key,enabled) values('done',true),('fail',true),('buildFail',true),('buildOk',true),('admin',true) on conflict(key) do update set enabled=true");
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
  // PR 번호는 주입하지 않는다. ① 보고는 Runner가 실제로 연 PR(번호·head 브랜치)을, 통합 결과는 통합 job의 PR을 보낸다(조정자 결정 1).
  const reportCheck = async (job: { id:string;fence:number }, result: TaskCheckResult | Extract<IntegrationResult,{ kind:'merged' }>['integration'],
    attemptId?: string, pull?: { number:number;head:string }) => {
    const run = await h.runner.api('startCiRun',{ ...write(),body:{ jobId:job.id,fence:job.fence,stage:result.stage,taskKey:'TASK-0001',
      ...(attemptId && { attemptId }),ref:f.request.branch,...(pull && { pr:pull.number,prHead:pull.head }),trigger:'attempt-complete',baseSha:result.baseSha,headSha:result.headSha,pipelineSha:result.pipelineSha,
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
      // 조정자 결정 1: dev → push → PR 열기 → ①. 실제 M4 GitHub 계층(fake GitHub)으로 PR을 연다.
      const pull = await openPullRequest({ github:f.deps.github,repo:f.repo },a.job,await f.repo.importWorktree(id,branch));
      const basis = await f.repo.mainPipeline(); await observe(basis);
      const result = await runTaskCheck({ ...f.deps,execute,basis,worktreeId:id,branch });
      expect(result.status).toBe('pass'); expect(result.headSha).toBe(head);
      await reportCheck(a.job,result,a.attemptId,pull);
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
  flow = ci();
  const integrate = async (head:string) => {
    const outcome = await flow.runNext(20);
    assert(outcome && outcome.job.kind === 'integrate' && outcome.result);
    if ('qaHeadSha' in outcome.result) expect(outcome.result.qaHeadSha).toBe(head);
    return { ...outcome,result:outcome.result };
  };
  const completionBody = (integration:CiJobResult,changes:Partial<QueueBody> = {}):QueueBody => {
    assert(integration.completion); return { ...integration.completion,...changes };
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
    const outcome = await flow.runNext(20); assert(outcome?.job.kind === 'ci_retry' && outcome.ciRunId);
    const result = await h.lead('GET',`/api/projects/${h.project}/ci/runs/${outcome.ciRunId}`);
    return { id:outcome.ciRunId,result:result.body };
  };
  return { ...h,f,next,develop,verify,integrate,reportCheck,observe,execute,processFailed,retryIntegration,
    get state() { return state; },get outbox() { return outbox; },
    complete: (integration: Awaited<ReturnType<typeof integrate>>, changes: Partial<QueueBody> = {}) => h.runner.api('reportMergeQueue',{ ...write(),body:completionBody(integration,changes) }),
    queueCompletion: async (integration: Awaited<ReturnType<typeof integrate>>) => {
      const entry = state.snapshot.outbox.find(e => e.operation === 'reportMergeQueue' && e.request.body?.status === 'merged' && e.request.body.jobId === integration.job.id);
      assert(entry); return entry;
    },
    restartOutbox: async () => { await flow.shutdown(); await state.close(); state = await State.open(join(f.root,'outbox')); deferCompletion = false; outbox = new Outbox(state,ciApi); flow = ci(); },
    recoverCi: async () => { deferCompletion = false; return flow.runNext(20); },
    allowCompletion: () => { deferCompletion = false; },
    fail: (step?: string) => { failStep = step; },
    close: async () => { await flow.shutdown(); await state.close(); await h.close(); await f.close(); } };
}

export type CompleteScenario = Awaited<ReturnType<typeof completeScenario>>;
