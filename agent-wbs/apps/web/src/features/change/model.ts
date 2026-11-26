/**
 * 변경 제안(CP) 화면의 표시 계산 — 서버가 준 값을 원본 화면 문구로 바꾸기만 한다(판정은 서버 evaluate()가 한다).
 * 원본 근거: CPST P L4455, FIELD_L P L4454, opText P L5642, diffRows P L5651, impactRows P L5668.
 *
 * 주의: 계약의 열거값(AnyOf)은 TypeScript에서 `string | number`라 `op.op === 'add'`로 타입이 좁혀지지 않는다
 * (shared/README §8). 그래서 읽을 때만 느슨한 모양(LooseOp)으로 본다.
 */
import type { HoldReason, Impact, Proposal, ProposalOp, DiffEntry } from './types.ts';

export interface TaskInfo { title: string; status: string }

/** 원본 LBL.status(P L2912)의 이름·색 클래스 */
export const TASK_STATUS: Record<string, { l: string; c: string }> = {
  planning: { l: '계획 중', c: 's-plan' }, approval: { l: '승인 대기', c: 's-appr' }, ready: { l: '실행 대기', c: 's-ready' },
  running: { l: '실행 중', c: 's-run' }, qa: { l: 'QA 진행', c: 's-qa' }, rework: { l: '재작업 필요', c: 's-rework' },
  verifying: { l: '검증 진행', c: 's-verif' }, gate: { l: 'Gate 대기', c: 's-verif' }, paused: { l: '중단 · 재개 대기', c: 's-rework' },
  done: { l: '완료', c: 's-done' }, failed: { l: '실패', c: 's-fail' }, cancelled: { l: '취소됨', c: 's-plan' },
};
const PRIORITY = ['긴급', '높음', '보통', '낮음'];
const FIELD_L: Record<string, string> = {
  priority: '우선순위', title: '제목', doneCond: '완료 조건', assignee: '담당 Agent', verifier: '검증 Agent',
  scopeAdd: '작업 범위 추가', acAdd: 'Acceptance Criteria 추가',
};
const WORK_TYPE: Record<string, string> = {
  Analysis: '분석', Design: '설계', Implementation: '구현', Configuration: '구성', Test: '테스트', Verification: '검증', Documentation: '문서화', Integration: '통합',
};

/** 원본 CPST. held(보류)는 원본에 없는 계약 상태라 수정 요청과 같은 주황 색을 쓴다(보고서 「원본과 다른 점」). */
const CPST: Record<string, { l: string; c: string }> = {
  draft: { l: '작성 중', c: 'c-draft' }, review: { l: '승인 대기', c: 'c-review' }, changes: { l: '수정 요청', c: 'c-changes' },
  approved: { l: '승인됨 · 반영 대기', c: 'c-approved' }, rejected: { l: '반려', c: 'c-rejected' }, applied: { l: 'WBS 반영 완료', c: 'c-applied' },
  held: { l: '보류', c: 'c-changes' },
};
export const cpStatus = (status: string | number) => {
  const s = CPST[String(status)] ?? { l: String(status), c: 'c-draft' };
  return { l: s.l, c: `cps ${s.c}` };
};

interface LooseOp {
  op: string; task?: string; field?: string; before?: unknown; after?: unknown; ref?: string;
  pred?: string; succ?: string; type?: string;
  t?: { title?: string; type?: string; domain?: string; wp?: string; judgedRules?: Judged | undefined };
  preds?: { pred: string; type: string }[];
}
interface Judged { items: { rule: string | number; result: string | number; agreedBy: readonly (string | number)[]; basis: string; judgedAt: string }[] }
const loose = (op: ProposalOp) => op as unknown as LooseOp;

const fieldValue = (field: string | undefined, value: unknown) =>
  value === undefined || value === null || value === '' ? '—' : field === 'priority' ? (PRIORITY[Number(value)] ?? String(value)) : String(value);

export function opText(op: ProposalOp, idMap: Record<string, string> | null): string {
  const o = loose(op);
  const r = (x = '') => idMap?.[x] ?? x;
  if (o.op === 'add') return `신규 ${r(o.ref)} 「${o.t?.title ?? ''}」`;
  if (o.op === 'modify') return `${o.task ?? ''} ${FIELD_L[o.field ?? ''] ?? o.field ?? ''}: ${fieldValue(o.field, o.after)}`;
  if (o.op === 'remove') return `${o.task ?? ''} 취소`;
  if (o.op === 'dep-add') return `선행 추가 ${r(o.pred)} → ${r(o.succ)} (${o.type ?? 'FS'})`;
  return `선행 삭제 ${r(o.pred)} → ${r(o.succ)}`;
}

export interface DiffRow { kindL: string; kindC: string; target: string; tTitle: string; field: string; before: string; after: string; canOpen: boolean }

