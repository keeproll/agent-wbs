import type { Confidence } from '../api/generated/client.ts';
import type { AgentName, CpRule, EstimateVerdict, RuleVerdict, SplitRule, SplitVerdict } from './agents.ts';

/*
 * 두 Agent(Claude·Codex)의 독립 판단을 하나의 기록으로 합친다.
 *
 * 규칙: 두 Agent가 같은 결론을 냈을 때만 기록한다.
 * - 왜: 판단 기록은 「합의 주체가 둘 다」일 때만 유효하다(data-model §2.3-1). 한쪽 결론을 합의처럼 적으면,
 *   실제로 합의하지 않은 분할이 승인을 통과한다.
 * - 결론이 다르거나, 한쪽이 답하지 않았거나, 근거가 비었거나, 같은 규칙을 두 번 답했으면 기록하지 않는다.
 *   기록이 없으면 서버가 「기록 없음(JUDGEMENT_MISSING)」으로 승인을 보류하고 팀장 화면에 보인다.
 * - 기록하지 않은 이유는 `disagreements`로 돌려준다. job 종료 결과에 남겨 무엇이 왜 빠졌는지 추적한다.
 */

export const AGENTS = ['Claude', 'Codex'] as const satisfies readonly AgentName[];

type Result = 'met' | 'not_met';
export interface Disagreement<R extends string = string> {
  target: string;
  rule: R;
  /** disagree: 결론이 다름 · missing: 한쪽 답 없음 · blank_basis: 근거 없음 · ambiguous: 같은 규칙을 두 번 답함 · invalid: 결론·근거의 형식이 틀림 */
  reason: 'disagree' | 'missing' | 'blank_basis' | 'ambiguous' | 'invalid';
  results?: Partial<Record<AgentName, Result>>;
}
export interface JudgementMeta {
  judgedAt: string;
  sourceRef: string;
  /** 기존 대상의 재판단은 작업 payload의 hash를 그대로 돌려보낸다. 새 대상은 서버가 계산하므로 생략한다. */
  subjectHash?: (target: string) => string;
}
export interface Item<R extends string> { rule: R; result: Result; agreedBy: AgentName[]; basis: string; judgedAt: string; sourceRef: string; subjectHash?: string }
export interface Record_<R extends string> { schemaVersion: 1; items: Item<R>[] }

function agreeOne<R extends string>(target: string, rule: R, answers: Record<AgentName, { result: Result; basis: string }[]>, meta: JudgementMeta):
  { item: Item<R> } | { disagreement: Disagreement<R> } {
  const picked = {} as Record<AgentName, { result: Result; basis: string }>;
  for (const agent of AGENTS) {
    const found = answers[agent];
    if (found.length === 0) return { disagreement: { target, rule, reason: 'missing' } };
    if (found.length > 1) return { disagreement: { target, rule, reason: 'ambiguous' } };
    const [only] = found as [{ result: unknown; basis: unknown }];
    // Agent 출력은 바깥 값이다. 형식이 틀리면 합의 재료로 쓰지 않는다(독립 리뷰 5와 같은 경계).
    if ((only.result !== 'met' && only.result !== 'not_met') || typeof only.basis !== 'string') return { disagreement: { target, rule, reason: 'invalid' } };
    if (!only.basis.trim()) return { disagreement: { target, rule, reason: 'blank_basis' } };
    picked[agent] = only as { result: Result; basis: string };
  }
  if (picked.Claude.result !== picked.Codex.result) {
    return { disagreement: { target, rule, reason: 'disagree', results: { Claude: picked.Claude.result, Codex: picked.Codex.result } } };
  }
  const item: Item<R> = {
    rule, result: picked.Claude.result, agreedBy: [...AGENTS],
    basis: AGENTS.map((agent) => `${agent}: ${picked[agent].basis.trim()}`).join('\n'),
    judgedAt: meta.judgedAt, sourceRef: meta.sourceRef,
  };
  if (meta.subjectHash) item.subjectHash = meta.subjectHash(target);
  return { item };
}

/** 대상별 규칙 5·7·9 판단 기록. 대상 목록에 없는 답은 버린다. */
export function agreeJudgements(targets: readonly string[], rules: readonly SplitRule[], verdicts: Record<AgentName, RuleVerdict[]>, meta: JudgementMeta) {
  const records = new Map<string, Record_<SplitRule>>();
  const disagreements: Disagreement<SplitRule>[] = [];
  for (const target of targets) {
    const items: Item<SplitRule>[] = [];
    for (const rule of rules) {
      const answers = Object.fromEntries(AGENTS.map((agent) => [agent, verdicts[agent].filter((v) => v.target === target && v.rule === rule)])) as Record<AgentName, RuleVerdict[]>;
      const one = agreeOne(target, rule, answers, meta);
      if ('item' in one) items.push(one.item);
      else disagreements.push(one.disagreement);
    }
    records.set(target, { schemaVersion: 1, items });
  }
  return { records, disagreements };
}

