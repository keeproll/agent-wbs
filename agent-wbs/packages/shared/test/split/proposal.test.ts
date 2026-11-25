import { describe, expect, test } from 'vitest';
import { TASK_STATUSES } from '../../src/domain/index.ts';
import { validateSplitProposal } from '../../src/split/index.ts';
import type { NewTask, ProposalOp, ProposalTask } from '../../src/proposal/index.ts';
import { ac, add, dep, snapshot, task } from '../proposal/fixtures.ts';
import { original, toSnapshot } from '../proposal/original.ts';

const big = { estimate: { est: 6, lo: 5, hi: 7, confidence: '중' as const }, ac: [ac('1'), ac('2'), ac('3')] };
const world = (patch: Partial<ProposalTask> = {}, status: ProposalTask['status'] = 'ready') =>
  snapshot([task('P', 'done'), task('Q', 'running'), task('T', status, { ...big, ...patch }), task('S'), task('V')],
    [dep('P', 'T'), dep('Q', 'T', 'SS'), dep('T', 'S'), dep('T', 'V', 'SS')]);
const preds = [{ pred: 'P', type: 'FS' as const }, { pred: 'Q', type: 'SS' as const }];

function cut(first: Partial<NewTask> = {}, second: Partial<NewTask> = {}): ProposalOp[] {
  return [
    add('N1', { ac: [ac('1'), ac('2')], ...first }, preds),
    add('N2', { ac: [ac('3')], ...second }, [{ pred: 'N1', type: 'FS' }]),
    { op: 'dep-add', pred: 'N2', succ: 'S', type: 'FS' }, { op: 'dep-add', pred: 'N2', succ: 'V', type: 'SS' },
    { op: 'remove', task: 'T' },
  ];
}
const codes = (base: ReturnType<typeof world>, ops: readonly ProposalOp[]) =>
  [...new Set(validateSplitProposal(base, 'T', ops).problems.map(problem => problem.code))];

describe('valid splits', () => {
  test('two parts, relations reconnected, original cancelled with its relations', () => {
    const result = validateSplitProposal(world(), 'T', cut());
    expect(result.problems).toEqual([]);
    expect(result.simulation.next.tasks.find(item => item.id === 'T')?.status).toBe('cancelled');
    expect(result.simulation.next.dependencies.some(item => item.pred === 'T' || item.succ === 'T')).toBe(false);
    expect(result.simulation.next.tasks.at(-1)?.checklist).toHaveLength(1);
    expect(result.simulation.impact.unblockedSuccessors.map(item => [item.taskKey, item.remainingBlockers.length]))
      .toEqual([['S', 1], ['V', 1]]);
  });

  test('uncertain only: an analysis Task in front, original kept', () => {
    const uncertain = { estimate: { est: 3, lo: 2, hi: 4, confidence: '하' as const } };
    const ops: ProposalOp[] = [add('N0', { workType: 'Analysis' }, preds), { op: 'dep-add', pred: 'N0', succ: 'T' }];
    expect(codes(world(uncertain), ops)).toEqual([]);
    expect(codes(world(uncertain), ops.slice(0, 1))).toEqual(['ANALYSIS_REQUIRED', 'RULE_VIOLATION']);
    expect(codes(world(uncertain), [add('N0', {}, preds), { op: 'dep-add', pred: 'N0', succ: 'T' }]))
      .toEqual(['ORIGINAL_NOT_CANCELLED', 'ANALYSIS_REQUIRED', 'RULE_VIOLATION']);
  });

  test('suspicions and missing judgements are warnings, not rejection', () => {
    const result = validateSplitProposal(world(), 'T', cut({ title: 'A/B', judgements: [] }));
    expect(result.problems).toEqual([]);
    expect(result.warnings.map(item => item.message.split(':')[0]))
      .toEqual(['목적이 하나', '혼자 되돌릴 수 있음', '공유 계약 변경은 따로', '정리와 기능 변경은 따로']);
  });
});

