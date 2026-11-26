import type { ClaimedJob } from '../api/generated/client.ts';
import { runBootstrap, runNoOf } from './bootstrap.ts';
import { PlanningCheckpointError } from './checkpoint.ts';
import { runInputDiff } from './input-diff.ts';
import { PlanningReportFailed, PlanningStopped } from './reporter.ts';
import { extra, JobRun, PlanningAgentFailed, type PlanningContext, type PlanningOutcome } from './run.ts';
import { runEstimate, runPlanning, runSplit } from './tasks.ts';

export type { PlanningContext, PlanningOutcome, PlanningWorkspace } from './run.ts';
export type { PlanningAgent, PlanningAgents } from './agents.ts';
export { PlanningCheckpoints } from './checkpoint.ts';

/** 이 폴더가 실행하는 job 종류 */
export const PLANNING_KINDS = ['bootstrap', 'input_diff', 'planning', 'estimate', 'split'] as const;
export type PlanningJob = Extract<ClaimedJob, { kind: (typeof PLANNING_KINDS)[number] }>;

/**
 * Planning job 하나를 끝까지 실행한다. 임대·시작·종료(claim·start·renew·finish)는 job 계층(M5-05 src/jobs)의 일이다.
 * 돌려준 결과를 job 계층이 `POST /runner/jobs/:id/finish`로 보낸다.
 * - done·failed: `{status, result | error}`를 그대로 finish 본문에 쓴다.
 * - lost: 임대 상실·초기화 번호 변경·인증 거부. 서버가 이 job의 보고를 받지 않으므로 finish도 보내지 않는다.
 */
export async function runPlanningJob(job: PlanningJob, ctx: PlanningContext): Promise<PlanningOutcome> {
  try {
    const stepped = job.kind === 'bootstrap' || job.kind === 'input_diff';
    // 다시 시도·기술 결정 확정·재분석은 같은 Planning 작업에 새 Runner job을 만든다. 진행 기록은 Planning 작업 단위로 이어 쓴다.
    const planningJobId = stepped ? extra(job.payload, 'planningJobId') : undefined;
    const workKey = stepped ? `${job.kind}:${typeof planningJobId === 'string' ? planningJobId : job.payload.commit}` : `${job.kind}:${job.id}`;
    const checkpoint = await ctx.checkpoints.load(workKey, stepped ? runNoOf(job.payload) : 1);
    // 입력 사본 이름: 차이 분석은 입력 버전, 초기 분석은 Planning 작업 기준
    const version = extra(job.payload, 'version');
    const inputName = job.kind === 'input_diff' && typeof version === 'number' ? `v${String(version)}` : `planning-${workKey.replaceAll(/[^A-Za-z0-9-]/g, '-')}`;
    switch (job.kind) {
      case 'bootstrap': return await runBootstrap(new JobRun(job, ctx, checkpoint), inputName);
      case 'input_diff': return await runInputDiff(new JobRun(job, ctx, checkpoint), inputName);
      case 'planning': return await runPlanning(new JobRun(job, ctx, checkpoint));
      case 'estimate': return await runEstimate(new JobRun(job, ctx, checkpoint));
      case 'split': return await runSplit(new JobRun(job, ctx, checkpoint));
    }
  } catch (error) {
    if (error instanceof PlanningStopped) return { status: 'lost', code: error.code, message: error.message };
    if (error instanceof PlanningAgentFailed) return { status: 'failed', error: { code: 'PLANNING_AGENT_FAILED', message: error.message } };
    if (error instanceof PlanningReportFailed) return { status: 'failed', error: { code: error.code, message: error.message } };
    if (error instanceof PlanningCheckpointError) return { status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE', message: error.message } };
    return { status: 'failed', error: { code: 'PLANNING_FAILED', message: error instanceof Error ? error.message : String(error) } };
  }
}
