import type { ClaimedJob } from '../api/generated/client.ts';
import { createRedactor } from '../security/redact.ts';
import { runBootstrap } from './bootstrap.ts';
import { PlanningCheckpointError, PlanningOutputInvalid } from './checkpoint.ts';
import { runInputDiff } from './input-diff.ts';
import { PlanningReportFailed, PlanningStopped } from './reporter.ts';
import { bootstrapPayload, inputDiffPayload, PlanningPayloadError } from './payload.ts';
import { JobRun, PlanningAgentFailed, type PlanningContext, type PlanningOutcome } from './run.ts';
import { runEstimate, runPlanning, runSplit } from './tasks.ts';

export type { PlanningContext, PlanningOutcome, PlanningWorkspace } from './run.ts';
export type { PlanningAgent, PlanningAgents } from './agents.ts';
export { PlanningCheckpoints, planningStateDirectory } from './checkpoint.ts';
export type { DecisionSnapshot, TechConstraint, WbsSnapshot } from './payload.ts';

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
  // 실패·상실 결과는 finish 본문과 서버 job 이력으로 나간다. 모든 반환을 이 한 경계에서 가린다(독립 리뷰 2).
  // 단계 메모는 run.note()가 이미 가리지만, Agent·일반 예외의 메시지는 여기서만 가려진다.
  const redact = createRedactor(ctx.secrets ?? []);
  return redact(await run(job, ctx));
}

async function run(job: PlanningJob, ctx: PlanningContext): Promise<PlanningOutcome> {
  try {
    switch (job.kind) {
      case 'bootstrap': {
        // 다시 시도·기술 결정 확정·재분석은 같은 Planning 작업에 새 Runner job을 만든다. 진행 기록은 Planning 작업 단위로 이어 쓴다.
        const payload = bootstrapPayload(job);
        return await runBootstrap(new JobRun(job, ctx, await ctx.checkpoints.load(ctx.epoch, payload.workKey, payload.runNo)), payload);
      }
      case 'input_diff': {
        const payload = inputDiffPayload(job);
        return await runInputDiff(new JobRun(job, ctx, await ctx.checkpoints.load(ctx.epoch, payload.workKey, payload.runNo)), payload);
      }
      case 'planning': return await runPlanning(new JobRun(job, ctx, await ctx.checkpoints.load(ctx.epoch, `planning:${job.id}`, 1)));
      case 'estimate': return await runEstimate(new JobRun(job, ctx, await ctx.checkpoints.load(ctx.epoch, `estimate:${job.id}`, 1)));
      case 'split': return await runSplit(new JobRun(job, ctx, await ctx.checkpoints.load(ctx.epoch, `split:${job.id}`, 1)));
    }
  } catch (error) {
    if (error instanceof PlanningStopped) return { status: 'lost', code: error.code, message: error.message };
    if (error instanceof PlanningPayloadError) return { status: 'failed', error: { code: 'UNSUPPORTED_PAYLOAD', message: error.message } };
    if (error instanceof PlanningAgentFailed || error instanceof PlanningOutputInvalid) return { status: 'failed', error: { code: 'PLANNING_AGENT_FAILED', message: error.message } };
    if (error instanceof PlanningReportFailed) return { status: 'failed', error: { code: error.code, message: error.message } };
    if (error instanceof PlanningCheckpointError) return { status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE', message: error.message } };
    return { status: 'failed', error: { code: 'PLANNING_FAILED', message: error instanceof Error ? error.message : String(error) } };
  }
}
