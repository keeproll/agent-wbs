import { runIntegrationCheck, type IntegrationCheck } from './check.ts';
import type { IntegrationDeps, IntegrationRequest } from './queue.ts';

export interface BatchRun {
  prs: number[]; status: 'pass' | 'fail'; headSha: string | null; failStep: string | null; check?: IntegrationCheck;
}
export interface BatchDiagnostic { kind: 'diagnostic'; baseSha: string; pipelineSha: string; runs: BatchRun[]; suspects: number[] }

/** 예비 검사다. 실패한 묶음을 나누지만 개별 PR의 병합 근거로는 쓰지 않는다. */
export async function diagnoseBatch(deps: IntegrationDeps, requests: readonly IntegrationRequest[]): Promise<BatchDiagnostic> {
  if (requests.length < 2 || new Set(requests.map(r => r.pr)).size !== requests.length) throw new Error('서로 다른 PR을 두 개 이상 지정하세요.');
  const basis = await deps.repo.mainPipeline();
  await deps.observeMainPipeline(basis);
  const result: BatchDiagnostic = { kind: 'diagnostic', baseSha: basis.baseSha, pipelineSha: basis.pipelineSha, runs: [], suspects: [] };
  for (const request of requests) {
    const qa = await deps.readVerification(request);
    const pull = await deps.github.getPullRequest(request.pr);
    if (!qa.passed || qa.headSha !== request.qaHeadSha || qa.specRevision !== request.specRevision || pull.state !== 'open' ||
      pull.branch !== request.branch || pull.headSha !== request.qaHeadSha || await deps.repo.fetchBranch(request.branch) !== request.qaHeadSha) {
      throw new Error('묶음의 QA 또는 head가 바뀌었습니다. 다시 검증하세요.');
    }
  }
  const check = async (members: readonly IntegrationRequest[]): Promise<void> => {
    let head: string | null = basis.baseSha;
    for (const member of members) {
      head = await deps.repo.prepareIntegration(head, member.qaHeadSha);
      if (!head) break;
    }
    const run: BatchRun = { prs: members.map(r => r.pr), status: 'fail', headSha: head, failStep: 'conflict' };
    if (head) {
      run.check = await runIntegrationCheck(deps, basis, head);
      run.status = run.check.status; run.failStep = run.check.failStep;
    }
    result.runs.push(run);
    if (run.status === 'pass') return;
    if (members.length === 1) { result.suspects.push(...run.prs); return; }
    const middle = Math.ceil(members.length / 2);
    await check(members.slice(0, middle)); await check(members.slice(middle));
  };
  await check(requests);
  return result;
}
