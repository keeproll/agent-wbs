import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { HeadSyncChainProof } from '../../git/repository.ts';
import type { GitHubClient, MergeOutcome } from '../../github/client.ts';
import { atomicWrite } from '../../state/files.ts';
import { acquireLock } from '../../state/state.ts';
import { runTaskCheck, type TaskCheckOptions, type TaskCheckResult } from '../task.ts';
import { runIntegrationCheck, type IntegrationCheck, type MainBasis } from './check.ts';
import { diagnoseBatch, type BatchDiagnostic } from './batch.ts';

export interface IntegrationRequest { pr: number; branch: string; qaHeadSha: string; specRevision: number }
export interface IntegrationDeps extends Pick<TaskCheckOptions, 'repo' | 'heavy' | 'execute' | 'collectTests' | 'redact' | 'signal'> {
  directory: string;
  github: Pick<GitHubClient, 'getPullRequest' | 'mainSha' | 'setCommitStatus' | 'mergePullRequest' | 'reconcileMerge'>;
  readVerification: (request: IntegrationRequest) => Promise<{ passed: boolean; headSha: string; specRevision: number }>;
  /** 서버가 (project,A)의 정의 관측을 따로 보관하도록 기존 outbox에 넣는다. */
  observeMainPipeline: (basis: MainBasis) => Promise<void>;
  /** ①·②의 실제 결과를 병합 PUT 전에 서버에 남긴다. */
  onCheck?: (result: TaskCheckResult | IntegrationCheck, proof?: HeadSyncChainProof) => Promise<void>;
}
interface SyncEvidence {
  baseSha: string; qaHeadSha: string; syncedHeadSha: string; pipelineSha: string; headSync?: HeadSyncChainProof;
}
interface Evidence extends SyncEvidence {
  pr: number; branch: string; testedTreeSha: string; task: TaskCheckResult; integration: IntegrationCheck;
}
export type IntegrationResult =
  | ({ kind: 'merged'; actualMergeSha: string; actualTreeSha: string; mergeParents: [string, string] } & Evidence)
  | ({ kind: 'unknown'; observed: string } & Evidence)
  | ({ kind: 'verify_failed'; actualMergeSha: string; reason: string } & Evidence)
  | { kind: 'blocked' }
  | ({ kind: 'baseline_failed'; failScope: 'baseline'; task: TaskCheckResult } & SyncEvidence)
  | ({ kind: 'recheck'; reason: 'main_changed' | 'head_changed' | 'qa_changed' | 'merge_rejected'; task?: TaskCheckResult; integration?: IntegrationCheck } & Partial<SyncEvidence>)
  | ({ kind: 'rework'; reason: 'conflict' | 'invalid_sync' | 'task_failed' | 'integration_failed'; failScope?: 'task'; task?: TaskCheckResult; integration?: IntegrationCheck } & Partial<SyncEvidence>);
interface Journal { version: 1; evidence: Evidence; outcome?: MergeOutcome }
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function validOutcome(outcome: MergeOutcome): boolean {
  if (!outcome || typeof outcome !== 'object') return false;
  switch (outcome.kind) {
    case 'merged': return SHA.test(outcome.mergeSha) && SHA.test(outcome.treeSha);
    case 'verify_failed': return SHA.test(outcome.mergeSha) && typeof outcome.reason === 'string';
    case 'unknown': return ['open', 'closed', 'read_failed'].includes(outcome.observed);
    case 'rejected': return outcome.status === 405 && typeof outcome.message === 'string';
    case 'head_changed': return outcome.status === 409 && typeof outcome.message === 'string';
    default: return false;
  }
}

