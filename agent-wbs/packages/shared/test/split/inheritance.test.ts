// data-model §2.4-1: 분할의 충돌 묶음 상속, 변경 범위 미기재
import { describe, expect, test } from 'vitest';
import { simulateProposal } from '../../src/proposal/index.ts';
import type { NewTask, ProposalTask, SimulationOp } from '../../src/proposal/index.ts';
import { checkSplit, DEFAULT_SPLIT_SETTINGS, validateSplitProposal } from '../../src/split/index.ts';
import type { SplitRule } from '../../src/split/index.ts';
import { ac, add, HASH, judgement, snapshot, SPLIT_JUDGED, task } from '../proposal/fixtures.ts';

const big = { estimate: { est: 6, lo: 5, hi: 7, confidence: '중' as const }, ac: [ac('1'), ac('2')] };
const world = (patch: Partial<ProposalTask> = {}) => snapshot([task('T', 'ready', { ...big, conflictGroup: 'G', ...patch })]);
const cut = (first: Partial<NewTask> = {}, second: Partial<NewTask> = {}): SimulationOp[] => [
  add('N1', { ac: [ac('1')], ...first }), add('N2', { ac: [ac('2')], ...second }), { op: 'remove', task: 'T' },
];
const groups = (base: ReturnType<typeof world>, ops: readonly SimulationOp[], splitOf: string | null = 'T') => {
  const result = simulateProposal(base, ops, { splitOf });
  return {
    groups: result.next.tasks.filter(item => item.id !== 'T').map(item => item.conflictGroup),
    diff: result.diff.filter(item => item.field === 'conflictGroup').map(({ index, op, target, before, after }) => [index, op, target, before, after]),
    original: result.next.tasks[0]?.conflictGroup,
  };
};
const hashes = Object.fromEntries(['T', 'TASK-0021', 'TASK-0022', 'TASK-0023'].map(id => [id, HASH]));
const validate = (base: ReturnType<typeof world>, ops: readonly SimulationOp[]) => validateSplitProposal(base, 'T', ops, {
  splitSubjectHash: HASH, taskHashes: { before: hashes, after: hashes }, taskJudgements: [],
  splitJudgements: { schemaVersion: 1, items: SPLIT_JUDGED.map(rule => judgement(rule)) },
});