/** 변경 전/후 비교 행. 변경 전 값은 서버 미리보기 diff가 있으면 그것을 쓴다(서버가 현재 WBS로 계산). */
export function diffRows(ops: readonly ProposalOp[], idMap: Record<string, string>, tasks: ReadonlyMap<string, TaskInfo>, diff: readonly DiffEntry[]): DiffRow[] {
  const title = (key: string) => tasks.get(key)?.title ?? '';
  return ops.map((op, index) => {
    const o = loose(op);
    const r = (x = '') => idMap[x] ?? x;
    const server = diff.find((d) => d.index === index && (o.op !== 'modify' || d.field === o.field));
    let row: Omit<DiffRow, 'canOpen'>;
    if (o.op === 'add') {
      const preds = (o.preds ?? []).map((p) => r(p.pred));
      row = {
        kindL: '신규 Task', kindC: 'kb k-add', target: r(o.ref), tTitle: o.t?.title ?? '', field: 'Task 전체', before: '—',
        after: `${WORK_TYPE[o.t?.type ?? ''] ?? o.t?.type ?? ''} / ${o.t?.domain ?? ''} · WP ${o.t?.wp ?? ''}${preds.length ? ` · 선행 ${preds.join(', ')}` : ''}`,
      };
    } else if (o.op === 'modify') {
      const keep = o.field === 'scopeAdd' || o.field === 'acAdd';
      const before = server?.before !== undefined && server.before !== null ? server.before : o.before;
      row = {
        kindL: '수정', kindC: 'kb k-mod', target: o.task ?? '', tTitle: title(o.task ?? ''), field: FIELD_L[o.field ?? ''] ?? o.field ?? '',
        before: keep ? '(기존 항목 유지)' : fieldValue(o.field, before), after: fieldValue(o.field, o.after),
      };
    } else if (o.op === 'remove') {
      const st = tasks.get(o.task ?? '')?.status;
      row = { kindL: '취소', kindC: 'kb k-rem', target: o.task ?? '', tTitle: title(o.task ?? ''), field: '상태', before: st ? (TASK_STATUS[st]?.l ?? st) : '—', after: '취소됨' };
    } else if (o.op === 'dep-add') {
      row = { kindL: '선행 추가', kindC: 'kb k-dep', target: r(o.succ), tTitle: title(r(o.succ)) || title(o.succ ?? ''), field: '선행 Task', before: '—', after: `${r(o.pred)} (${o.type ?? 'FS'})` };
    } else {
      const before = typeof server?.before === 'string' && server.before ? server.before : (o.pred ?? '');
      row = { kindL: '선행 삭제', kindC: 'kb k-rem', target: o.succ ?? '', tTitle: title(o.succ ?? ''), field: '선행 Task', before, after: '—' };
    }
    return { ...row, canOpen: tasks.has(row.target) };
  });
}

const REASON: Record<string, string> = { 'pred-cancelled': '선행 취소', 'succ-cancelled': '후속 취소', 'dep-remove': '관계 삭제' };

export interface ImpactRow { id: string; title: string; notes: string; stL: string; stC: string; isNew: boolean; canOpen: boolean; unblocked: boolean | null }

/**
 * 영향 분석 표. 직접 변경 + 서버 impact(D-27)를 Task별로 모은다.
 * - 제거된 관계(removedDependencies)는 「선행 관계 제거」로 보인다.
 * - 후속(unblockedSuccessors)은 남은 선행이 없을 때만 「차단 해제 → 실행 가능」이고, 남아 있으면 「계속 차단」과 남은 선행을 보인다.
 *   왜: 관계 하나가 지워졌다고 후속이 풀린 것은 아니다. 다른 선행이 남으면 계속 막힌다(contracts §2.1 영향).
 */
export function impactRows(ops: readonly ProposalOp[], idMap: Record<string, string>, tasks: ReadonlyMap<string, TaskInfo>, impact: Impact | null): ImpactRow[] {
  const notes = new Map<string, string[]>();
  const unblocked = new Map<string, boolean>();
  const note = (id: string, text: string) => {
    const list = notes.get(id) ?? [];
    if (!list.includes(text)) list.push(text);
    notes.set(id, list);
  };
  for (const op of ops) {
    const o = loose(op);
    const r = (x = '') => idMap[x] ?? x;
    if (o.op === 'add') note(r(o.ref), '신규 생성 (계획 중)');
    else if (o.op === 'modify') note(o.task ?? '', `직접 변경 — ${FIELD_L[o.field ?? ''] ?? o.field ?? ''}`);
    else if (o.op === 'remove') note(o.task ?? '', '취소');
    else note(r(o.succ), `${o.op === 'dep-add' ? '선행 추가' : '선행 삭제'} ${r(o.pred)}`);
  }
  for (const dep of impact?.removedDependencies ?? []) {
    // 관계 삭제 op로 지운 관계는 위에서 「선행 삭제」로 이미 적었다(원본 문구). 취소로 함께 지워진 관계만 따로 적는다.
    if (String(dep.reason) === 'dep-remove') continue;
    const target = String(dep.reason) === 'succ-cancelled' ? dep.pred : dep.succ;
    note(target, `선행 관계 제거 ${dep.pred} → ${dep.succ} (${String(dep.type)}, ${REASON[String(dep.reason)] ?? String(dep.reason)})`);
  }
  for (const s of impact?.unblockedSuccessors ?? []) {
    if (s.remainingBlockers.length === 0) {
      unblocked.set(s.taskKey, true);
      note(s.taskKey, '차단 해제 → 실행 가능');
    } else {
      unblocked.set(s.taskKey, false);
      const rest = s.remainingBlockers.map((b) => `${b.pred} (${String(b.type)}${b.predStatus ? `, ${TASK_STATUS[String(b.predStatus)]?.l ?? String(b.predStatus)}` : ''})`);
      note(s.taskKey, `계속 차단 — 남은 선행 ${rest.join(', ')}`);
    }
  }
  return [...notes.entries()].filter(([id]) => id !== '').map(([id, list]) => {
    const task = tasks.get(id);
    const isNew = !task;
    const st = task ? (TASK_STATUS[task.status] ?? { l: task.status, c: 's-plan' }) : TASK_STATUS.planning ?? { l: '계획 중', c: 's-plan' };
    const title = task?.title ?? newTitle(ops, idMap, id);
    return { id, title, notes: list.join(' · '), stL: st.l, stC: st.c, isNew, canOpen: !isNew, unblocked: unblocked.get(id) ?? null };
  });
}

