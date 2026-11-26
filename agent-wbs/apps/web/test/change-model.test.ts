import { describe, expect, it } from 'vitest';
import {
  cpStatus, diffRows, eventLabel, holdReasonText, impactRows, judgementRows, opText, sourceLabel, type TaskInfo,
} from '../src/features/change/model.ts';
import type { Proposal, ProposalOp } from '../src/features/change/types.ts';

/** 계약의 op 합집합 타입은 객체 리터럴로 바로 만들기 어려워 시험에서만 바꿔 쓴다. */
const ops_ = (list: object[]) => list as unknown as ProposalOp[];

const TASKS = new Map<string, TaskInfo>([
  ['TASK-0005', { title: 'Task CRUD API', status: 'planning' }],
  ['TASK-0006', { title: 'Dependency 검증', status: 'ready' }],
  ['TASK-0007', { title: 'Gantt 화면', status: 'ready' }],
  ['TASK-0008', { title: '보고서', status: 'running' }],
]);

describe('CP 상태 표시(원본 CPST P L4455 + 계약의 held)', () => {
  it('원본 문구와 색 클래스를 그대로 쓴다', () => {
    expect(cpStatus('review')).toEqual({ l: '승인 대기', c: 'cps c-review' });
    expect(cpStatus('approved')).toEqual({ l: '승인됨 · 반영 대기', c: 'cps c-approved' });
    expect(cpStatus('applied')).toEqual({ l: 'WBS 반영 완료', c: 'cps c-applied' });
  });
  it('원본에 없는 held는 「보류」로 보인다', () => {
    expect(cpStatus('held').l).toBe('보류');
  });
});

describe('변경 전/후 비교 행(원본 diffRows P L5651)', () => {
  it('7가지 변경과 add를 원본 구분·항목 문구로 만든다', () => {
    const ops = ops_([
      { op: 'modify', task: 'TASK-0006', field: 'priority', before: 2, after: 0 },
      { op: 'modify', task: 'TASK-0006', field: 'scopeAdd', after: '경로 검사 추가' },
      { op: 'remove', task: 'TASK-0005' },
      { op: 'dep-add', pred: 'TASK-0005', succ: 'TASK-0006', type: 'SS' },
      { op: 'dep-remove', pred: 'TASK-0005', succ: 'TASK-0006' },
    ]);
    const rows = diffRows(ops, {}, TASKS, []);
    expect(rows.map((r) => [r.kindL, r.target, r.field, r.before, r.after])).toEqual([
      ['수정', 'TASK-0006', '우선순위', '보통', '긴급'],
      ['수정', 'TASK-0006', '작업 범위 추가', '(기존 항목 유지)', '경로 검사 추가'],
      ['취소', 'TASK-0005', '상태', '계획 중', '취소됨'],
      ['선행 추가', 'TASK-0006', '선행 Task', '—', 'TASK-0005 (SS)'],
      ['선행 삭제', 'TASK-0006', '선행 Task', 'TASK-0005', '—'],
    ]);
    expect(rows[0]?.tTitle).toBe('Dependency 검증');
    expect(rows[0]?.canOpen).toBe(true);
  });
  it('미리보기 diff의 변경 전 값이 있으면 그것을 쓴다(서버 계산)', () => {
    const rows = diffRows(ops_([{ op: 'modify', task: 'TASK-0006', field: 'doneCond', after: '새 조건' }]), {}, TASKS,
      [{ index: 0, op: 'modify', target: 'TASK-0006', field: 'doneCond', before: '옛 조건', after: '새 조건' }]);
    expect(rows[0]?.before).toBe('옛 조건');
  });
  it('새 Task는 idMap의 예상 키로 보이고 열 수 없다', () => {
    const add = {
      op: 'add', ref: 'NEW-1', preds: [{ pred: 'TASK-0005', type: 'FS' }],
      t: { title: '응답 수신 처리', type: 'Implementation', domain: 'BE', wp: 'wp-6', priority: 1, assignee: 'Codex', verifier: 'Claude', purpose: '', doneCond: '' },
    } as unknown as ProposalOp;
    const rows = diffRows([add], { 'NEW-1': 'TASK-0013' }, TASKS, []);
    expect(rows[0]).toMatchObject({ kindL: '신규 Task', target: 'TASK-0013', tTitle: '응답 수신 처리', field: 'Task 전체', canOpen: false });
    expect(rows[0]?.after).toContain('선행 TASK-0005');
  });
});

describe('변경 전 값이 없으면 —', () => {
  it('우선순위 변경 전 값을 모르면 「undefined」가 아니라 —', () => {
    expect(diffRows(ops_([{ op: 'modify', task: 'TASK-0006', field: 'priority', after: 0 }]), {}, TASKS, [])[0]?.before).toBe('—');
  });
});

describe('opText(원본 P L5642)', () => {
  it('Planning 검토의 「반영될 변경」 칩 문구', () => {
    expect(opText(ops_([{ op: 'modify', task: 'TASK-0006', field: 'priority', after: 1 }])[0] as ProposalOp, null)).toBe('TASK-0006 우선순위: 높음');
    expect(opText(ops_([{ op: 'remove', task: 'TASK-0005' }])[0] as ProposalOp, null)).toBe('TASK-0005 취소');
    expect(opText(ops_([{ op: 'dep-add', pred: 'TASK-0005', succ: 'TASK-0006', type: 'FS' }])[0] as ProposalOp, null)).toBe('선행 추가 TASK-0005 → TASK-0006 (FS)');
  });
});

