import type { ClaimedJob } from '../api/generated/client.ts';

/*
 * Planning job payload 읽기 — 서버 후속 4 계약(srv4 REPORT.md 「Runner가 맞춰야 할 계약」)을 생성 타입 그대로 쓴다.
 *
 * - bootstrap·input_diff: planningJobId·runNo·version 필수(생성 타입에서 필수). 진행 기록 작업 키는 planningJobId로 만든다.
 * - bootstrap: techConstraints[{id,name,level,condition}], techDecisions[{id,tdKey,title,status,authority,updatedAt,content}],
 *   techDecisionVersion(결정 목록 SHA-256), subagentDefs[{id,defKey,version,agent,role}]
 * - input_diff·split: wbs{phases,tasks,dependencies} 스냅샷
 * - planning: planning(세션)·proposal(CP 판단)·tasks(기존 Task 재판단) 셋 중 하나
 *
 * 계약 밖 값을 읽는 코드는 없다(예전 `extra()`·`field()`와 커밋 대체 키는 없앴다).
 * 그래도 서버와 Runner를 따로 배포하는 동안 옛 job이 올 수 있어, 필수 값이 비었으면 추측하지 않고 실패한다(REPORT 「옛 job은 재발급」).
 */

type Kind<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
export type BootJob = Kind<'bootstrap'>;
export type DiffJob = Kind<'input_diff'>;
export type TechConstraint = BootJob['payload']['techConstraints'][number];
export type TechDecision = BootJob['payload']['techDecisions'][number];
export type SubagentDef = BootJob['payload']['subagentDefs'][number];
export type WbsSnapshot = DiffJob['payload']['wbs'];
/** 초안 작성자에게 넘기는 확정 결정 묶음. 반려(rejected)는 사용 기술로 쓰면 안 된다는 설명을 함께 넘긴다. */
export interface DecisionSnapshot { version: string; decisions: TechDecision[]; rejected: string[] }

export class PlanningPayloadError extends Error { override name = 'PlanningPayloadError'; }

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const HASH = /^[0-9a-f]{64}$/;

export interface SteppedPayload { workKey: string; inputName: string }
export type BootstrapPayload = BootJob['payload'] & SteppedPayload & { decisionSnapshot: DecisionSnapshot };
export type InputDiffPayload = DiffJob['payload'] & SteppedPayload;

function stepped(job: BootJob | DiffJob): SteppedPayload {
  const { planningJobId, runNo, version } = job.payload;
  if (!isId(planningJobId)) throw new PlanningPayloadError(`${job.kind} 작업에 planningJobId가 없습니다.`);
  if (!isCount(runNo)) throw new PlanningPayloadError(`${job.kind} 작업에 올바른 runNo가 없습니다.`);
  if (!isCount(version)) throw new PlanningPayloadError(`${job.kind} 작업에 올바른 version이 없습니다.`);
  return { workKey: `${job.kind}:${planningJobId}`, inputName: job.kind === 'input_diff' ? `v${String(version)}` : `planning-${planningJobId}` };
}

function wbsProblem(wbs: unknown): string | null {
  const w = wbs as Partial<WbsSnapshot> | null | undefined;
  if (!w || !Array.isArray(w.phases) || !Array.isArray(w.tasks) || !Array.isArray(w.dependencies)) return 'wbs 스냅샷(phases·tasks·dependencies)이 없습니다';
  for (const t of w.tasks) if (!t || !isId(t.taskKey) || !isId(t.wp) || typeof t.subjectHash !== 'string' || !HASH.test(t.subjectHash)) return 'wbs.tasks 형식이 다릅니다';
  return null;
}

export function bootstrapPayload(job: BootJob): BootstrapPayload {
  const base = stepped(job);
  const p = job.payload;
  if (!Array.isArray(p.techConstraints) || !Array.isArray(p.techDecisions) || !Array.isArray(p.subagentDefs)) {
    throw new PlanningPayloadError('bootstrap 작업에 techConstraints·techDecisions·subagentDefs가 없습니다.');
  }
  if (typeof p.techDecisionVersion !== 'string' || !HASH.test(p.techDecisionVersion)) throw new PlanningPayloadError('bootstrap 작업에 techDecisionVersion이 없습니다.');
  for (const [i, c] of p.techConstraints.entries()) {
    if (!isId(c.id) || typeof c.name !== 'string' || !['must', 'ban', 'cond'].includes(c.level) || !(c.condition === null || typeof c.condition === 'string')) {
      throw new PlanningPayloadError(`techConstraints[${String(i)}] 형식이 올바르지 않습니다.`);
    }
  }
  const decisionSnapshot = {
    version: p.techDecisionVersion,
    decisions: p.techDecisions,
    rejected: p.techDecisions.filter((d) => d.status === 'rejected').map((d) => d.tdKey),
  };
  return { ...p, ...base, decisionSnapshot };
}

export function inputDiffPayload(job: DiffJob): InputDiffPayload {
  const base = stepped(job);
  const problem = wbsProblem(job.payload.wbs);
  if (problem) throw new PlanningPayloadError(`input_diff 작업: ${problem}.`);
  return { ...job.payload, ...base };
}

export function splitWbs(job: Kind<'split'>): WbsSnapshot {
  const problem = wbsProblem(job.payload.wbs);
  if (problem) throw new PlanningPayloadError(`split 작업: ${problem}.`);
  return job.payload.wbs;
}

export type PlanningMode =
  | { mode: 'proposal'; proposal: NonNullable<Kind<'planning'>['payload']['proposal']> }
  | { mode: 'session'; session: { id: string; title: string; scope: string } }
  | { mode: 'tasks' };

/** planning job의 세 입력 중 무엇인지(계약 5). 하나도 없으면 정상 작업이 아니다. */
export function planningMode(job: Kind<'planning'>): PlanningMode | null {
  const { proposal, planning, tasks } = job.payload as { proposal: unknown; planning?: unknown; tasks: unknown[] };
  if (proposal) return { mode: 'proposal', proposal: proposal as NonNullable<Kind<'planning'>['payload']['proposal']> };
  const session = planning as { id?: unknown; title?: unknown; scope?: unknown } | null | undefined;
  if (session && isId(session.id)) return { mode: 'session', session: { id: session.id, title: String(session.title ?? ''), scope: String(session.scope ?? '') } };
  if (tasks.length > 0) return { mode: 'tasks' };
  return null;
}