function newTitle(ops: readonly ProposalOp[], idMap: Record<string, string>, id: string): string {
  for (const op of ops) {
    const o = loose(op);
    if (o.op === 'add' && (idMap[o.ref ?? ''] ?? o.ref) === id) return o.t?.title ?? '';
  }
  return '';
}

const HOLD: Record<string, string> = {
  JUDGEMENT_MISSING: '판단 기록 없음', JUDGEMENT_NOT_MET: '판단 불충족',
  ORDER_NOT_PRESERVED: '실행 순서 보장 안 됨', ACTIVE_TASK_BLOCKED: '진행 중 Task 새 차단',
};
/** 판단 규칙 이름(data-model §2.3-1). 규칙 번호와 원래 값(rule)을 함께 보인다. */
const RULE: Record<string, string> = {
  revert: '규칙 5 revert', contract: '규칙 7 contract', refactor: '규칙 9 refactor',
  ac_meaning: 'AC 의미 ac_meaning', layer_order: '계층 순서 layer_order', test_included: '테스트 포함 test_included',
};
const ruleLabel = (rule: string | number) => RULE[String(rule)] ?? String(rule);

/** 보류 사유 한 줄. 코드(JUDGEMENT_NOT_MET 등)는 지우지 않고 뜻을 앞에 붙인다. */
export function holdReasonText(reason: Pick<HoldReason, 'message'> & { code: string | number; taskKey?: string; rule?: string | number }): string {
  const code = String(reason.code);
  const parts = [`${HOLD[code] ?? code}(${code})`];
  if (reason.taskKey) parts.push(reason.taskKey);
  if (reason.rule !== undefined) parts.push(ruleLabel(reason.rule));
  return `${parts.join(' · ')} — ${reason.message}`;
}

export interface JudgementRow { target: string; rule: string; result: string; met: boolean; agreedBy: string; basis: string; judgedAt: string }

/** 판단 결과 표: 기존 Task(taskJudgements) → 새 Task(add의 judgedRules) → 분할 전체(splitJudgements) 순서 */
export function judgementRows(cp: Pick<Proposal, 'ops' | 'idMap' | 'taskJudgements' | 'splitJudgements'>): JudgementRow[] {
  const rows: JudgementRow[] = [];
  const push = (target: string, judged: Judged | null | undefined) => {
    for (const item of judged?.items ?? []) {
      const met = String(item.result) === 'met';
      rows.push({ target, rule: ruleLabel(item.rule), result: met ? '충족' : '불충족', met, agreedBy: item.agreedBy.map(String).join(' · '), basis: item.basis, judgedAt: item.judgedAt });
    }
  };
  for (const entry of cp.taskJudgements) push(entry.taskKey, entry.judgedRules as unknown as Judged);
  for (const op of cp.ops) {
    const o = loose(op);
    if (o.op === 'add' && o.t?.judgedRules) push(cp.idMap[o.ref ?? ''] ?? o.ref ?? '', o.t.judgedRules);
  }
  push('분할 전체', cp.splitJudgements as unknown as Judged | null);
  return rows;
}

const EVENT: Record<string, string> = {
  created: '작성', submitted: '제출', rejected: '반려', changes: '수정 요청', approved: '승인', held: '보류', applied: 'WBS 반영', judged: '판단 기록',
};
export const eventLabel = (action: string) => EVENT[action] ?? action;

export function sourceLabel(source: { kind: string | number; id: string | null }, planningLabel?: string): string {
  const kind = String(source.kind);
  if (kind === 'manual') return '팀장 직접 작성';
  if (kind === 'planning') return planningLabel ?? `Planning ${source.id ?? ''}`;
  if (kind === 'message') return `메시지 ${source.id ?? ''}`;
  if (kind === 'split') return `분할 ${source.id ?? ''}`;
  if (kind === 'input') return `입력 자료 ${source.id ?? ''}`;
  if (kind === 'decision') return `기술 결정 ${source.id ?? ''}`;
  return `${kind} ${source.id ?? ''}`;
}
