import {
  belowFloor, floorOf, gradeError, modelRanks, placeModel, roleOf,
  type Agent, type Catalog, type ExecPolicy, type Grade, type ModelSettings, type ResolveResult, type TaskStatus,
} from '@awbs/shared';
import type { FieldError } from '../changes/http.ts';

/**
 * 실행 정책·모델 설정의 순수 규칙(G§7.1~7.3, D-29). DB를 모르는 함수만 둔다.
 * 분담(G§7.1): 팀장은 허용 모델·순서·최저선·조정 정책을 정하고, Task별 등급은 Planning Agent가 판단하며,
 * 실행 직전 최종 등급은 서버의 run-grade가 계산한다(§9.3-3 단일 출처).
 */

export const AGENTS: readonly Agent[] = ['Claude', 'Codex'];
const TERMINAL: readonly TaskStatus[] = ['done', 'cancelled'];

/** agent_models 한 행(보고값 + 팀장 허용). efforts는 Runner가 보고한 CLI 값, 미확인이면 null. */
export interface ModelRow { agent: Agent; modelId: string; label: string; allowed: boolean; isNew: boolean; efforts: readonly string[] | null }

export interface ModelPut {
  models: readonly { agent: Agent; id: string; allowed: boolean }[];
  rankOrder?: Record<Agent, readonly string[]> | undefined;
  codexFamilyOrder?: readonly string[] | undefined;
  claudeModels?: readonly string[] | undefined;
}

export const modelKey = (agent: string, modelId: string) => `${agent}|${modelId}`;

/** 순서 설정에 없는 보고 모델을 규칙대로 끼워 넣은 순서(data-model §6.2). 팀장이 정한 자리는 건드리지 않는다. */
export function completeOrder(settings: ModelSettings, rows: readonly ModelRow[]): ModelSettings['rankOrder'] {
  const out = { ...settings.rankOrder } as Record<Agent, string[]>;
  for (const agent of AGENTS) {
    let order = [...(settings.rankOrder[agent] ?? [])];
    for (const row of rows.filter((r) => r.agent === agent)) order = placeModel(order, row.modelId, agent, settings.codexFamilyOrder);
    out[agent] = order;
  }
  return out;
}

export function ranksOf(order: ModelSettings['rankOrder']): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const agent of AGENTS) for (const [id, rank] of modelRanks(order[agent] ?? [])) ranks.set(modelKey(agent, id), rank);
  return ranks;
}

export interface ModelPlan {
  errors: FieldError[];
  settings: ModelSettings;
  rows: ModelRow[];
  ranks: Map<string, number>;
  /** 이번 요청으로 허용 → 해제된 모델 */
  disallowed: { agent: Agent; modelId: string }[];
}

/**
 * 모델 설정 저장 계획. 입력 오류가 있으면 errors에 담고, 없으면 바뀐 행·순서·rank를 돌려준다.
 * - 보고된 모델만 허용을 바꿀 수 있다(모델 ID를 코드에 두지 않는다, G§9.3-1).
 * - 팀장이 손댄 모델은 「신규 보고」 표시를 끈다(P L6214).
 * - 허용 모델이 있던 Agent는 0개가 될 수 없다(G§7.2 「Agent마다 허용 모델은 최소 1개」).
 */
export function planModelChange(current: readonly ModelRow[], settings: ModelSettings, put: ModelPut): ModelPlan {
  const errors: FieldError[] = [];
  const rows = current.map((row) => ({ ...row }));
  const seen = new Set<string>();
  put.models.forEach((item, index) => {
    const key = modelKey(item.agent, item.id);
    if (seen.has(key)) { errors.push({ path: `models.${String(index)}`, rule: 'unique', message: '같은 모델을 두 번 보냈습니다.' }); return; }
    seen.add(key);
    const row = rows.find((r) => r.agent === item.agent && r.modelId === item.id);
    if (!row) { errors.push({ path: `models.${String(index)}.id`, rule: 'exists', message: 'Runner가 보고하지 않은 모델입니다.' }); return; }
    if (row.allowed !== item.allowed || row.isNew) Object.assign(row, { allowed: item.allowed, isNew: false });
  });
  for (const agent of AGENTS) {
    const before = current.filter((r) => r.agent === agent && r.allowed).length;
    const after = rows.filter((r) => r.agent === agent && r.allowed).length;
    if (before > 0 && after === 0) errors.push({ path: 'models', rule: 'minAllowed', message: `${agent}은(는) 허용 모델이 최소 1개 있어야 합니다.` });
  }
  const next: ModelSettings = {
    rankOrder: put.rankOrder ?? settings.rankOrder,
    codexFamilyOrder: put.codexFamilyOrder ?? settings.codexFamilyOrder,
    claudeModels: put.claudeModels ?? settings.claudeModels,
  };
  const complete = { ...next, rankOrder: completeOrder(next, rows) };
  const disallowed = current.filter((r) => r.allowed && rows.some((n) => n.agent === r.agent && n.modelId === r.modelId && !n.allowed))
    .map((r) => ({ agent: r.agent, modelId: r.modelId }));
  return { errors, settings: complete, rows, ranks: ranksOf(complete.rankOrder), disallowed };
}

