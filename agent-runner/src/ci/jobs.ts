import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, type ApiClient, type ApiRequest, type ApiResponse } from '../api/client.ts';
import { retryable, type Outbox } from '../api/outbox.ts';
import type { ClaimedJob } from '../api/generated/client.ts';
import { InputChangeReporter } from '../git/inputs.ts';
import { atomicWrite } from '../state/files.ts';
import type { Entry, ReportId } from '../state/state.ts';
import { parsePipeline } from './pipeline.ts';
import { runTaskCheck, type TaskCheckResult } from './task.ts';
import { runIntegrationCheck, type IntegrationCheck, type MainBasis } from './integration/check.ts';
import { IntegrationQueue, type IntegrationDeps, type IntegrationResult } from './integration/queue.ts';

type Job = Extract<ClaimedJob,{ kind:'integrate'|'ci_retry' }>;
type Context = ApiResponse<'getCiJob'>['body'];
type QueueBody = ApiRequest<'reportMergeQueue'>['body'];
interface Event { operation:ReportId;request:Entry['request'] }
interface Saved {
  version:1;epoch:number;job:Job;round:number;events:Record<string,Event>;runs:Record<string,string>;
  context?:Context;result?:IntegrationResult;completion?:QueueBody;
}
export interface CiJobsOptions extends Pick<IntegrationDeps,'repo'|'github'|'heavy'|'collectTests'> {
  directory:string;api:ApiClient;outbox:Outbox;runnerId:string;epoch:()=>number;ready:()=>boolean;
  identity:{ hostId:string;bootId:string };
  /** 프로세스 등록·종료 확인·슬롯 반환을 마친 실행기다. heavy 번호표는 검사 함수가 이미 보유한다. */
  execute:(job:Job & { epoch:number },argv:readonly string[],cwd:string,signal?:AbortSignal)=>ReturnType<IntegrationDeps['execute']>;
  warn:(message:string)=>void;
}
export interface CiJobResult { job:Job;result:IntegrationResult|null;completion?:QueueBody;ciRunId?:string }
const checkKey = (check:TaskCheckResult|IntegrationCheck) => `${check.stage}:${check.baseSha}:${check.headSha}`;

/** ②·재실행을 서버 job과 연결한다. 병합 journal은 보고 대기함에 넣기 전까지 지우지 않는다. */
export class CiJobs {
  readonly #d:CiJobsOptions;
  #active:Promise<CiJobResult|null>|undefined;
  #saved:Saved|undefined;
  #queue:IntegrationQueue|undefined;
  #controller:AbortController|undefined;
  readonly #inputs:InputChangeReporter;
  constructor(options:CiJobsOptions) {
    this.#d = options;
    this.#inputs = new InputChangeReporter({ api:options.api,epoch:options.epoch,warn:options.warn });
  }