describe('충돌 묶음 상속', () => {
  test('생략하면 원래 묶음이고 diff에 같은 묶음으로 보인다', () => {
    expect(groups(world(), cut())).toEqual({ groups: ['G', 'G'], original: 'G', diff: [
      [0, 'add', 'TASK-0021', 'G', 'G'], [1, 'add', 'TASK-0022', 'G', 'G'],
    ] });
  });

  test('다른 묶음·명시한 null은 허용하고 전후를 남긴다', () => {
    expect(groups(world(), cut({ conflictGroup: 'H' }, { conflictGroup: null }))).toMatchObject({ groups: ['H', null], diff: [
      [0, 'add', 'TASK-0021', 'G', 'H'], [1, 'add', 'TASK-0022', 'G', null],
    ] });
    expect(validate(world(), cut({ conflictGroup: 'H' }, { conflictGroup: null })).problems).toEqual([]);
  });

  test('원래 묶음이 없으면 새 묶음을 줄 때만 기록한다', () => {
    expect(groups(world({ conflictGroup: null }), cut({ conflictGroup: 'H' }))).toMatchObject({ groups: ['H', null], diff: [
      [0, 'add', 'TASK-0021', null, 'H'],
    ] });
  });

  test('취소가 먼저 와도 현재 원래 Task에서 계산한다', () => {
    const [first, second, remove] = cut();
    expect(groups(world(), [remove, first, second] as SimulationOp[]).groups).toEqual(['G', 'G']);
    expect(groups(world({ conflictGroup: 'G2' }), cut()).groups).toEqual(['G2', 'G2']);
  });

  test('일반 CP는 같은 ops라도 상속하지 않는다', () => {
    expect(groups(world(), cut({ conflictGroup: 'H' }), null)).toMatchObject({ groups: ['H', null], diff: [] });
    expect(simulateProposal(world(), cut()).next.tasks.at(-1)?.conflictGroup).toBeNull();
  });

  test('조사 Task는 상속하지 않고, 원래가 Analysis면 추가 Task 전부가 상속한다', () => {
    const research = add('N0', { workType: 'Analysis' });
    expect(groups(world(), [research, ...cut()])).toMatchObject({ groups: [null, 'G', 'G'], diff: [
      [1, 'add', 'TASK-0022', 'G', 'G'], [2, 'add', 'TASK-0023', 'G', 'G'],
    ] });
    expect(groups(world({ workType: 'Analysis' }), [research, ...cut()]).groups).toEqual(['G', 'G', 'G']);
  });

  test('원래 Task를 유지하는 조사 분할은 원래 묶음을 바꾸지 않는다', () => {
    expect(groups(world(), [add('N0', { workType: 'Analysis' }), { op: 'dep-add', pred: 'N0', succ: 'T' }]))
      .toEqual({ groups: [null], original: 'G', diff: [] });
  });

  test('원래 Task를 취소하지 않으면 대신하는 Task도 상속하지 않는다', () => {
    expect(groups(world(), cut().slice(0, 2))).toEqual({ groups: [null, null], original: 'G', diff: [] });
  });

  test('없는 원래 Task는 상속하지 않는다', () => {
    expect(groups(world(), cut(), 'X')).toMatchObject({ groups: [null, null], diff: [] });
  });

  test('분할 검증이 상속을 적용한 묶음으로 규칙 6을 점검하고 영향 목록은 한 번만 적는다', () => {
    const { simulation } = validate(world(), cut());
    const part = simulation.next.tasks.at(-1);
    expect(part && checkSplit(part, [], HASH).items.find(item => item.rule === 'cg')?.detail).toBe('「G」 하나');
    expect(simulation.impact.tasks.find(item => item.taskKey === 'TASK-0021')?.notes).toEqual([{ kind: 'created' }]);
  });

  test('공백 묶음과 설계 종류 중복은 거부한다', () => {
    for (const bad of [{ conflictGroup: ' ' }, { design: [{ kind: 'DB' as const, items: [] }, { kind: 'DB' as const, items: ['x'] }] }]) {
      expect(simulateProposal(world(), [add('N1', bad)]).issues).toMatchObject([{ code: 'VALIDATION_FAILED', taskKey: 'TASK-0021' }]);
    }
  });
});

