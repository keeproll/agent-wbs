import { belowFloor, escalate, floorOf, gradeError, lower, roleOf } from './policy.ts';
import type {
  AttemptKind,
  Catalog,
  ExecPolicy,
  FloorTask,
  Grade,
  GradeError,
  GradeStep,
} from './policy.ts';

import type { AttemptStatus } from '../vocabulary.ts';

export interface PastAttempt extends Grade {
  kind: AttemptKind;
  status: AttemptStatus;
}

export interface ResolveInput {
  kind: AttemptKind;
  /** 이 시도의 역할에 대해 Task에 저장된 등급 */
  taskGrade: Grade & { locked: boolean };
  task: FloorTask;
  /** 이 Task의 이전 시도. 오래된 것부터. */
  history: readonly PastAttempt[];
  catalog: Catalog;
  policy: ExecPolicy;
  /** 남은 사용량(%). 미보고는 null. */
  remainPct: number | null;
}

/** 판정 결과. 저장·API의 `adjust`(GradeAdjust)로는 api/adapters.ts가 바꾼다. */
export interface ResolvedAdjust {
  /** `regrade` = 재개하되 직전 등급을 쓸 수 없어 재판단한 등급을 씀 */
  kind: 'none' | 'resume' | 'regrade' | 'keep' | 'up' | 'down';
  from: Grade;
  steps: GradeStep[];
  /** 상향하려 했으나 더 올릴 등급이 없었음 */
  alreadyTop: boolean;
  /**
   * 직전 시도 등급을 쓸 수 없어 재판단된 Task 등급으로 대체한 기록(G §7.2, owner 2026-11-25 아이템 3).
   * 호출자는 이 값을 이력에 남긴다.
   */
  replaced: { grade: Grade; reason: GradeError } | null;
}

export type ResolveResult =
  | {
      ok: true;
      grade: Grade;
      adjust: ResolvedAdjust;
      /** 최상위 등급 재작업 알림. 알리지 않으면 null. */
      notify: { count: number } | null;
    }
  | { ok: false; code: 'USAGE_EXHAUSTED' | 'BELOW_FLOOR' | 'FLOOR_UNDETERMINED' | 'PREVIOUS_DEV_MISSING' | GradeError };

/** 시도를 시작할 때 쓸 등급을 정한다(G §7.3, §6.5). 정책의 단일 출처다(§9.3-3). */
export function resolveRunGrade(input: ResolveInput): ResolveResult {
  const { kind, taskGrade, catalog, policy, remainPct } = input;
  const role = roleOf(kind);

  // 사용량 0%는 정책과 무관하게 대기한다.
  if (remainPct !== null && remainPct <= 0) return { ok: false, code: 'USAGE_EXHAUSTED' };

  const taskError = gradeError(catalog, taskGrade);
  const stored: Grade = { modelId: taskGrade.modelId, effort: taskGrade.effort };
  const prev = input.history.findLast((a) => roleOf(a.kind) === role);

  let base = stored;
  let replaced: ResolvedAdjust['replaced'] = null;
  const resuming = prev?.status === 'interrupted' && prev.kind === kind;
  if (kind === 'rework' && !prev) return { ok: false, code: 'PREVIOUS_DEV_MISSING' };
  if (prev && (resuming || kind === 'rework')) {
    const grade = { modelId: prev.modelId, effort: prev.effort };
    const reason = gradeError(catalog, grade);
    if (reason === null) base = grade;
    // 재개의 등급 대체는 허용 해제일 때만 한다(D-29). 그 외에는 같은 등급을 쓸 수 있을 때까지 거절한다.
    else if (resuming && reason !== 'MODEL_NOT_ALLOWED') return { ok: false, code: reason };
    else replaced = { grade, reason };
  }
  if (base === stored && taskError) return { ok: false, code: taskError };

  const adjust: ResolvedAdjust = { kind: 'none', from: base, steps: [], alreadyTop: false, replaced };

  // 중단 후 재개는 항상 같은 등급 — 하향도 하지 않는다.
  if (resuming && !replaced) return { ok: true, grade: base, adjust: { ...adjust, kind: 'resume' }, notify: null };

  const floor = floorOf(role, input.task, policy.floors);
  // 최저선은 조정을 마친 최종 후보에 적용한다. 미달이면 올리지 않고 Planning 재판단 대상으로 거부한다.
  const finish = (grade: Grade, adjusted: ResolvedAdjust, notify: { count: number } | null): ResolveResult => {
    // 팀장 고정은 최저선 예외지만, 재판단 재개의 새 등급에는 예외를 두지 않는다.
    const locked = taskGrade.locked && !resuming;
    const below = belowFloor(catalog.agent, { ...grade, locked }, floor);
    if (below === null) return { ok: false, code: 'FLOOR_UNDETERMINED' };
    if (below) return { ok: false, code: 'BELOW_FLOOR' };
    return { ok: true, grade, adjust: adjusted, notify };
  };

  // 재판단한 등급은 새 등급이라 최저선을 확인하되, 재개이므로 상향·하향은 하지 않는다.
  if (resuming) return finish(base, { ...adjust, kind: 'regrade' }, null);

  if (kind === 'rework' && policy.onRework !== 'same') {
    let grade = base;
    const steps: GradeStep[] = [];
    const limit = policy.onRework === 'top' ? Infinity : 1;
    while (steps.length < limit) {
      const up = escalate(catalog, grade);
      if (!up) break;
      grade = up.grade;
      steps.push(up.step);
    }
    const alreadyTop = steps.length === 0;
    let notify: { count: number } | null = null;
    if ((alreadyTop || policy.onRework === 'top') && policy.notifyAt > 0) {
      const count =
        input.history.filter(
          (a) => a.kind === 'rework' && a.modelId === grade.modelId && a.effort === grade.effort,
        ).length + 1;
      if (count >= policy.notifyAt) notify = { count };
    }
    return finish(grade, { ...adjust, kind: 'up', steps, alreadyTop }, notify);
  }

  if (
    policy.onUsage === 'down' &&
    remainPct !== null &&
    remainPct < policy.lowPct &&
    !taskGrade.locked &&
    floor
  ) {
    const down = lower(catalog, base, floor);
    if (down) return finish(down.grade, { ...adjust, kind: 'down', steps: [down.step] }, null);
  }
  return finish(base, { ...adjust, kind: kind === 'rework' ? 'keep' : 'none' }, null);
}
