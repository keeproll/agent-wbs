/**
 * 「Change Proposal 작성」(MOD-07) 입력 → 계약 본문(createProposal) 변환과 검사. 원본 cpmBuild(P L5772)의 규칙 그대로다.
 *
 * - 행은 만들 때 받은 id로 고치고 지운다(배열 위치로 고르지 않는다).
 *   왜: 위치로 고르면 가운데 행을 지운 뒤 다른 행의 입력이 엉뚱한 행에 들어간다(앞선 리뷰에서 반복된 결함).
 * - Task가 있는지는 Task 목록을 읽었을 때만 여기서 본다. 완료 Task 수정·순환 같은 나머지는 서버 미리보기가 판정한다.
 */
import type { BodyOf } from '../../shared/api/contract.ts';
import type { TaskInfo } from './model.ts';

export const ROW_TYPES = {
  scopeAdd: { l: '작업 범위 추가', hint: '추가할 범위 문장' },
  doneCond: { l: '완료 조건 변경', hint: '새 완료 조건' },
  acAdd: { l: 'AC 추가', hint: 'Given …, When …, Then …' },
  priority: { l: '우선순위 변경', hint: '긴급 · 높음 · 보통 · 낮음' },
  assignee: { l: '담당 Agent 변경', hint: 'Claude 또는 Codex' },
  depAdd: { l: '선행 Task 추가', hint: 'TASK-0005 (FS) 또는 TASK-0005 (SS)' },
  depRemove: { l: '선행 Task 삭제', hint: 'TASK-0005' },
} as const;
export type RowType = keyof typeof ROW_TYPES;

export interface FormRow { id: string; type: RowType; task: string; value: string }
export interface FormState { title: string; reason: string; rows: FormRow[] }
export type CreateBody = BodyOf<'createProposal'>;

export const newRow = (task: string): FormRow => ({ id: crypto.randomUUID(), type: 'scopeAdd', task, value: '' });
export const updateRow = (rows: readonly FormRow[], id: string, patch: Partial<Omit<FormRow, 'id'>>): FormRow[] =>
  rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
export const removeRow = (rows: readonly FormRow[], id: string): FormRow[] => rows.filter((row) => row.id !== id);

const PRIORITY = ['긴급', '높음', '보통', '낮음'];
type Op = Record<string, unknown>;

export function buildProposal(form: FormState, tasks: ReadonlyMap<string, TaskInfo> | null): { errs: string[]; body: CreateBody | null } {
  const errs: string[] = [];
  const ops: Op[] = [];
  if (!form.title.trim()) errs.push('제목을 입력하세요.');
  if (!form.reason.trim()) errs.push('변경 사유를 입력하세요.');
  if (!form.rows.length) errs.push('변경 항목을 1개 이상 추가하세요.');
  form.rows.forEach((row, index) => {
    const label = `항목 ${String(index + 1)}: `;
    const task = row.task.trim().toUpperCase();
    const value = row.value.trim();
    if (!/^TASK-\d{4,}$/.test(task) || (tasks && !tasks.has(task))) { errs.push(`${label}대상 Task ${task || '(빈 값)'}이(가) 없습니다.`); return; }
    if (!value) { errs.push(`${label}${ROW_TYPES[row.type].l} 값을 입력하세요.`); return; }
    switch (row.type) {
      case 'priority': {
        const k = PRIORITY.indexOf(value);
        if (k < 0) errs.push(`${label}우선순위는 긴급 · 높음 · 보통 · 낮음 중 하나`);
        else ops.push({ op: 'modify', task, field: 'priority', after: k });
        return;
      }
      case 'assignee':
        if (value !== 'Claude' && value !== 'Codex') errs.push(`${label}담당 Agent는 Claude 또는 Codex`);
        else ops.push({ op: 'modify', task, field: 'assignee', after: value });
        return;
      case 'acAdd':
        if (!/^Given\s+.+?,\s*When\s+.+?,\s*Then\s+.+$/i.test(value)) errs.push(`${label}AC는 「Given …, When …, Then …」 형식`);
        else ops.push({ op: 'modify', task, field: 'acAdd', after: value });
        return;
      case 'depAdd':
      case 'depRemove': {
        const m = /^(TASK-\d{4,})(?:\s*\((FS|SS)\))?$/i.exec(value);
        if (!m?.[1]) { errs.push(`${label}선행 Task는 「TASK-0005 (FS)」 형식`); return; }
        const pred = m[1].toUpperCase();
        if (tasks && !tasks.has(pred)) { errs.push(`${label}${pred}이(가) 없습니다.`); return; }
        ops.push(row.type === 'depAdd' ? { op: 'dep-add', pred, succ: task, type: (m[2] ?? 'FS').toUpperCase() } : { op: 'dep-remove', pred, succ: task });
        return;
      }
      default:
        ops.push({ op: 'modify', task, field: row.type, after: value });
    }
  });
  if (errs.length) return { errs, body: null };
  return { errs, body: { title: form.title.trim(), reason: form.reason.trim(), source: { kind: 'manual' }, ops } as unknown as CreateBody };
}