describe('주의 — 변경 범위 미기재', () => {
  const full = { files: ['a.ts'], design: [{ kind: 'API' as const, items: ['e'] }] };
  const status = (rule: SplitRule, part: Partial<ProposalTask>, source: Partial<ProposalTask> | null, settings = DEFAULT_SPLIT_SETTINGS) => {
    const item = checkSplit(task('P', 'ready', part), [], HASH, settings, source && task('T', 'ready', source)).items
      .find(entry => entry.rule === rule);
    return [item?.status, item?.detail.includes('변경 범위 미기재')];
  };

  test('파일은 규칙 3, 설계는 규칙 2·8', () => {
    for (const rule of ['size', 'domain', 'irrev'] as const) {
      expect(status(rule, {}, full), rule).toEqual(['주의', true]);
      expect(status(rule, full, full), rule).toEqual(['통과', false]);
      expect(status(rule, {}, {}), rule).toEqual(['통과', false]);
      expect(status(rule, {}, null), rule).toEqual(['통과', false]);
    }
    expect(status('size', { files: ['a.ts'] }, full)).toEqual(['통과', false]);
    expect(status('domain', { files: ['a.ts'] }, full)).toEqual(['주의', true]);
    expect(status('size', { design: full.design }, full)).toEqual(['주의', true]);
    expect(status('irrev', { design: full.design }, full)).toEqual(['통과', false]);
    // 원래의 빈 설계 구역은 항목이 아니고, 나눈 Task의 빈 구역은 기재가 아니다.
    const placeholder = { design: [{ kind: 'DB' as const, items: [] }] };
    expect(status('domain', {}, placeholder)).toEqual(['통과', false]);
    expect(status('domain', placeholder, full)).toEqual(['주의', true]);
  });

  test('무거운 결과가 우선하고, 다른 주의와는 함께 보이며, 꺼진 규칙은 꺼짐이다', () => {
    expect(status('size', { estimate: { est: 5, lo: 4, hi: 6, confidence: '중' } }, full)).toEqual(['위반', false]);
    expect(status('size', { estimate: null }, full)).toEqual(['주의', true]);
    expect(status('size', {}, full, { ...DEFAULT_SPLIT_SETTINGS, enabled: { ...DEFAULT_SPLIT_SETTINGS.enabled, size: false } }))
      .toEqual(['꺼짐', false]);
  });

  test('분할 검증은 나눈 Task에만 경고하고 거부하지 않는다', () => {
    const scoped = (ops: SimulationOp[]) => {
      const result = validate(world(full), ops);
      expect(result.problems).toEqual([]);
      return result.warnings.filter(item => item.message.includes('변경 범위 미기재')).map(item => item.taskKey);
    };
    expect(scoped(cut(full, full))).toEqual([]);
    expect(scoped(cut(full))).toEqual(['TASK-0022', 'TASK-0022', 'TASK-0022']);
    expect(scoped([add('N0', { workType: 'Analysis' }), ...cut(full, full)])).toEqual([]);
  });

  test('파일·설계·범위는 상속하지 않는다', () => {
    const part = simulateProposal(world({ ...full, scope: ['원래 범위'] }), cut(), { splitOf: 'T' }).next.tasks.at(-1);
    expect(part).toMatchObject({ scope: [], files: [], design: [{ kind: 'API', items: [] }] });
  });
});

describe('issues의 taskKey', () => {
  const base = snapshot([task('A', 'done'), task('B'), task('C', 'cancelled')]);
  const keys = (...ops: SimulationOp[]) => simulateProposal(base, ops).issues.map(item => [item.code, item.taskKey]);

  test('특정 Task의 문제에만 있고 새 Task는 예상 키다', () => {
    expect(keys({ op: 'modify', task: 'A', field: 'title', after: 'x' })).toEqual([['COMPLETED_TASK', 'A']]);
    expect(keys({ op: 'remove', task: 'C' })).toEqual([['ALREADY_APPLIED', 'C']]);
    expect(keys({ op: 'modify', task: 'B', field: 'title', after: '' })).toEqual([['VALIDATION_FAILED', 'B']]);
    expect(keys(add('N', { title: '' }))).toEqual([['VALIDATION_FAILED', 'TASK-0021']]);
    expect(keys(add('N', {}, [{ pred: 'X', type: 'FS' }]))).toEqual([['TASK_NOT_FOUND', 'TASK-0021']]);
    expect(keys({ op: 'dep-add', pred: 'B', succ: 'B', type: 'FS' })).toEqual([['DEPENDENCY_SELF', 'B']]);
    expect(keys({ op: 'dep-remove', pred: 'A', succ: 'B' })).toEqual([['DEPENDENCY_NOT_FOUND', 'B']]);
  });

  test('Task를 정할 수 없으면 없다', () => {
    expect(keys()).toEqual([['EMPTY_PROPOSAL', undefined]]);
    expect(keys({ op: 'modify', task: 'X', field: 'title', after: 'x' })).toEqual([['TASK_NOT_FOUND', undefined]]);
    const split = validateSplitProposal(base, 'B', [{ op: 'remove', task: 'X' }], {
      splitJudgements: null, splitSubjectHash: null, taskHashes: { before: {}, after: {} }, taskJudgements: [],
    });
    expect(split.problems[0]).toMatchObject({ code: 'TASK_NOT_FOUND', index: 0 });
    expect(split.problems[0]).not.toHaveProperty('taskKey');
  });
});