describe('rejected splits', () => {
  test.each(TASK_STATUSES)('target status %s', status => {
    const open = ['planning', 'approval', 'ready'].includes(status);
    expect(codes(world({}, status), cut()).includes('ALREADY_STARTED')).toBe(!open);
  });
  test('execution history on a ready Task', () => {
    expect(codes(world({ hasExecutionHistory: true }), cut())).toContain('ALREADY_STARTED');
  });
  test('nothing flagged, or an excepted rule', () => {
    expect(codes(world({ estimate: { est: 2, lo: 1, hi: 3, confidence: '중' } }), cut())).toEqual(['NOTHING_TO_SPLIT']);
  });
  test.each([
    ['still above the size limit', cut({ estimate: { est: 5, lo: 4, hi: 6, confidence: '중' } }), 'RULE_VIOLATION'],
    ['still uncertain', cut({ estimate: { est: 2, lo: 1, hi: 3, confidence: '하' } }), 'RULE_VIOLATION'],
    ['no estimate', cut({}, { estimate: null }), 'ESTIMATE_MISSING'],
    ['no split basis', cut({}, { splitBasis: ' ' }), 'SPLIT_BASIS_MISSING'],
    ['AC duplicated', cut({}, { ac: [ac('2'), ac('3')] }), 'AC_NOT_PARTITIONED'],
    ['AC lost', cut({}, { ac: [ac('other')] }), 'AC_NOT_PARTITIONED'],
    ['part without AC', cut({ ac: [ac('1'), ac('2'), ac('3')] }, { ac: [] }), 'AC_MISSING'],
    ['successor dropped', cut().filter(op => !(op.op === 'dep-add' && op.succ === 'S')), 'DEPENDENCY_NOT_RECONNECTED'],
    ['SS successor dropped', cut().filter(op => !(op.op === 'dep-add' && op.succ === 'V')), 'DEPENDENCY_NOT_RECONNECTED'],
    ['FS successor weakened to SS', cut().map(op => op.op === 'dep-add' && op.succ === 'S' ? { ...op, type: 'SS' as const } : op),
      'DEPENDENCY_NOT_RECONNECTED'],
    ['predecessor dropped', cut().map(op => op.op === 'add' && op.ref === 'N1' ? { ...op, preds: preds.slice(1) } : op),
      'DEPENDENCY_NOT_RECONNECTED'],
    ['unrelated edit', [...cut(), { op: 'modify', task: 'S', field: 'title', after: 'x' }], 'OUT_OF_SCOPE'],
    ['unrelated relation', [...cut(), { op: 'dep-add', pred: 'S', succ: 'V' }], 'OUT_OF_SCOPE'],
  ] as [string, ProposalOp[], string][])('%s', (_name, ops, code) => {
    expect(codes(world(), ops)).toEqual([code]);
  });
  test('original kept beside its parts', () => {
    expect(codes(world(), cut().slice(0, 4))).toEqual(['ORIGINAL_NOT_CANCELLED', 'RULE_VIOLATION']);
  });
  test('one part only', () => {
    const ops: ProposalOp[] = [add('N1', { ac: big.ac }, preds), { op: 'dep-add', pred: 'N1', succ: 'S' },
      { op: 'dep-add', pred: 'N1', succ: 'V', type: 'SS' }, { op: 'remove', task: 'T' }];
    expect(codes(world(), ops)).toEqual(['TOO_FEW_PARTS']);
  });
  test('simulation holds are passed through; unknown target', () => {
    expect(codes(world(), [...cut(), { op: 'dep-remove', pred: 'N2', succ: 'P' }])).toEqual(['DEPENDENCY_NOT_FOUND']);
    expect(validateSplitProposal(world(), 'NO', cut()).problems.map(item => item.code)).toEqual(['TASK_NOT_FOUND']);
  });
  test('a part that releases an FS successor early is warned about', () => {
    const ops = cut().map(op => op.op === 'add' && op.ref === 'N2' ? { ...op, preds } : op);
    const result = validateSplitProposal(world(), 'T', ops);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([{ taskKey: 'T', message: '후속 S (FS) 관계가 TASK-0021에는 이어지지 않습니다' }]);
  });
});

