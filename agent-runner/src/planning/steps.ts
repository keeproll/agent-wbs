import type { ClaimedJob } from '../api/generated/client.ts';
import { PlanningCheckpointError } from './checkpoint.ts';
import { PlanningReportFailed, PlanningStopped } from './reporter.ts';
import { JobRun, type PlanningOutcome } from './run.ts';

/*
 * 단계 실행기: 초기 분석·차이 분석을 단계별로 진행하고 서버에 진행을 보고한다(POST /runner/bootstrap/:jobId/progress).
 *
 * 다시 이어 하기(resume) 규칙
 * 1. 서버가 준 재개 단계(resumeStep)부터 실행하고, 그 앞 단계는 다시 보고하지 않는다. 서버에서 이미 「완료」이기 때문이다.
 * 2. 앞 단계 중 Agent 단계의 결과가 이 PC 진행 기록에 없으면(다른 PC, 기록 삭제) 가장 이른 그 단계부터 다시 실행·보고한다.
 *    결과 없이 뒤 단계를 하면 근거 없는 초안·CP가 나온다.
 * 3. 앞 단계 중 작업 공간 단계는 보고 없이 다시 마련한다(ensure). 예: 읽기 전용 입력 사본은 이 PC에 있어야 분석할 수 있다.
 *    원격 쓰기가 있는 repo 단계는 ensure가 없어 다시 하지 않는다.
 * 4. 단계가 실패하면 그 단계를 fail로 보고하고 멈춘다. 서버가 job을 실패로 두고, 팀장의 「다시 시도」가 그 단계부터 잇는 새 job을 만든다.
 */

export interface Step {
  key: string;
  label: string;
  kind: 'workspace' | 'agent';
  /** 단계를 실행하고 완료 메모를 돌려준다. null이면 완료 보고를 Runner가 하지 않는다(초안은 서버가 등록 때 완료로 바꾼다). */
  run: () => Promise<string | null>;
  /** 재개 시 앞 단계 결과를 보고 없이 다시 마련한다. */
  ensure?: () => Promise<void>;
  /** Agent 단계: 이 회차의 결과가 진행 기록에 있는가 */
  saved?: () => boolean;
}

type Stepped = Extract<ClaimedJob, { kind: 'bootstrap' | 'input_diff' }>;

export function startIndex(steps: readonly Step[], resumeStep: string | null): number | null {
  if (resumeStep === null) return 0;
  const index = steps.findIndex((s) => s.key === resumeStep);
  if (index < 0) return null;
  const missing = steps.slice(0, index).findIndex((s) => s.kind === 'agent' && !s.saved?.());
  return missing < 0 ? index : missing;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 단계를 차례로 실행한다. `after`는 특정 단계가 끝난 뒤 이어서 할 일(예: 기술 결정 제안)이다. 실패하면 그 단계 실패로 본다. */
export async function runSteps(run: JobRun<Stepped>, steps: readonly Step[], hooks: { after?: Record<string, () => Promise<void>>; stopAfter?: string } = {}): Promise<PlanningOutcome | null> {
  const start = startIndex(steps, run.job.payload.resumeStep);
  if (start === null) {
    return { status: 'failed', error: { code: 'INVALID_RESUME_STEP', message: `Runner가 이어 할 수 없는 단계입니다: ${String(run.job.payload.resumeStep)}` } };
  }
  const report = (step: Step, status: 'run' | 'done' | 'fail', note?: string) =>
    run.reporter.send('reportBootstrapProgress', `progress:${step.key}:${status}`, {
      params: { jobId: run.job.id },
      body: { fence: run.job.fence, stepKey: step.key as never, status, at: run.iso(), ...(note !== undefined && { note }) },
    }, { to: { params: { jobId: run.job.id } } });
  let current: Step | undefined;
  try {
    for (const step of steps.slice(0, start)) {
      current = step;
      await step.ensure?.();
    }
    for (const step of steps.slice(start)) {
      current = step;
      await report(step, 'run');
      const note = await step.run();
      if (note !== null) await report(step, 'done', run.note(note));
      await hooks.after?.[step.key]?.();
      if (hooks.stopAfter === step.key) break;
    }
    return null;
  } catch (error) {
    if (error instanceof PlanningStopped) throw error;
    if (!current) throw error;
    // VERSION_CONFLICT: 이 job의 판단 전제(기술 결정 버전·WBS 스냅샷)가 지금 서버 값과 다르다(서버 후속 4).
    // 같은 키로 다시 보내지 않고 단계 실패로 남긴다. 팀장의 「다시 시도」는 서버가 새 스냅샷·새 runNo로 job을 다시 만든다.
    const stale = error instanceof PlanningReportFailed && error.code === 'VERSION_CONFLICT';
    const message = run.note(stale
      ? `${current.label} 실패: 분석하는 동안 기술 결정이나 WBS가 바뀌어 서버가 받지 않았습니다(VERSION_CONFLICT). 다시 시도하면 새 내용으로 다시 분석합니다.`
      : `${current.label} 실패: ${messageOf(error)}`);
    try { await report(current, 'fail', message); }
    catch (reportError) { if (reportError instanceof PlanningStopped) throw reportError; }
    // 진행 기록 손상(예: 보낸 본문이 판단한 내용과 다름)은 단계 실패로 보고하되 결과 코드로 원인을 남긴다.
    const corrupt = error instanceof PlanningCheckpointError;
    return { status: 'failed', error: { code: stale ? 'VERSION_CONFLICT' : corrupt ? 'CHECKPOINT_UNREADABLE' : 'PLANNING_STEP_FAILED', message } };
  }
}