/** 등급 판정에 쓰는 카탈로그(M1-06 `Catalog`). rank는 서버 설정 순서에서 계산한 값이다. */
export function catalogOf(agent: Agent, rows: readonly ModelRow[], ranks: ReadonlyMap<string, number>): Catalog {
  return {
    agent,
    models: rows.filter((r) => r.agent === agent).map((r) => ({
      modelId: r.modelId, rank: ranks.get(modelKey(agent, r.modelId)) ?? 0, allowed: r.allowed, efforts: r.efforts ?? [],
    })),
  };
}

/** Task에 저장된 역할별 등급(task_grades) 한 행과 최저선 판정에 필요한 Task 정보. */
export interface GradeRow {
  taskId: string; taskKey: string; status: TaskStatus; role: 'dev' | 'qa'; agent: Agent; modelId: string; effort: string; locked: boolean;
  primaryDomain: string; relatedDomains: readonly string[];
  /** 같은 Task 개발 등급의 공통 단계(「검증 ≥ 개발」 판정). 미매핑이면 null. */
  devLevel: 1 | 2 | 3 | 4 | 5 | null;
}

export type RejudgeReason = 'MODEL_NOT_ALLOWED' | 'BELOW_FLOOR';
export interface Rejudge { taskId: string; taskKey: string; role: 'dev' | 'qa'; grade: Grade; locked: boolean; reason: RejudgeReason }

/**
 * Planning Agent가 다시 판단해야 하는 등급(P `normRuns` L4181, G§7.2).
 * - 허용 해제된 모델을 쓰는 등급: 팀장 고정 Task도 포함한다(「고정 Task 포함, 이력 남김」).
 * - 최저선 아래로 떨어진 등급: 팀장 고정은 최저선 예외라 제외한다(G§7.3).
 * - 완료·취소 Task는 바꾸지 않는다(완료 결과 보존).
 */
export function gradesToRejudge(grades: readonly GradeRow[], catalogs: Readonly<Record<Agent, Catalog>>, floors: ExecPolicy['floors']): Rejudge[] {
  const out: Rejudge[] = [];
  for (const g of grades) {
    if (TERMINAL.includes(g.status)) continue;
    const grade = { modelId: g.modelId, effort: g.effort };
    const base = { taskId: g.taskId, taskKey: g.taskKey, role: g.role, grade, locked: g.locked };
    if (gradeError(catalogs[g.agent], grade) === 'MODEL_NOT_ALLOWED') { out.push({ ...base, reason: 'MODEL_NOT_ALLOWED' }); continue; }
    const floor = floorOf(roleOf(g.role), { primaryDomain: g.primaryDomain, relatedDomains: g.relatedDomains, devLevel: g.devLevel }, floors);
    if (belowFloor(g.agent, { ...grade, locked: g.locked }, floor) === true) out.push({ ...base, reason: 'BELOW_FLOOR' });
  }
  return out;
}

export const gradeText = (grade: Grade) => `${grade.modelId} · ${grade.effort}`;

/**
 * D-29: 재개할 때 등급이 재판단된 경우의 이력 한 줄. 재판단이 아니면 null(같은 등급 재개는 등급 이력을 남기지 않는다).
 * 「이전→이후 등급·사유를 이력에 기록」(architecture D-29)을 그대로 담는다.
 */
export function resumeRegradeEntry(taskKey: string, result: Extract<ResolveResult, { ok: true }>) {
  const replaced = result.adjust.replaced;
  if (result.adjust.kind !== 'regrade' || !replaced) return null;
  return {
    kind: '실행 등급',
    text: `${taskKey} 재개 등급 재판단 — 중단 시도의 모델(${replaced.grade.modelId})이 허용 해제되어 재판단한 등급으로 재개`,
    before: { modelId: replaced.grade.modelId, effort: replaced.grade.effort },
    after: { modelId: result.grade.modelId, effort: result.grade.effort },
    ref: { taskKey, adjust: 'regrade', reason: replaced.reason },
  };
}
