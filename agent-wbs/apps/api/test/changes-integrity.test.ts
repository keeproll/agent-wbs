// M2-08 무결성 점검(G§0.4 「정합성 점검은 서버 측 무결성 검사로 옮긴다」, P `integrity` L4373)의 순수 판정.
import { describe, expect, test } from 'vitest';
import { DEFAULT_EXEC_POLICY } from '@awbs/shared';
import { integrityItems, type IntegritySnapshot } from '../src/changes/integrity.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const task = (key: string, over: Partial<IntegritySnapshot['tasks'][number]> = {}): IntegritySnapshot['tasks'][number] => ({
  id: key, key, status: 'ready', deleted: false, nodeKind: 'work_package', assignee: 'Claude', verifier: 'Codex',
  primaryDomain: 'BE', relatedDomains: [], approved: false, verifState: 'none', ...over,
});
const healthy = (): IntegritySnapshot => ({
  tasks: [task('TASK-0001', { status: 'done', approved: true, verifState: 'pass' }), task('TASK-0002', { status: 'running' }), task('TASK-0003')],
  deps: [{ id: 'd1', pred: 'TASK-0001', succ: 'TASK-0002', type: 'FS' }, { id: 'd2', pred: 'TASK-0002', succ: 'TASK-0003', type: 'SS' }],
  grades: [
    { taskId: 'TASK-0002', role: 'dev', modelId: 'claude-opus-5-5', effort: 'high', locked: false },
    { taskId: 'TASK-0002', role: 'qa', modelId: 'gpt-6.2-sol', effort: 'high', locked: false },
  ],
  models: [
    { agent: 'Claude', modelId: 'claude-opus-5-5', label: 'Opus', allowed: true, isNew: false, efforts: EFFORTS },
    { agent: 'Codex', modelId: 'gpt-6.2-sol', label: 'sol', allowed: true, isNew: false, efforts: EFFORTS },
  ],
  ranks: new Map([['Claude|claude-opus-5-5', 1], ['Codex|gpt-6.2-sol', 1]]),
  floors: DEFAULT_EXEC_POLICY.floors,
  subagents: [{ taskId: 'TASK-0002', role: 'dev', defKey: 'be-implementer', defAgent: 'Claude' }],
  messages: [{ key: 'MSG-001', taskId: 'TASK-0002', attemptTaskId: 'TASK-0002', dir: 'out', delivery: 'Queued' }, { key: 'MSG-002', taskId: 'TASK-0002', attemptTaskId: null, dir: 'in', delivery: null }],
});
const item = (snapshot: IntegritySnapshot, key: string) => integrityItems(snapshot).find((i) => i.key === key);

describe('integrityItems', () => {
  test('모순 없는 데이터는 모든 항목 통과, 항목마다 이름·근거 문구가 있다', () => {
    const items = integrityItems(healthy());
    expect(items.map((i) => i.key)).toEqual([
      'task_tree', 'dependency_refs', 'dependency_self', 'dependency_cycle', 'active_unblocked', 'done_approved',
      'message_attempt', 'message_delivery', 'allowed_per_agent', 'grade_allowed', 'grade_floor', 'subagent_agent',
    ]);
    expect(items.filter((i) => !i.ok)).toEqual([]);
    expect(items.every((i) => i.label.length > 0 && i.detail.length > 0)).toBe(true);
  });

  test('WBS 트리 밖(Phase 바로 아래)의 Task', () => {
    const s = healthy();
    s.tasks[2] = task('TASK-0003', { nodeKind: 'phase' });
    expect(item(s, 'task_tree')).toMatchObject({ ok: false, detail: 'TASK-0003' });
  });

  test('삭제된 Task를 가리키는 의존성·자기 참조·순환', () => {
    const s = healthy();
    s.tasks[2] = task('TASK-0003', { deleted: true });
    s.deps.push({ id: 'd3', pred: 'TASK-0003', succ: 'TASK-0003', type: 'FS' }, { id: 'd4', pred: 'TASK-0003', succ: 'TASK-0001', type: 'FS' }, { id: 'd5', pred: 'TASK-0002', succ: 'TASK-0001', type: 'FS' });
    expect(item(s, 'dependency_refs')).toMatchObject({ ok: false });
    expect(item(s, 'dependency_refs')?.detail).toContain('TASK-0003');
    expect(item(s, 'dependency_self')).toMatchObject({ ok: false, detail: 'TASK-0003 → TASK-0003' });
    expect(item(s, 'dependency_cycle')).toMatchObject({ ok: false });
    expect(item(s, 'dependency_cycle')?.detail).toMatch(/TASK-0001 → TASK-0002 → TASK-0001|TASK-0002 → TASK-0001 → TASK-0002/);
  });

  test('실행·검증 중인데 선행이 미충족이면 실패(D-35)', () => {
    const s = healthy();
    s.tasks[0] = task('TASK-0001', { status: 'gate' });
    expect(item(s, 'active_unblocked')).toMatchObject({ ok: false, detail: 'TASK-0002' });
  });

  test('완료 Task는 착수 승인과 검증 PASS 기록이 있어야 한다', () => {
    const s = healthy();
    s.tasks[0] = task('TASK-0001', { status: 'done', approved: false, verifState: 'pass' });
    expect(item(s, 'done_approved')).toMatchObject({ ok: false, detail: 'TASK-0001' });
  });

  test('메시지의 시도는 같은 Task의 것, 보낸 메시지만 전달 상태를 가진다', () => {
    const s = healthy();
    s.messages.push({ key: 'MSG-003', taskId: 'TASK-0002', attemptTaskId: 'TASK-0003', dir: 'out', delivery: 'Sent' }, { key: 'MSG-004', taskId: 'TASK-0002', attemptTaskId: null, dir: 'in', delivery: 'Sent' });
    expect(item(s, 'message_attempt')).toMatchObject({ ok: false, detail: 'MSG-003' });
    expect(item(s, 'message_delivery')).toMatchObject({ ok: false, detail: 'MSG-004' });
  });

  test('허용 모델이 없는 Agent·허용 밖 등급·최저선 아래 등급(고정은 예외)·담당과 다른 하위 Agent', () => {
    const s = healthy();
    s.models[1] = { ...s.models[1], allowed: false } as IntegritySnapshot['models'][number];
    s.tasks[2] = task('TASK-0003', { primaryDomain: 'DB' });
    s.grades.push({ taskId: 'TASK-0003', role: 'dev', modelId: 'claude-opus-5-5', effort: 'medium', locked: false });
    s.grades.push({ taskId: 'TASK-0003', role: 'dev', modelId: 'claude-opus-5-5', effort: 'low', locked: true });
    s.subagents.push({ taskId: 'TASK-0003', role: 'qa', defKey: 'fe-implementer', defAgent: 'Claude' });
    expect(item(s, 'allowed_per_agent')).toMatchObject({ ok: false, detail: 'Codex' });
    expect(item(s, 'grade_allowed')).toMatchObject({ ok: false, detail: 'TASK-0002 qa' });
    expect(item(s, 'grade_floor')).toMatchObject({ ok: false, detail: 'TASK-0003 dev' });
    expect(item(s, 'subagent_agent')).toMatchObject({ ok: false, detail: 'TASK-0003 qa fe-implementer' });
  });

  test('완료·취소·삭제 Task의 등급은 허용·최저선 점검에서 뺀다(완료 결과 보존)', () => {
    const s = healthy();
    s.grades.push({ taskId: 'TASK-0001', role: 'dev', modelId: 'gone-model', effort: 'high', locked: false });
    expect(item(s, 'grade_allowed')?.ok).toBe(true);
  });
});
