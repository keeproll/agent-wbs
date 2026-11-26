import type { ClaimedJob } from '../api/generated/client.ts';

/*
 * Planning job payload의 잠정 계약 — 계약 밖 값을 읽는 곳은 이 파일 하나다.
 *
 * 왜 따로 두나:
 * - 서버는 지금도 planningJobId·runNo·version과 Planning 세션 정보를 payload에 넣지만, 생성된 `ClaimedJob` 타입에는 없다.
 * - 서버 후속 4가 계약을 보완한다: bootstrap·input_diff의 planningJobId·runNo(·version) 필수,
 *   bootstrap의 techConstraints[{id,name,level,condition}]와 확정 결정 스냅샷, input_diff의 현재 WBS 스냅샷.
 * - 그 계약이 생성 타입(`src/api/generated/client.ts`)에 들어오면, 아래 `Provisional*` 타입과 `field()`를 지우고
 *   생성 타입을 그대로 쓰면 된다. 다른 파일은 `readPlanningPayload()` 결과만 쓰므로 고칠 필요가 없다.
 *
 * 필수 값(planningJobId·runNo·version)이 없으면 추측하지 않고 실패한다. 예전의 「커밋으로 대신 만든 작업 키」는 없앴다.
 * 왜: 같은 커밋으로 Planning 작업이 두 번 생기면(초기화 뒤 재등록 등) 서로의 기록을 이어 쓰게 된다.
 */

/** 등록 시점의 기술 제약. 조건부 선호(`cond`)마다 서버가 조건 충족 판단을 하나씩 요구한다(constraintId로 대조). */
export interface TechConstraint { id: string; name: string; level: 'must' | 'ban' | 'cond'; condition: string | null }
/**
 * 팀장이 확정한 기술 결정 스냅샷(필수·금지·승인·반려). 모양은 서버 후속 4 계약을 따른다.
 * Runner는 해석하지 않고 Agent에게 그대로 넘긴다(반려된 제안을 초안에 쓰지 않게 하는 근거).
 */
export type DecisionSnapshot = unknown;
/** 입력 버전을 고정한 시점의 현재 WBS(Task 키·상태·JudgedContent·지문·묶음·의존). 모양은 서버 후속 4 계약을 따른다. */
export type WbsSnapshot = unknown;

type Kind<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
interface ProvisionalBootstrap { planningJobId: string; runNo: number; techConstraints?: TechConstraint[]; decisions?: DecisionSnapshot }
interface ProvisionalInputDiff { planningJobId: string; runNo: number; version: number; wbs?: WbsSnapshot }
interface ProvisionalSession { planning?: { id: string; title: string; scope: string } }

export class PlanningPayloadError extends Error { override name = 'PlanningPayloadError'; }

/** 계약 밖 값 하나를 읽는다. 이 파일 밖에서 쓰지 않는다. */
function field(payload: object, name: string): unknown {
  return (payload as Record<string, unknown>)[name];
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

function constraints(value: unknown): TechConstraint[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new PlanningPayloadError('techConstraints는 목록이어야 합니다.');
  return value.map((c: unknown, i) => {
    const item = c as Partial<TechConstraint> | null;
    if (!item || !isId(item.id) || typeof item.name !== 'string' || !['must', 'ban', 'cond'].includes(String(item.level))
      || !(item.condition === null || typeof item.condition === 'string')) {
      throw new PlanningPayloadError(`techConstraints[${String(i)}] 형식이 올바르지 않습니다.`);
    }
    return { id: item.id, name: item.name, level: item.level as TechConstraint['level'], condition: item.condition };
  });
}

export interface SteppedPayload {
  planningJobId: string;
  runNo: number;
  /** 진행 기록의 작업 키 */
  workKey: string;
  /** 읽기 전용 입력 사본 이름 */
  inputName: string;
}
export type BootstrapPayload = Kind<'bootstrap'>['payload'] & SteppedPayload & { techConstraints?: TechConstraint[]; decisions?: DecisionSnapshot };
export type InputDiffPayload = Kind<'input_diff'>['payload'] & SteppedPayload & { version: number; wbs?: WbsSnapshot };

function stepped(job: Kind<'bootstrap'> | Kind<'input_diff'>): SteppedPayload {
  const raw = job.payload as typeof job.payload & Partial<ProvisionalBootstrap>;
  const planningJobId = field(raw, 'planningJobId');
  const runNo = field(raw, 'runNo');
  if (!isId(planningJobId)) throw new PlanningPayloadError(`${job.kind} 작업에 planningJobId가 없습니다.`);
  if (!isCount(runNo)) throw new PlanningPayloadError(`${job.kind} 작업에 올바른 runNo가 없습니다.`);
  return { planningJobId, runNo, workKey: `${job.kind}:${planningJobId}`, inputName: `planning-${planningJobId}` };
}

export function bootstrapPayload(job: Kind<'bootstrap'>): BootstrapPayload {
  const base = stepped(job);
  const techConstraints = constraints(field(job.payload, 'techConstraints'));
  const decisions = field(job.payload, 'decisions') as ProvisionalBootstrap['decisions'];
  return { ...job.payload, ...base, ...(techConstraints && { techConstraints }), ...(decisions !== undefined && { decisions }) };
}

export function inputDiffPayload(job: Kind<'input_diff'>): InputDiffPayload {
  const base = stepped(job);
  const version = field(job.payload, 'version');
  if (!isCount(version)) throw new PlanningPayloadError('input_diff 작업에 올바른 version이 없습니다.');
  const wbs = field(job.payload, 'wbs') as ProvisionalInputDiff['wbs'];
  return { ...job.payload, ...base, version, inputName: `v${String(version)}`, ...(wbs !== undefined && { wbs }) };
}

/** Planning 세션 job(서버 createPlanning). 세션 정보가 없으면 undefined(CP 판단 job이거나 처리할 것 없음). */
export function sessionOf(job: Kind<'planning'>): NonNullable<ProvisionalSession['planning']> | undefined {
  const session = field(job.payload, 'planning') as { id?: unknown; title?: unknown; scope?: unknown } | undefined;
  if (!session || !isId(session.id)) return undefined;
  return { id: session.id, title: String(session.title ?? ''), scope: String(session.scope ?? '') };
}