/** 서버 대기열 순서로 호출한다. 파일 잠금은 다른 Runner의 중복 병합을 막는다. */
export class IntegrationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly deps: IntegrationDeps;
  private readonly lock: FileHandle;
  private journal: Journal | null;
  private constructor(deps: IntegrationDeps, lock: FileHandle, journal: Journal | null) {
    this.deps = deps; this.lock = lock; this.journal = journal;
  }

  static async open(deps: IntegrationDeps): Promise<IntegrationQueue> {
    await mkdir(deps.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(deps.directory)).isDirectory()) throw new Error('병합 기록 폴더가 올바르지 않습니다.');
    const lock = await acquireLock(deps.directory);
    try {
      let journal: Journal | null = null;
      try {
        const path = join(deps.directory, 'merge.json');
        if (!(await lstat(path)).isFile()) throw new Error('병합 기록은 일반 파일이어야 합니다.');
        journal = JSON.parse(await readFile(path, 'utf8')) as Journal | null;
        if (journal !== null) {
          const e = journal.evidence;
          if (journal.version !== 1 || !e || !Number.isSafeInteger(e.pr) || e.pr < 1 || !/^agent\/[\w.-]+$/.test(e.branch) ||
            ![e.baseSha, e.qaHeadSha, e.syncedHeadSha, e.testedTreeSha, e.pipelineSha].every(s => typeof s === 'string' && SHA.test(s)) ||
            !e.task || e.task.status !== 'pass' || e.task.baseSha !== e.baseSha || e.task.headSha !== e.syncedHeadSha || e.task.pipelineSha !== e.pipelineSha ||
            !e.integration || e.integration.status !== 'pass' || e.integration.baseSha !== e.baseSha || e.integration.headSha !== e.syncedHeadSha ||
            e.integration.treeSha !== e.testedTreeSha || e.integration.pipelineSha !== e.pipelineSha || journal.outcome && !validOutcome(journal.outcome)) {
            throw new Error('병합 기록이 손상되었습니다. 원본을 보존하고 확인하세요.');
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return new IntegrationQueue(deps, lock, journal);
    } catch (error) { await lock.close(); throw error; }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => { if (this.closed) throw new Error('닫힌 병합 대기열입니다.'); return action(); });
    this.tail = next.catch(() => undefined); return next;
  }

  private async save(journal: Journal | null): Promise<void> {
    await atomicWrite(this.deps.directory, 'merge.json', JSON.stringify(journal)); this.journal = journal;
  }

  private async current(request: IntegrationRequest, baseSha: string, expectedHead: string): Promise<Extract<IntegrationResult, { kind: 'recheck' }> | null> {
    const { github, repo, readVerification } = this.deps;
    const qa = await readVerification(request);
    if (!qa.passed || qa.headSha !== request.qaHeadSha || qa.specRevision !== request.specRevision) return { kind: 'recheck', reason: 'qa_changed' };
    const pull = await github.getPullRequest(request.pr);
    if (pull.state !== 'open' || pull.merged || pull.branch !== request.branch || pull.headSha !== expectedHead ||
      await repo.fetchBranch(request.branch) !== expectedHead) return { kind: 'recheck', reason: 'head_changed' };
    if (await github.mainSha() !== baseSha || (await repo.mainPipeline()).baseSha !== baseSha) return { kind: 'recheck', reason: 'main_changed' };
    return null;
  }

  private validateRequest(request: IntegrationRequest): void {
    if (!Number.isSafeInteger(request.pr) || request.pr < 1 || !/^agent\/[\w.-]+$/.test(request.branch) ||
      !SHA.test(request.qaHeadSha) || !Number.isSafeInteger(request.specRevision) || request.specRevision < 0) throw new Error('통합 대상이 올바르지 않습니다.');
  }

  run(request: IntegrationRequest): Promise<IntegrationResult> {
    return this.serial(async () => {
      if (this.journal) return { kind: 'blocked' };
      this.validateRequest(request);
      const { repo, github, signal } = this.deps; signal?.throwIfAborted();
      const basis = await repo.mainPipeline();
      await this.deps.observeMainPipeline(basis);
      const head = await repo.fetchBranch(request.branch);
      const previousProof = await repo.integrationChainProof(basis.baseSha, request.qaHeadSha, head);
      if (head !== request.qaHeadSha && !previousProof) return { kind: 'recheck', reason: 'head_changed' };
      const previous: SyncEvidence = { baseSha: basis.baseSha, qaHeadSha: request.qaHeadSha, syncedHeadSha: head,
        pipelineSha: basis.pipelineSha, ...(previousProof && { headSync: previousProof }) };
      const stale = await this.current(request, basis.baseSha, head); if (stale) return { ...stale, ...previous };
      const syncedHeadSha = await repo.prepareIntegration(basis.baseSha, head);
      if (!syncedHeadSha) return { kind: 'rework', reason: 'conflict', ...previous };
      const proof = await repo.integrationChainProof(basis.baseSha, request.qaHeadSha, syncedHeadSha);
      if (syncedHeadSha !== request.qaHeadSha && !proof) return { kind: 'rework', reason: 'invalid_sync', ...previous };
      const moved = await this.current(request, basis.baseSha, head); if (moved) return { ...moved, ...previous };
      if (syncedHeadSha !== head) {
        try { await repo.pushCommit(syncedHeadSha, request.branch); }
        catch (error) {
          const changed = await this.current(request, basis.baseSha, head);
          if (changed) return { ...changed, ...previous };
          throw error;
        }
      }
      const sync: SyncEvidence = { ...previous, syncedHeadSha, ...(proof && { headSync: proof }) };
      await github.setCommitStatus({ sha: syncedHeadSha, context: 'agentwbs/int', state: 'pending' });
      const id = `ci-${randomUUID()}`;
      let task: TaskCheckResult;
      await repo.createTaskCheckWorktree(id, syncedHeadSha);
      try { task = await runTaskCheck({ ...this.deps, basis, worktreeId: id, branch: `agent/${id}` }); }
      finally { await repo.removeWorktree(id); }
      await this.deps.onCheck?.(task,proof ?? undefined);
      const taskChanged = await this.current(request, basis.baseSha, syncedHeadSha); if (taskChanged) return { ...taskChanged, ...sync, task };
      await github.setCommitStatus({ sha: syncedHeadSha, context: 'agentwbs/task',
        state: task.status === 'pass' ? 'success' : task.failScope === 'baseline' ? 'error' : 'failure' });
      if (task.status !== 'pass') {
        await github.setCommitStatus({ sha: syncedHeadSha, context: 'agentwbs/int', state: task.failScope === 'baseline' ? 'error' : 'failure' });
        return task.failScope === 'baseline' ? { kind: 'baseline_failed', failScope: 'baseline', ...sync, task }
          : { kind: 'rework', reason: 'task_failed', failScope: 'task', ...sync, task };
      }
      const integration = await runIntegrationCheck(this.deps, basis, syncedHeadSha);
      await this.deps.onCheck?.(integration,proof ?? undefined);
      const changed = await this.current(request, basis.baseSha, syncedHeadSha); if (changed) return { ...changed, ...sync, task, integration };
      await github.setCommitStatus({ sha: syncedHeadSha, context: 'agentwbs/int', state: integration.status === 'pass' ? 'success' : 'failure' });
      if (integration.status !== 'pass') return { kind: 'rework', reason: 'integration_failed', failScope: 'task', ...sync, task, integration };
      const finalCheck = await this.current(request, basis.baseSha, syncedHeadSha);
      if (finalCheck) {
        await github.setCommitStatus({ sha: syncedHeadSha, context: 'agentwbs/int', state: 'pending' });
        return { ...finalCheck, ...sync, task, integration };
      }
      signal?.throwIfAborted();
      const evidence: Evidence = { pr: request.pr, branch: request.branch, ...sync, testedTreeSha: integration.treeSha, task, integration };
      // 먼저 저장한다. 전송 직후 종료돼도 미전송으로 단정하지 않고 읽기만 해서 대조한다.
      await this.save({ version: 1, evidence });
      const outcome = await github.mergePullRequest({ pr: request.pr, baseSha: basis.baseSha, headSha: syncedHeadSha });
      await this.save({ version: 1, evidence, outcome });
      return this.result(evidence, outcome);
    });
  }

  private result(e: Evidence, outcome: MergeOutcome): IntegrationResult {
    if (outcome.kind === 'merged') return { ...e, kind: 'merged', actualMergeSha: outcome.mergeSha, actualTreeSha: outcome.treeSha, mergeParents: [e.baseSha, e.syncedHeadSha] };
    if (outcome.kind === 'unknown') return { ...e, kind: 'unknown', observed: outcome.observed };
    if (outcome.kind === 'verify_failed') return { ...e, kind: 'verify_failed', actualMergeSha: outcome.mergeSha, reason: outcome.reason };
    return { ...e, kind: 'recheck', reason: outcome.kind === 'head_changed' ? 'head_changed' : 'merge_rejected' };
  }

  reconcile(): Promise<IntegrationResult | null> {
    return this.serial(async () => {
      if (!this.journal) return null;
      const { evidence: e } = this.journal;
      if (this.journal.outcome && this.journal.outcome.kind !== 'unknown') return this.result(e, this.journal.outcome);
      const outcome = await this.deps.github.reconcileMerge({ pr: e.pr, baseSha: e.baseSha, headSha: e.syncedHeadSha });
      await this.save({ version: 1, evidence: e, outcome }); return this.result(e, outcome);
    });
  }

  checkBatch(requests: readonly IntegrationRequest[]): Promise<BatchDiagnostic | { kind: 'blocked' }> {
    return this.serial(async () => {
      if (this.journal) return { kind: 'blocked' };
      for (const request of requests) this.validateRequest(request);
      return diagnoseBatch(this.deps, requests);
    });
  }

  /** 서버 보고를 outbox에 영속 보관한 뒤 부른다. 미확정·대조 실패는 자동으로 넘기지 않는다. */
  acknowledge(): Promise<void> {
    return this.serial(async () => {
      if (!this.journal?.outcome || ['unknown', 'verify_failed'].includes(this.journal.outcome.kind)) throw new Error('병합 결과를 확정하지 못했습니다.');
      await this.save(null);
    });
  }

  async close(): Promise<void> {
    await this.tail; if (!this.closed) { this.closed = true; await this.lock.close(); }
  }
}
