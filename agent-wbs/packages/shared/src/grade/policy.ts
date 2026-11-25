import { effortLevel } from './effort.ts';
import type { AgentName, EffortLevel } from './effort.ts';

export interface Grade {
  modelId: string;
  /** CLI 값. 비교는 항상 공통 단계로 한다. */
  effort: string;
}

/** Runner가 보고한 모델. `efforts`는 그 모델에 대해 보고된 CLI 값. */
export interface CatalogModel {
  modelId: string;
  rank: number;
  allowed: boolean;
  efforts: readonly string[];
}

export interface Catalog {
  agent: AgentName;
  models: readonly CatalogModel[];
}

export interface ExecPolicy {
  onUsage: 'wait' | 'down';
  /** 남은 사용량이 이 값 미만이면 하향 */
  lowPct: number;
  onRework: 'same' | 'up1' | 'top';
  /** 최상위 등급 재작업 알림 횟수. 0 = 알리지 않음 */
  escNotify: number;
  floors: { verifyGeDev: boolean; dbHigh: boolean };
}

/** G §7.3 기본값. lowPct는 「낮춰서 진행」일 때만 쓰며 P 초기값(L3334)을 따른다. */
export const DEFAULT_EXEC_POLICY: ExecPolicy = {
  onUsage: 'wait',
  lowPct: 20,
  onRework: 'up1',
  escNotify: 2,
  floors: { verifyGeDev: true, dbHigh: true },
};

export type GradeRole = 'dev' | 'qa';
export type AttemptKind = 'dev' | 'rework' | 'qa' | 'reverify';

export const roleOf = (kind: AttemptKind): GradeRole =>
  kind === 'dev' || kind === 'rework' ? 'dev' : 'qa';

export type GradeError =
  | 'MODEL_UNKNOWN'
  | 'MODEL_NOT_ALLOWED'
  | 'EFFORT_UNMAPPED'
  | 'EFFORT_NOT_REPORTED';

interface UsableEffort {
  effort: string;
  level: EffortLevel;
}

/** 보고되었고 승인 매핑이 있는 Effort만, 낮은 단계부터. */
export function usableEfforts(catalog: Catalog, model: CatalogModel): UsableEffort[] {
  return [...new Set(model.efforts)]
    .flatMap((effort) => {
      const level = effortLevel(catalog.agent, model.modelId, effort);
      return level === null ? [] : [{ effort, level }];
    })
    .sort((a, b) => a.level - b.level);
}

/** 실행에 쓸 수 있는 등급인지. 문제가 없으면 null. */
export function gradeError(catalog: Catalog, grade: Grade): GradeError | null {
  const model = catalog.models.find((m) => m.modelId === grade.modelId);
  if (!model) return 'MODEL_UNKNOWN';
  if (!model.allowed) return 'MODEL_NOT_ALLOWED';
  if (effortLevel(catalog.agent, grade.modelId, grade.effort) === null) return 'EFFORT_UNMAPPED';
  if (!model.efforts.includes(grade.effort)) return 'EFFORT_NOT_REPORTED';
  return null;
}

// ── 최저선 ───────────────────────────────────────────

export type FloorReason = 'DB_HIGH' | 'VERIFY_GE_DEV';

export interface Floor {
  level: EffortLevel;
  reasons: FloorReason[];
}

export interface FloorTask {
  primaryDomain: string;
  relatedDomains: readonly string[];
  /** Task에 저장된 개발 등급의 공통 단계. 미매핑이면 null. */
  devLevel: EffortLevel | null;
}

/**
 * 최저선(G §7.3). 「검증 ≥ 개발」을 적용해야 하는데 개발 등급이 미매핑이면 판정할 수 없으므로 null.
 */
export function floorOf(
  role: GradeRole,
  task: FloorTask,
  floors: ExecPolicy['floors'],
): Floor | null {
  const out: Floor = { level: 1, reasons: [] };
  if (floors.dbHigh && (task.primaryDomain === 'DB' || task.relatedDomains.includes('DB'))) {
    out.level = 3;
    out.reasons.push('DB_HIGH');
  }
  if (role === 'qa' && floors.verifyGeDev) {
    if (task.devLevel === null) return null;
    if (task.devLevel > out.level) {
      out.level = task.devLevel;
      out.reasons.push('VERIFY_GE_DEV');
    }
  }
  return out;
}

/** Task 등급이 최저선 아래인지. 팀장 고정은 최저선 재판단 대상이 아니다(P `normRuns`). 판정 불가는 null. */
export function belowFloor(
  agent: AgentName,
  grade: Grade & { locked: boolean },
  floor: Floor | null,
): boolean | null {
  if (grade.locked) return false;
  const level = effortLevel(agent, grade.modelId, grade.effort);
  if (level === null || floor === null) return null;
  return level < floor.level;
}

// ── 상향 · 하향 ──────────────────────────────────────

export type GradeStep =
  | { kind: 'effort'; from: string; to: string }
  | { kind: 'model'; from: string; to: string };

/**
 * 한 단계 상향. Effort가 최상위면 허용 모델 중 한 단계 위 모델로, 공통 단계는 유지한다(P `escalate`).
 * 같은 공통 단계를 쓸 수 없는 모델은 건너뛴다. 더 올릴 등급이 없으면 null.
 */
export function escalate(catalog: Catalog, grade: Grade): { grade: Grade; step: GradeStep } | null {
  const model = catalog.models.find((m) => m.modelId === grade.modelId);
  const level = effortLevel(catalog.agent, grade.modelId, grade.effort);
  if (!model || level === null) return null;

  const next = usableEfforts(catalog, model).find((e) => e.level > level);
  if (next) {
    return {
      grade: { modelId: model.modelId, effort: next.effort },
      step: { kind: 'effort', from: grade.effort, to: next.effort },
    };
  }
  const higher = catalog.models
    .filter((m) => m.allowed && m.rank > model.rank)
    .sort((a, b) => a.rank - b.rank);
  for (const m of higher) {
    const same = usableEfforts(catalog, m).find((e) => e.level === level);
    if (same) {
      return {
        grade: { modelId: m.modelId, effort: same.effort },
        step: { kind: 'model', from: model.modelId, to: m.modelId },
      };
    }
  }
  return null;
}

/** 사용량 절약 하향 — Effort 한 단계. 최저선 아래이거나 더 낮출 단계가 없으면 null. */
export function lower(
  catalog: Catalog,
  grade: Grade,
  floor: Floor,
): { grade: Grade; step: GradeStep } | null {
  const model = catalog.models.find((m) => m.modelId === grade.modelId);
  const level = effortLevel(catalog.agent, grade.modelId, grade.effort);
  if (!model || level === null) return null;
  const prev = usableEfforts(catalog, model).findLast((e) => e.level < level);
  if (!prev || prev.level < floor.level) return null;
  return {
    grade: { modelId: model.modelId, effort: prev.effort },
    step: { kind: 'effort', from: grade.effort, to: prev.effort },
  };
}