describe('영향 분석(D-27: 취소 CP의 제거 관계·풀리는 후속·계속 차단)', () => {
  it('제거된 관계와, 남은 선행이 없어 실제로 풀리는 후속을 구분한다', () => {
    const rows = impactRows(ops_([{ op: 'remove', task: 'TASK-0005' }]), {}, TASKS, {
      removedDependencies: [
        { pred: 'TASK-0005', succ: 'TASK-0006', type: 'SS', reason: 'pred-cancelled' },
        { pred: 'TASK-0005', succ: 'TASK-0007', type: 'FS', reason: 'pred-cancelled' },
      ],
      unblockedSuccessors: [
        { taskKey: 'TASK-0006', remainingBlockers: [] },
        { taskKey: 'TASK-0007', remainingBlockers: [{ pred: 'TASK-0008', succ: 'TASK-0007', type: 'FS', predStatus: 'running' }] },
      ],
    });
    expect(rows.map((r) => [r.id, r.notes])).toEqual([
      ['TASK-0005', '취소'],
      ['TASK-0006', '선행 관계 제거 TASK-0005 → TASK-0006 (SS, 선행 취소) · 차단 해제 → 실행 가능'],
      ['TASK-0007', '선행 관계 제거 TASK-0005 → TASK-0007 (FS, 선행 취소) · 계속 차단 — 남은 선행 TASK-0008 (FS, 실행 중)'],
    ]);
    expect(rows[1]).toMatchObject({ unblocked: true, stL: '실행 대기' });
    expect(rows[2]).toMatchObject({ unblocked: false });
  });
});

describe('영향 분석: 관계 삭제 op', () => {
  it('직접 삭제한 관계는 「선행 삭제」로 한 번만 보이고, 풀리면 차단 해제를 붙인다(원본 UI-09 화면과 같은 문구)', () => {
    const rows = impactRows(ops_([
      { op: 'dep-remove', pred: 'TASK-0005', succ: 'TASK-0006' },
      { op: 'dep-add', pred: 'TASK-0005', succ: 'TASK-0006', type: 'SS' },
    ]), {}, TASKS, {
      removedDependencies: [{ pred: 'TASK-0005', succ: 'TASK-0006', type: 'FS', reason: 'dep-remove' }],
      unblockedSuccessors: [{ taskKey: 'TASK-0006', remainingBlockers: [] }],
    });
    expect(rows.map((r) => [r.id, r.notes])).toEqual([['TASK-0006', '선행 삭제 TASK-0005 · 선행 추가 TASK-0005 · 차단 해제 → 실행 가능']]);
  });
});

describe('보류 사유(D-33~35)', () => {
  it('코드 이름을 지우지 않고 뜻을 붙인다', () => {
    expect(holdReasonText({ code: 'JUDGEMENT_NOT_MET', taskKey: 'TASK-0013', rule: 'contract', message: '계약 판단 불충족' }))
      .toBe('판단 불충족(JUDGEMENT_NOT_MET) · TASK-0013 · 규칙 7 contract — 계약 판단 불충족');
    expect(holdReasonText({ code: 'ACTIVE_TASK_BLOCKED', message: 'TASK-0008 차단' }))
      .toBe('진행 중 Task 새 차단(ACTIVE_TASK_BLOCKED) — TASK-0008 차단');
  });
});

describe('판단 결과(D-33·D-34)', () => {
  it('기존 Task·새 Task·분할 판단을 대상별로 모은다', () => {
    const item = { result: 'met', agreedBy: ['Claude', 'Codex'], basis: '되돌리기 쉬움', judgedAt: '2026-11-03T02:00:00.000Z', sourceRef: 'job-1', subjectHash: 'a'.repeat(64) };
    const cp = {
      ops: [{ op: 'add', ref: 'NEW-1', preds: [], t: { title: 'x', judgedRules: { schemaVersion: 1, items: [{ ...item, rule: 'refactor', result: 'not_met' }] } } }],
      idMap: { 'NEW-1': 'TASK-0013' },
      taskJudgements: [{ taskKey: 'TASK-0006', judgedRules: { schemaVersion: 1, items: [{ ...item, rule: 'revert' }] } }],
      splitJudgements: { schemaVersion: 1, items: [{ ...item, rule: 'layer_order' }] },
    } as unknown as Proposal;
    expect(judgementRows(cp).map((r) => [r.target, r.rule, r.result, r.agreedBy])).toEqual([
      ['TASK-0006', '규칙 5 revert', '충족', 'Claude · Codex'],
      ['TASK-0013', '규칙 9 refactor', '불충족', 'Claude · Codex'],
      ['분할 전체', '계층 순서 layer_order', '충족', 'Claude · Codex'],
    ]);
  });
});

describe('승인 이력·출처 문구', () => {
  it('서버 이벤트 이름을 화면 문구로 바꾼다', () => {
    expect(eventLabel('created')).toBe('작성');
    expect(eventLabel('submitted')).toBe('제출');
    expect(eventLabel('changes')).toBe('수정 요청');
    expect(eventLabel('applied')).toBe('WBS 반영');
    expect(eventLabel('unknown-x')).toBe('unknown-x');
  });
  it('출처', () => {
    expect(sourceLabel({ kind: 'manual', id: null })).toBe('팀장 직접 작성');
    expect(sourceLabel({ kind: 'planning', id: 'p1' }, 'Planning PLN-001')).toBe('Planning PLN-001');
    expect(sourceLabel({ kind: 'message', id: 'MSG-3' })).toBe('메시지 MSG-3');
  });
});
