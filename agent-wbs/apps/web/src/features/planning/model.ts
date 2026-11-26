/**
 * Planning 화면의 표시 계산. 원본 plStep(P L5704)·planOps(P L5692)·makeCpFromPlan(P L5718)·rps(P L5966) 그대로다.
 * 「이견을 고르지 않으면 CP를 만들 수 없다」 같은 최종 판정은 서버(POST /api/plannings/:id/proposals)가 한다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';

export type Planning = ResponseOf<'listPlannings'>['items'][number];
export type PlanningReview = Planning['reviews'][number];
export type ReplanItem = ResponseOf<'listReplans'>['items'][number];

/**
 * 원본은 kind가 agree/diff이고, 서버(M2 sessions.ts)는 「이견」을 고르지 않은 이견으로 본다. 계약은 문자열(Text)이라 값이 정해져 있지 않다.
 * 그래서 두 철자를 모두 이견으로 읽는다(보고서 「확인 필요」).
 */
export const isDiff = (kind: string) => kind === 'diff' || kind === '이견';

/** 최종 제안에 들어갈 변경. 이견은 고른 쪽, 그 밖(일치·보류)은 공통 변경. 서버 chosenOps와 같다. */
export function planOps(reviews: readonly PlanningReview[]): PlanningReview['ops'] {
  return reviews.flatMap((rv) => {
    if (rv.choice === 'codex') return rv.codexOps;
    if (rv.choice === 'claude') return rv.claudeOps;
    if (isDiff(rv.kind) && rv.choice === null) return [];
    return rv.ops;
  });
}

export const openCount = (reviews: readonly PlanningReview[]) => reviews.filter((rv) => isDiff(rv.kind) && !rv.choice).length;

const STEPS = ['Codex 독립 분석', 'Claude 독립 분석', '교차 검토', '이견 식별 · 조정', 'Change Proposal 작성', '팀장 승인', '승인된 WBS 반영'];

/** cpStatus: 이 세션으로 만든 최근 CP의 상태(없으면 null) */
export function planStep(reviews: readonly PlanningReview[], cpStatus: string | null) {
  let step: number;
  if (openCount(reviews)) step = 4;
  else if (cpStatus === null || cpStatus === 'rejected') step = 5;
  else if (['draft', 'review', 'changes', 'held'].includes(cpStatus)) step = 6;
  else if (cpStatus === 'approved') step = 7;
  else step = 8;
  return {
    steps: STEPS.map((l, i) => ({ n: String(i + 1), l, cls: i + 1 < step ? 'done' : i + 1 === step ? 'cur' : '' })),
    label: step === 8 ? '완료 — WBS 반영됨' : cpStatus === 'rejected' ? '제안 반려 — 재조정' : `${String(step)}단계 · ${STEPS[step - 1] ?? ''}`,
  };
}

const CHOICE: Record<string, string> = { codex: 'Codex 안', claude: 'Claude 안', hold: '변경 없음' };
/** CP 사유(원본 makeCpFromPlan: 「Planning PLN-001 교차 검토 결과 — …」). M3 통합: 서버 후속 2차의 표시 키 planningKey를 쓴다. */
export function cpReason(planningKey: string, reviews: readonly PlanningReview[]): string {
  return `Planning ${planningKey} 교차 검토 결과 — ${reviews.map((rv) => `${rv.topic}: ${!isDiff(rv.kind) ? '일치' : (CHOICE[rv.choice ?? ''] ?? '미조정')}${rv.memo ? ` (${rv.memo})` : ''}`).join(' / ')}`;
}

const md = (date: string | null) => (date ? date.slice(5, 10) : '—');
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const MOVE: Record<string, [string, string]> = {
  delayed: ['밀림', 'sc sc-bad'], advanced: ['당겨짐', 'sc sc-ok'], new: ['신규', 'sc sc-none'], excluded: ['제외', 'sc sc-none'],
};

/** 재조정 기록 행. 목록은 최신순이라 바로 뒤(더 오래된) 기록이 「이전 기준」이다. */
export function replanRows(items: readonly ReplanItem[]) {
  return items.map((r, i) => {
    const prev = items[i + 1];
    const dl = prev ? days(prev.projectEnd, r.projectEnd) : null;
    const pending = String(r.status) === 'pending';
    return {
      id: r.replanId, at: r.at, trigger: r.trigger, by: r.actor, pending, discarded: String(r.status) === 'discarded',
      v: r.baselineVersion === null ? '반영 대기' : `기준 v${String(r.baselineVersion)}`,
      endL: `${prev ? `${md(prev.projectEnd)} → ` : ''}${md(r.projectEnd)}`,
      rangeL: `${md(r.range.lo)} ~ ${md(r.range.hi)}`,
      rateL: r.rate ? `${String(Math.round(r.rate * 100))}%` : '—',
      dL: dl === null ? '초기' : dl > 0 ? `+${String(dl)}일 밀림` : dl < 0 ? `${String(-dl)}일 당겨짐` : '변동 없음',
      dC: dl === null || dl === 0 ? 'sc sc-none' : dl > 0 ? 'sc sc-bad' : 'sc sc-ok',
      n: `${String(r.moved.length)}건`,
      moved: r.moved.map((m) => {
        const [kind, kindC] = MOVE[String(m.kind)] ?? [String(m.kind), 'sc sc-none'];
        return {
          task: m.taskKey, kind, kindC, before: md(m.before), after: md(m.after),
          delta: m.deltaDays === null ? '—' : `${m.deltaDays > 0 ? '+' : ''}${String(m.deltaDays)}일`,
        };
      }),
    };
  });
}