describe('research must really precede the result (G§5.2-1 rule 10)', () => {
  const uncertain = { estimate: { ...big.estimate, confidence: '하' as const } };
  const research = add('R', { workType: 'Analysis' }, preds);
  const after = (pred: string, type: 'FS' | 'SS' = 'FS') => ({ pred, type });
  const plan = (first: typeof preds, second: typeof preds, rest: ProposalOp[] = []): ProposalOp[] =>
    [research, add('N1', { ac: [ac('1'), ac('2')] }, first), add('N2', { ac: [ac('3')] }, second), ...cut().slice(2), ...rest];

  test.each([
    ['in front of both through the chain', plan([after('R')], [after('N1')]), false],
    ['in front of both directly', plan([after('R')], [after('R')]), false],
    ['behind an SS link between the parts', plan([after('R')], [after('N1', 'SS')]), false],
    ['detached', plan(preds, [after('N1')]), true],
    ['in front of one part only', plan([after('R')], preds), true],
    ['attached by SS only', plan([after('R', 'SS')], [after('N1')]), true],
    ['behind the parts', plan(preds, [after('N1')], [{ op: 'dep-add', pred: 'N2', succ: 'R' }]), true],
    ['in front of an unrelated successor only', plan(preds, [after('N1')], [{ op: 'dep-add', pred: 'R', succ: 'S' }]), true],
  ])('%s', (_name, ops, rejected) => {
    expect(codes(world(uncertain), ops).includes('ANALYSIS_REQUIRED')).toBe(rejected);
  });

  test('an original kept behind research needs FS as well', () => {
    const kept = { estimate: { est: 3, lo: 2, hi: 4, confidence: '하' as const } };
    expect(codes(world(kept), [research, { op: 'dep-add', pred: 'R', succ: 'T', type: 'SS' }])).toEqual(['ANALYSIS_REQUIRED']);
  });

  test('an uncertain Analysis Task: leading research passes, detached research does not', () => {
    const target = { ...uncertain, workType: 'Analysis' as const };
    const analysis = (first: typeof preds) => plan(first, [after('N1')]).map(op =>
      op.op === 'add' ? { ...op, task: { ...op.task, workType: 'Analysis' as const } } : op);
    expect(codes(world(target), analysis([after('R')]))).not.toContain('ANALYSIS_REQUIRED');
    expect(codes(world(target), analysis(preds))).toContain('ANALYSIS_REQUIRED');
  });
});

test('original demo proposeSplit output: structure and relations hold, result satisfies the rules', () => {
  const data = original.load();
  const base = toSnapshot(data);
  interface Old { op: string; ref?: string; t?: Record<string, unknown> & { wp: string; est: number; lo: number; hi: number } }
  const convert = (raw: unknown): ProposalOp => {
    const op = raw as Old;
    if (op.op !== 'add' || !op.t) return raw as ProposalOp;
    const { wp, est, lo, hi, type, domain, rel, basis, conf, ...rest } = op.t;
    return { ...op, op: 'add', workPackageId: wp, task: { ...rest, workType: type, primaryDomain: domain, relatedDomains: rel,
      splitBasis: basis, estimate: { est, lo, hi, confidence: conf } } as unknown as NewTask } as ProposalOp;
  };
  const run = (id: string) => validateSplitProposal(base, id, original.splitOps(data, id).map(convert));
  // TASK-0009/0011: uncertain only. TASK-0008: 6h and uncertain, so also cut in two.
  for (const id of ['TASK-0009', 'TASK-0011']) expect(run(id).problems, id).toEqual([]);
  expect(original.splitOps(data, 'TASK-0008')).toHaveLength(5);
  expect(run('TASK-0008').problems).toEqual([]);
});
