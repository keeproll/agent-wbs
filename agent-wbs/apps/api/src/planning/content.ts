import { createHash } from 'node:crypto';
import type { DesignKind, TechDomain } from '@awbs/shared';
import type { WireProposalOp } from '@awbs/shared/api';
import { canonicalJson, type JudgedSource } from '../tasks/hash.ts';

/**
 * 판단 대상 지문(subjectHash)과 미리보기 지문(previewHash) 계산에 쓰는 순수 함수들.
 * 지문 규칙은 M2-02의 tasks/hash.ts(canonicalJson·judgedContent)를 그대로 공유한다.
 */

type AddTask = Extract<WireProposalOp, { op: 'add' }>['t'];

/** P DOMAIN_TO_DESIGN: 기술 영역마다 권장하는 설계 구역 */
const DOMAIN_TO_DESIGN: Partial<Record<TechDomain, DesignKind>> = { DB: 'DB', BE: 'API', API: 'API', FE: 'FE', DevOps: 'DevOps' };

/** P newTask의 빈 설계 구역 내용 */
export const emptyDesignContent = () => ({ ents: [], b: {} });

/** CP add의 `design`을 생략했을 때의 구역(P recKinds). 명시한 `[]`는 구역 없음이다(data-model §2.4-1). */
export function designsOf(t: AddTask): { kind: DesignKind; content: Record<string, unknown> }[] {
  if (t.design !== undefined) return t.design.map(({ kind, content }) => ({ kind, content: { ...content } }));
  const kinds = [t.domain, ...(t.rel ?? [])].flatMap((domain) => DOMAIN_TO_DESIGN[domain] ?? []);
  return [...new Set(kinds)].map((kind) => ({ kind, content: emptyDesignContent() }));
}

/**
 * CP가 추가하는 Task의 `JudgedSource`. 반영 때 DB에 쓰는 값과 같은 규칙으로 만든다.
 * `conflictGroup`은 생략 규칙(분할 상속)을 적용한 뒤의 값을 받는다. 산출물은 CP로 만들 수 없어 비어 있다.
 */
export function newTaskSource(t: AddTask, conflictGroup: string | null): JudgedSource {
  return {
    title: t.title,
    overview: { purpose: t.purpose, background: '', scope: [...(t.scope ?? [])], out: [], precond: '', doneCond: t.doneCond },
    spec: { files: [...(t.files ?? [])] },
    ac: (t.ac ?? []).map(({ given, when, then, method }) => ({ given, when, then, method: method ?? '' })),
    outputs: [],
    designs: designsOf(t),
    conflictGroup,
  };
}

/** 판단 job과 분할 hash에 쓰는 ops: 판단 기록(`t.judgedRules`)만 뺀다(data-model §2.3-1 자기 참조 방지). */
export function stripJudgements(ops: readonly WireProposalOp[]): WireProposalOp[] {
  return ops.map((op) => {
    if (op.op !== 'add' || !('judgedRules' in op.t)) return op;
    const { judgedRules, ...t } = op.t as AddTask & { judgedRules?: unknown };
    void judgedRules;
    return { ...op, t };
  });
}

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** 분할 CP의 판단 대상 = 판단을 뺀 ops 전체 + 대상 Task의 현재 JudgedContent(contracts §3.2 splitSubjectHash) */
export function splitSubjectHash(ops: readonly WireProposalOp[], splitTasks: readonly { taskKey: string; content: unknown }[]): string {
  return sha256({ ops: stripJudgements(ops), splitTasks });
}

/** 팀장이 본 미리보기의 지문. 승인·반영 때 다시 계산해 같아야 한다(contracts §1.3). */
export function previewHash(simulation: { idMap: unknown; issues: unknown; diff: unknown; impact: unknown }, holdReasons: unknown): string {
  const { idMap, issues, diff, impact } = simulation;
  return sha256({ idMap, issues, diff, impact, holdReasons });
}

/** CP와 판단 대상 hash 조합마다 열린 판단 job은 하나다(contracts §2.1 [결정]). 대상 순서와 무관하다. */
export function judgementJobKey(proposalId: string, targets: readonly { target: string; subjectHash: string }[], splitHash: string | null): string {
  const combo = [...targets].map(({ target, subjectHash }) => [target, subjectHash]).sort(([a], [b]) => ((a ?? '') < (b ?? '') ? -1 : 1));
  return `cp-judgement:${proposalId}:${sha256({ combo, splitHash })}`;
}