/** 분할 CP 하나의 판단 기록(D-34). 대상은 CP 전체라서 target은 `split`이다. */
export function agreeSplitJudgements(rules: readonly CpRule[], verdicts: Record<AgentName, SplitVerdict[]>, meta: JudgementMeta) {
  const items: Item<CpRule>[] = [];
  const disagreements: Disagreement<CpRule>[] = [];
  for (const rule of rules) {
    const answers = Object.fromEntries(AGENTS.map((agent) => [agent, verdicts[agent].filter((v) => v.rule === rule)])) as Record<AgentName, SplitVerdict[]>;
    const one = agreeOne('split', rule, answers, meta);
    if ('item' in one) items.push(one.item);
    else disagreements.push(one.disagreement);
  }
  return { record: { schemaVersion: 1 as const, items }, disagreements };
}

const CONFIDENCE: Confidence[] = ['하', '중', '상'];
export interface AgreedEstimate extends EstimateVerdict { agreedBy: AgentName[] }

/**
 * 두 Agent의 독립 추정을 합친다. 계획 문서에 합치는 공식이 없어 Runner가 정한 규칙이다(보고서에 적음).
 * - 범위(낙관·비관)는 두 추정을 모두 담는 넓은 쪽: 한 Agent라도 그만큼 걸릴 수 있다고 봤기 때문이다.
 * - 예상은 두 값의 평균(0.1시간 단위 반올림), 신뢰도는 낮은 쪽, 토큰은 큰 쪽.
 * 한쪽 추정이 없거나 형식이 틀리면 합의할 수 없으므로 오류다(단독 추정을 합의로 적지 않는다).
 */
export function agreeEstimates(refs: readonly string[], verdicts: Record<AgentName, EstimateVerdict[]>): AgreedEstimate[] {
  return refs.map((ref) => {
    const pair = AGENTS.map((agent) => {
      const found = verdicts[agent].filter((v) => v.ref === ref);
      if (found.length !== 1) throw new Error(`${agent}의 ${ref} 추정이 ${found.length ? '두 개 이상' : '없'}습니다.`);
      const [v] = found as [EstimateVerdict];
      // Agent 출력은 바깥 값이다. 형식이 틀린 값을 「낮은 신뢰도」 같은 정상 값으로 바꾸지 않고 오류로 멈춘다(독립 리뷰 5).
      // 실제 CLI 출력 파서(M5-01)가 같은 검사를 하더라도 합의 경계에서 다시 막는다.
      const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
      if (![v.estHours, v.loHours, v.hiHours].every(finite) || (v.tokensK !== undefined && !(finite(v.tokensK) && v.tokensK >= 0))) {
        throw new Error(`${agent}의 ${ref} 추정 시간·토큰이 유한한 수가 아닙니다.`);
      }
      if (!CONFIDENCE.includes(v.confidence)) throw new Error(`${agent}의 ${ref} 추정 신뢰도가 하·중·상이 아닙니다: ${String(v.confidence)}`);
      if (typeof v.basis !== 'string') throw new Error(`${agent}의 ${ref} 추정 근거가 문자열이 아닙니다.`);
      if (!(v.loHours > 0 && v.loHours <= v.estHours && v.estHours <= v.hiHours)) throw new Error(`${agent}의 ${ref} 추정은 낙관 ≤ 예상 ≤ 비관이어야 합니다.`);
      if (!v.basis.trim()) throw new Error(`${agent}의 ${ref} 추정 근거가 비었습니다.`);
      return v;
    }) as [EstimateVerdict, EstimateVerdict];
    const [a, b] = pair;
    const tokens = pair.flatMap((v) => (v.tokensK === undefined ? [] : [v.tokensK]));
    const loHours = Math.min(a.loHours, b.loHours);
    const hiHours = Math.max(a.hiHours, b.hiHours);
    const estHours = Math.min(hiHours, Math.max(loHours, Math.round(((a.estHours + b.estHours) / 2) * 10) / 10));
    return {
      ref, estHours, loHours, hiHours, ...(tokens.length && { tokensK: Math.max(...tokens) }),
      confidence: CONFIDENCE[Math.min(CONFIDENCE.indexOf(a.confidence), CONFIDENCE.indexOf(b.confidence))] as Confidence,
      basis: AGENTS.map((agent, i) => `${agent}: ${pair[i]?.basis.trim() ?? ''}`).join('\n'),
      agreedBy: [...AGENTS],
    };
  });
}
