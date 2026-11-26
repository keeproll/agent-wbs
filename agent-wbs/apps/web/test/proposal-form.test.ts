import { describe, expect, it } from 'vitest';
import { buildProposal, newRow, removeRow, updateRow, type FormRow } from '../src/features/change/form.ts';

const tasks = new Map([['TASK-0005', { title: 'a', status: 'ready' }], ['TASK-0006', { title: 'b', status: 'ready' }]]);
const row = (type: FormRow['type'], task: string, value: string): FormRow => ({ ...newRow(task), type, value });

describe('변경 항목 행(MOD-07): 편집 대상은 배열 위치가 아니라 행 id', () => {
  it('새 행마다 다른 id', () => {
    expect(newRow('TASK-0001').id).not.toBe(newRow('TASK-0001').id);
  });
  it('가운데 행을 지운 뒤에도 id로 고친 행만 바뀐다', () => {
    const a = row('scopeAdd', 'TASK-0005', 'A');
    const b = row('scopeAdd', 'TASK-0005', 'B');
    const c = row('scopeAdd', 'TASK-0005', 'C');
    const rows = updateRow(removeRow([a, b, c], b.id), c.id, { value: 'C2' });
    expect(rows.map((r) => r.value)).toEqual(['A', 'C2']);
  });
});

describe('제출 데이터 만들기(원본 cpmBuild P L5772 규칙)', () => {
  it('7가지 유형을 계약 ops로 바꾼다(제목·사유·출처 포함)', () => {
    const rows = [
      row('scopeAdd', 'task-0005', '경로 검사'),
      row('doneCond', 'TASK-0005', '새 완료 조건'),
      row('acAdd', 'TASK-0005', 'Given 순환, When 추가, Then 거부'),
      row('priority', 'TASK-0006', '긴급'),
      row('assignee', 'TASK-0006', 'Codex'),
      row('depAdd', 'TASK-0006', 'TASK-0005 (SS)'),
      row('depRemove', 'TASK-0006', 'TASK-0005'),
    ];
    const r = buildProposal({ title: ' 제목 ', reason: '사유', rows }, tasks);
    expect(r.errs).toEqual([]);
    expect(r.body).toEqual({
      title: '제목', reason: '사유', source: { kind: 'manual' },
      ops: [
        { op: 'modify', task: 'TASK-0005', field: 'scopeAdd', after: '경로 검사' },
        { op: 'modify', task: 'TASK-0005', field: 'doneCond', after: '새 완료 조건' },
        { op: 'modify', task: 'TASK-0005', field: 'acAdd', after: 'Given 순환, When 추가, Then 거부' },
        { op: 'modify', task: 'TASK-0006', field: 'priority', after: 0 },
        { op: 'modify', task: 'TASK-0006', field: 'assignee', after: 'Codex' },
        { op: 'dep-add', pred: 'TASK-0005', succ: 'TASK-0006', type: 'SS' },
        { op: 'dep-remove', pred: 'TASK-0005', succ: 'TASK-0006' },
      ],
    });
  });
  it('필수 누락과 형식 오류를 항목 번호와 함께 모두 알린다', () => {
    const r = buildProposal({ title: '', reason: ' ', rows: [
      row('scopeAdd', 'TASK-0009', 'x'),
      row('priority', 'TASK-0005', '매우 높음'),
      row('acAdd', 'TASK-0005', '그냥 문장'),
      row('depAdd', 'TASK-0005', '5번'),
      row('doneCond', 'TASK-0005', ''),
    ] }, tasks);
    expect(r.body).toBeNull();
    expect(r.errs).toEqual([
      '제목을 입력하세요.',
      '변경 사유를 입력하세요.',
      '항목 1: 대상 Task TASK-0009이(가) 없습니다.',
      '항목 2: 우선순위는 긴급 · 높음 · 보통 · 낮음 중 하나',
      '항목 3: AC는 「Given …, When …, Then …」 형식',
      '항목 4: 선행 Task는 「TASK-0005 (FS)」 형식',
      '항목 5: 완료 조건 변경 값을 입력하세요.',
    ]);
  });
  it('행이 없으면 거부', () => {
    expect(buildProposal({ title: 't', reason: 'r', rows: [] }, tasks).errs).toEqual(['변경 항목을 1개 이상 추가하세요.']);
  });
  it('Task 목록을 아직 못 읽었으면 존재 검사는 서버 미리보기에 맡긴다', () => {
    expect(buildProposal({ title: 't', reason: 'r', rows: [row('scopeAdd', 'TASK-0042', 'x')] }, null).errs).toEqual([]);
  });
});
