import { describe, expect, it } from 'vitest';
import {
  evidenceRows, gateRows, orphanEvidence, position, resultRows, tabCounts, verificationKeys,
  type AttemptInfo, type EvidenceItem, type GateItem, type TaskItem, type VerificationItem,
} from '../src/features/verify/model.ts';

const v = (id: string, taskKey: string, at: string, result: string, attemptId: string): VerificationItem => ({
  id, taskKey, attemptId, result, headSha: 'a'.repeat(40), specRevision: 1, cmd: 'pnpm test', expected: 'ok', actual: 'ok',
  defects: [], invalidated: false, at,
} as VerificationItem);
const ev = (id: string, taskKey: string, verificationId: string | null, checklistItemKey: string | null = null): EvidenceItem => ({
  id, taskKey, attemptId: null, verificationId, checklistItemKey, kind: 'log', sha256: 'f'.repeat(64), size: 10,
});

const verifs = [
  v('v1', 'TASK-0001', '2026-10-28T07:20:00.000Z', 'PASS', 'a1'),
  v('v2', 'TASK-0007', '2026-11-01T04:35:00.000Z', 'FAIL', 'a2'),
  v('v3', 'TASK-0007', '2026-11-03T04:35:00.000Z', 'BLOCKED', 'a3'),
];
const attempts = new Map<string, AttemptInfo>([
  ['a1', { attemptKey: 'ATT-0001-2', agent: 'Codex' }],
  ['a2', { attemptKey: 'ATT-0007-2', agent: 'Codex' }],
  ['a3', { attemptKey: 'ATT-0007-4', agent: 'Claude' }],
]);

describe('검증 화면 계산(UI-07, P vfVM L6334–6369)', () => {
  it('검증 표시 번호는 Task별 시각 순서(V-0007-1, V-0007-2) — 선택 기준은 서버 id', () => {
    const keys = verificationKeys(verifs);
    expect(keys.get('v1')).toBe('V-0001-1');
    expect(keys.get('v2')).toBe('V-0007-1');
    expect(keys.get('v3')).toBe('V-0007-2');
  });

  it('목록은 최신순, 판정·Agent 필터는 함께 적용', () => {
    expect(resultRows(verifs, attempts, { result: '', agent: '' }).map((r) => r.id)).toEqual(['v3', 'v2', 'v1']);
    expect(resultRows(verifs, attempts, { result: 'FAIL', agent: '' }).map((r) => r.id)).toEqual(['v2']);
    expect(resultRows(verifs, attempts, { result: '', agent: 'Codex' }).map((r) => r.id)).toEqual(['v2', 'v1']);
    expect(resultRows(verifs, attempts, { result: 'PASS', agent: 'Claude' })).toEqual([]);
  });

  it('상세 위치: 목록 안이면 n / 전체, 밖이면 「목록 밖」이고 이전·다음 없음', () => {
    const rows = resultRows(verifs, attempts, { result: '', agent: '' });
    expect(position(rows, 'v3')).toEqual({ index: 0, label: '1 / 3', prev: null, next: 'v2' });
    expect(position(rows, 'v2')).toEqual({ index: 1, label: '2 / 3', prev: 'v3', next: 'v1' });
    const fails = resultRows(verifs, attempts, { result: 'FAIL', agent: '' });
    expect(position(fails, 'v1')).toEqual({ index: -1, label: '목록 밖 (필터에 맞지 않음)', prev: null, next: null });
  });

  it('Evidence 행: 검증 최신순으로 묶고, 체크리스트 연결이 없으면 미연결. 검증 없는 Evidence는 따로 경고', () => {
    const list = [ev('e1', 'TASK-0001', 'v1', 'CL-01'), ev('e2', 'TASK-0007', 'v2'), ev('e3', 'TASK-0007', null, 'CL-03')];
    const rows = evidenceRows(list, verifs);
    expect(rows.map((r) => [r.id, r.verificationId, r.checklist])).toEqual([
      ['e2', 'v2', '미연결'], ['e1', 'v1', 'CL-01'], ['e3', null, 'CL-03'],
    ]);
    expect(orphanEvidence(list).map((e) => e.id)).toEqual(['e3']);
  });

  it('Gate: 취소 Task 제외, Task 번호순, 5조건 순서 고정, 미통과만 보기', () => {
    const tasks = [
      { taskKey: 'TASK-0010', title: '열', lifecycleStatus: 'gate' },
      { taskKey: 'TASK-0002', title: '둘', lifecycleStatus: 'done' },
      { taskKey: 'TASK-0003', title: '셋', lifecycleStatus: 'cancelled' },
    ] as TaskItem[];
    const cond = (pass: boolean) => ['approval', 'checklist', 'outputs', 'verification', 'defects'].map((key) => ({ key, result: pass || key !== 'outputs' ? 'PASS' : 'FAIL', reason: `${key} 사유` }));
    const gates = [
      { taskKey: 'TASK-0010', passed: false, conditions: cond(false) },
      { taskKey: 'TASK-0002', passed: true, conditions: cond(true) },
      { taskKey: 'TASK-0003', passed: false, conditions: cond(false) },
    ] as GateItem[];
    const all = gateRows(gates, tasks, false);
    expect(all.map((g) => g.taskKey)).toEqual(['TASK-0002', 'TASK-0010']);
    expect(all[1]?.cells.map((c) => `${c.key}:${c.result}`)).toEqual(['checklist:PASS', 'outputs:FAIL', 'verification:PASS', 'defects:PASS', 'approval:PASS']);
    expect(all[1]?.total).toBe('4/5');
    expect(all[0]?.total).toBe('5/5');
    expect(gateRows(gates, tasks, true).map((g) => g.taskKey)).toEqual(['TASK-0010']);
  });

  it('탭 건수는 서버 데이터 건수와 같다(UAT-VERIFY-01 b)', () => {
    const tasks = [{ taskKey: 'TASK-0007', title: 'x', lifecycleStatus: 'rework' }] as TaskItem[];
    const gates = [{ taskKey: 'TASK-0007', passed: false, conditions: [] }] as unknown as GateItem[];
    expect(tabCounts(verifs, [ev('e1', 'TASK-0007', 'v2')], gates, tasks)).toEqual({ results: 3, evidence: 1, gateUnpassed: 1 });
  });
});