  runNext(capacity:number,signal?:AbortSignal):Promise<CiJobResult|null> {
    if (this.#active || !this.#d.ready() || capacity <= 0) return Promise.resolve(null);
    const task = this.#next(capacity,signal);
    this.#active = task;
    void task.finally(() => { this.#active = undefined; }).catch(() => undefined);
    return task;
  }

  async #save():Promise<void> {
    await atomicWrite(this.#d.directory,'ci-job.json',JSON.stringify(this.#saved ?? null));
  }

  async #next(capacity:number,signal?:AbortSignal):Promise<CiJobResult|null> {
    const d = this.#d;
    await mkdir(d.directory,{ recursive:true,mode:0o700 });
    try {
      const saved = JSON.parse(await readFile(join(d.directory,'ci-job.json'),'utf8')) as Saved|null;
      if (saved && (saved.version !== 1 || !saved.job || !['integrate','ci_retry'].includes(saved.job.kind) ||
        !Number.isSafeInteger(saved.epoch) || !Number.isSafeInteger(saved.round) || !saved.events || !saved.runs)) throw new Error('CI 작업 기록이 손상되었습니다. 원본을 보존하세요.');
      this.#saved = saved ?? undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.#saved && this.#saved.epoch !== d.epoch()) throw new Error('초기화 전 CI 병합 기록을 먼저 대조해야 합니다.');
    if (!this.#saved) {
      const claim = await d.api('claimJob',{ epoch:d.epoch(),idempotencyKey:randomUUID(),body:{ kinds:['integrate','ci_retry'],capacity } });
      if (claim.status === 204) return null;
      const job = claim.body.job;
      if (job.kind !== 'integrate' && job.kind !== 'ci_retry') throw new Error('CI가 처리하지 않는 job입니다.');
      this.#saved = { version:1,epoch:d.epoch(),job,round:0,events:{},runs:{} };
      await this.#save();
    }
    const saved = this.#saved;
    const pending = d.outbox.pending.find(e => e.operation === 'reportMergeQueue' && e.request.body?.jobId === saved.job.id && e.request.body.status === 'merged');
    if (pending && pending.nextAt > 0 && saved.result) {
      await d.outbox.flush();
      if (d.outbox.pending.some(e => e.id === pending.id)) return { job:saved.job,result:saved.result,...(saved.completion && { completion:saved.completion }) };
    }
    this.#controller = new AbortController();
    const stopped = signal ? AbortSignal.any([signal,this.#controller.signal]) : this.#controller.signal;
    let renewing:Promise<unknown>|undefined;
    const timer = setInterval(() => {
      if (!renewing) renewing = d.api('renewJob',{ epoch:saved.epoch,params:{ id:saved.job.id },idempotencyKey:randomUUID(),body:{ fence:saved.job.fence } })
        .catch(error => { this.#controller?.abort(error); }).finally(() => { renewing = undefined; });
    },15_000);
    timer.unref();
    try { return await this.#run(saved,stopped); }
    finally { clearInterval(timer); await renewing; await this.#queue?.close(); this.#queue = undefined; this.#controller = undefined; }
  }

  async #send<K extends ReportId>(label:string,operation:K,request:Omit<ApiRequest<K>,'idempotencyKey'>):Promise<ApiResponse<K>> {
    const saved = this.#saved;
    if (!saved) throw new Error('CI 작업 기록이 없습니다.');
    let event = saved.events[label];
    if (!event) {
      event = { operation,request:JSON.parse(JSON.stringify({ ...request,idempotencyKey:`ci:${this.#d.runnerId}:${randomUUID()}` })) as Entry['request'] };
      saved.events[label] = event;
      await this.#save();
    }
    if (event.operation !== operation) throw new Error('CI 보고 순서가 작업 기록과 다릅니다.');
    await this.#d.outbox.enqueue(operation,event.request as ApiRequest<K>);
    const response = await this.#d.api(operation,event.request as ApiRequest<K>);
    await this.#d.outbox.flush();
    return response;
  }

  async #observe(basis:MainBasis) {
    const pipeline = parsePipeline(basis.source);
    const result = await this.#inputs.report({ fetch:async () => basis.baseSha,inputObservation:async (base,head) => ({
      ...await this.#d.repo.inputObservation(base,head),pipelineObservation:{ baseSha:basis.baseSha,pipelineSha:basis.pipelineSha,
        definition:{ path:'.agentwbs/pipeline.yaml',commit:basis.baseSha,status:'ok',error:null,raw:basis.source,
          stages:Object.entries(pipeline.stages).map(([stage,steps]) => ({ stage:stage as 'task'|'int'|'night'|'deploy',when:stage,gate:'검사 통과',steps:steps.map(s => s.name) })) } },
    }) });
    if (!('head' in result) || result.head !== basis.baseSha || result.historyRewritten) throw new Error('main 파이프라인 관측을 서버가 수용하지 않았습니다.');
  }

  async #check(saved:Saved,check:TaskCheckResult|IntegrationCheck):Promise<string> {
    const context = saved.context;
    if (!context) throw new Error('CI 실행 문맥이 없습니다.');
    const label = `${saved.round}:${checkKey(check)}`;
    const started = await this.#send(`${label}:start`,'startCiRun',{ epoch:saved.epoch,body:{ jobId:saved.job.id,fence:saved.job.fence,stage:check.stage,
      ...(context.taskKey && { taskKey:context.taskKey }),ref:context.source?.ref ?? context.branch ?? 'main',
      ...(saved.job.payload.pr && { pr:saved.job.payload.pr }),trigger:saved.job.kind,baseSha:check.baseSha,headSha:check.headSha,pipelineSha:check.pipelineSha,
      ...('treeSha' in check && { treeSha:check.treeSha }) } });
    const id = started.body.id;
    saved.runs[checkKey(check)] = id; await this.#save();
    await this.#send(`${label}:run`,'updateCiRun',{ epoch:saved.epoch,params:{ id },body:{ fence:saved.job.fence,status:'run' } });
    await this.#send(`${label}:result`,'updateCiRun',{ epoch:saved.epoch,params:{ id },body:{ fence:saved.job.fence,status:check.status,
      steps:check.steps.map(({ name,status,durationMs }) => ({ name,status,durationMs })),
      ...('failScope' in check && check.failScope && { failScope:check.failScope }),finishedAt:new Date().toISOString() } });
    return id;
  }

  async #queueReport(saved:Saved,status:QueueBody['status'],extra:Partial<QueueBody> = {}):Promise<void> {
    const context = saved.context;
    if (!context?.taskKey || !context.verification || saved.job.kind !== 'integrate') throw new Error('통합 근거가 없습니다.');
    await this.#send(`${saved.round}:queue:${status}`,'reportMergeQueue',{ epoch:saved.epoch,body:{ jobId:saved.job.id,fence:saved.job.fence,
      pr:saved.job.payload.pr,taskKey:context.taskKey,qaHeadSha:context.verification.headSha,status,...extra } });
  }

  async #run(saved:Saved,signal:AbortSignal):Promise<CiJobResult> {
    const d = this.#d, job = saved.job;
    const context = (await d.api('getCiJob',{ epoch:saved.epoch,params:{ id:job.id },query:{ fence:job.fence } })).body;
    saved.context ??= context; await this.#save();
    const execute:IntegrationDeps['execute'] = (argv,cwd,stopped) => d.execute({ ...job,epoch:saved.epoch },argv,cwd,stopped);
    if (job.kind === 'ci_retry') {
      if (!context.runnable || !context.source) throw new Error('재실행 임대 또는 원본 근거가 없습니다.');
      saved.round++; await this.#save();
      await this.#start(saved,context.source.headSha);
      await d.repo.mainPipeline();
      const basis = await d.repo.pipelineAt(context.source.baseSha ?? context.source.headSha);
      if (basis.pipelineSha !== context.source.pipelineSha) throw new Error('재실행 파이프라인 SHA가 원본과 다릅니다.');
      await this.#observe(basis);
      let check:TaskCheckResult|IntegrationCheck;
      if (context.source.stage === 'task') {
        const id = `ci-${randomUUID()}`; await d.repo.createTaskCheckWorktree(id,context.source.headSha);
        try { check = await runTaskCheck({ ...d,execute,basis,worktreeId:id,branch:`agent/${id}`,signal }); }
        finally { await d.repo.removeWorktree(id); }
      } else check = await runIntegrationCheck({ ...d,execute,signal },basis,context.source.headSha,context.source.stage);
      const ciRunId = await this.#check(saved,check);
      await this.#finish(saved,check.status === 'pass' ? 'done' : 'failed');
      return { job,result:null,ciRunId };
    }
    const qa = saved.context?.verification, branch = saved.context?.branch;
    if (!qa || !branch || !saved.context?.taskKey) throw new Error('통합할 QA·브랜치가 없습니다.');
    const deps:IntegrationDeps = { ...d,execute,directory:join(d.directory,'merge'),signal,
      observeMainPipeline:basis => this.#observe(basis),readVerification:async () => {
        const latest = (await d.api('getCiJob',{ epoch:saved.epoch,params:{ id:job.id },query:{ fence:job.fence } })).body;
        return latest.verification ? { ...latest.verification,passed:latest.runnable && latest.verification.passed } : { passed:false,headSha:qa.headSha,specRevision:qa.specRevision };
      },onCheck:async (check,headSync) => {
        const ciRunId = await this.#check(saved,check);
        if (check.stage === 'int' && check.status === 'pass' && 'treeSha' in check) await this.#queueReport(saved,'checking',{
          baseSha:check.baseSha,syncedHeadSha:check.headSha,ciRunId,testedTreeSha:check.treeSha,...(headSync && { headSync }) });
      } };
    this.#queue = await IntegrationQueue.open(deps);
    let result = saved.result?.kind === 'merged' ? saved.result : await this.#queue.reconcile();
    if (!result) {
      if (!context.runnable) throw new Error('임대가 끝난 CI는 새 명령을 실행하지 않습니다. 병합 기록을 대조하세요.');
      await this.#start(saved,qa.headSha);
      if (saved.events[`${saved.round}:queue:queued`]) {
        // 병합 journal 전 중단은 같은 키로 이전 보고를 대조한 뒤 대기열을 제거하고 다시 검사한다.
        await this.#queueReport(saved,'queued');
        if (saved.events[`${saved.round}:queue:checking`]) await this.#queueReport(saved,'checking');
        await this.#queueReport(saved,'removed');
      }
      do {
        signal.throwIfAborted(); saved.round++; await this.#save();
        await this.#queueReport(saved,'queued');
        result = await this.#queue.run({ pr:job.payload.pr,branch,qaHeadSha:qa.headSha,specRevision:qa.specRevision });
        if (result.kind === 'recheck' && ['main_changed','merge_rejected'].includes(result.reason)) {
          await this.#queueReport(saved,'removed',this.#evidence(saved,result));
          if (await this.#queue.reconcile()) await this.#queue.acknowledge();
          result = null;
        }
      } while (!result);
    }
    saved.result = result; await this.#save();
    const evidence = this.#evidence(saved,result);
    if (result.kind === 'merged') {
      saved.completion = { jobId:job.id,fence:job.fence,pr:job.payload.pr,taskKey:saved.context.taskKey,qaHeadSha:qa.headSha,
        status:'merged',...evidence,actualMergeSha:result.actualMergeSha,actualTreeSha:result.actualTreeSha,mergeParents:result.mergeParents,mergedAt:new Date().toISOString() };
      await this.#save();
      try { await this.#queueReport(saved,'merged',saved.completion); }
      catch (error) {
        if (retryable(error)) { await d.outbox.flush(); return { job,result,completion:saved.completion }; }
        if (!(error instanceof ApiError) || error.error?.details?.event !== 'GATE_UNMET_AFTER_MERGE') throw error;
      }
      if (await this.#queue.reconcile()) await this.#queue.acknowledge();
      const completion = saved.completion;
      await this.#clear();
      return { job,result,completion };
    }
    if (result.kind === 'verify_failed') {
      await d.repo.fetch();
      const parents = await d.repo.commitParents(result.actualMergeSha);
      if (parents.length === 2) await this.#queueReport(saved,'merged',{ ...evidence,actualMergeSha:result.actualMergeSha,
        actualTreeSha:await d.repo.commitTree(result.actualMergeSha),mergeParents:parents,mergedAt:new Date().toISOString() });
    }
    if (result.kind === 'unknown' || result.kind === 'verify_failed' || result.kind === 'blocked') {
      d.warn('병합 결과를 확정하지 못해 CI 작업 기록을 보존합니다.'); return { job,result };
    }
    await this.#queueReport(saved,result.kind === 'rework' || result.kind === 'baseline_failed' ? 'failed' : 'removed',evidence);
    if (result.kind === 'recheck') await this.#finish(saved,'done');
    else await this.#clear();
    return { job,result };
  }

  #evidence(saved:Saved,result:IntegrationResult):Partial<QueueBody> {
    return { ...('baseSha' in result && result.baseSha && { baseSha:result.baseSha }),
      ...('syncedHeadSha' in result && result.syncedHeadSha && { syncedHeadSha:result.syncedHeadSha }),
      ...('headSync' in result && result.headSync && { headSync:result.headSync }),
      ...('integration' in result && result.integration && { ciRunId:saved.runs[checkKey(result.integration)],testedTreeSha:result.integration.treeSha }),
      ...(!('integration' in result) && 'task' in result && result.task && { ciRunId:saved.runs[checkKey(result.task)] }) };
  }

  async #start(saved:Saved,headSha:string):Promise<void> {
    await this.#send('start','startJob',{ epoch:saved.epoch,params:{ id:saved.job.id },body:{ fence:saved.job.fence,...this.#d.identity,headSha,installedSubagents:[] } });
    await this.#send('initial-slots','releaseJobSlots',{ epoch:saved.epoch,params:{ id:saved.job.id },body:{ fence:saved.job.fence,hostId:this.#d.identity.hostId,
      proof:{ kind:'no_process',bootId:this.#d.identity.bootId },at:new Date().toISOString() } });
  }
  async #finish(saved:Saved,status:'done'|'failed'):Promise<void> {
    await this.#send('finish','finishJob',{ epoch:saved.epoch,params:{ id:saved.job.id },body:{ fence:saved.job.fence,status } });
    const hold = (await this.#d.api('getCiJob',{ epoch:saved.epoch,params:{ id:saved.job.id },query:{ fence:saved.job.fence } })).body.hold;
    if (hold && (hold.slotState !== 'none' || hold.hostId !== this.#d.identity.hostId || hold.bootId !== this.#d.identity.bootId)) throw new Error('CI 프로세스 종료를 확인하지 못했습니다.');
    if (hold) await this.#send('release','releaseJob',{ epoch:saved.epoch,params:{ id:saved.job.id },body:{ fence:saved.job.fence,hostId:this.#d.identity.hostId,
      proof:hold.processGroup === null ? { kind:'no_process',bootId:this.#d.identity.bootId } : { kind:'group_empty',bootId:this.#d.identity.bootId,processGroup:hold.processGroup },at:new Date().toISOString() } });
    await this.#clear();
  }
  async #clear():Promise<void> { await this.#d.outbox.flush(); this.#saved = undefined; await this.#save(); }
  async shutdown():Promise<void> { this.#controller?.abort(); await this.#active?.catch(() => undefined); }
}
