import { describe, expect, test } from 'vitest';
import { TASK_STATUSES } from '../../src/domain/index.ts';
import { DEFAULT_SPLIT_SETTINGS, proposalJudgementHolds, validateSplitProposal } from '../../src/split/index.ts';
import type { SplitJudgementInput, SubjectHashes } from '../../src/split/index.ts';
import { simulateProposal } from '../../src/proposal/index.ts';
import type { JudgedRules, NewTask, TaskJudgement, SimulationOp, ProposalTask } from '../../src/proposal/index.ts';
import { ac, add, dep, HASH, JUDGED, judged, judgement, snapshot, SPLIT_JUDGED, task } from '../proposal/fixtures.ts';
import { original, toSnapshot } from '../proposal/original.ts';

const big = { estimate: { est: 6, lo: 5, hi: 7, confidence: '중' as const }, ac: [ac('1'), ac('2'), ac('3')] };
const world = (patch: Partial<ProposalTask> = {}, status: ProposalTask['status'] = 'ready') =>
  snapshot([task('P'), task('Q'), task('T', status, { ...big, ...patch }), task('S'), task('V')],
    [dep('P', 'T'), dep('Q', 'T', 'SS'), dep('T', 'S'), dep('T', 'V', 'SS')]);
const preds = [{ pred: 'P', type: 'FS' as const }, { pred: 'Q', type: 'SS' as const }];

function cut(first: Partial<NewTask> = {}, second: Partial<NewTask> = {}): SimulationOp[] {
  return [
    add('N1', { ac: [ac('1'), ac('2')], ...first }, preds),
    add('N2', { ac: [ac('3')], ...second }, [{ pred: 'N1', type: 'FS' }]),
    { op: 'dep-add', pred: 'N2', succ: 'S', type: 'FS' }, { op: 'dep-add', pred: 'N2', succ: 'V', type: 'SS' },
    { op: 'remove', task: 'T' },
  ];
}
const hashes = Object.fromEntries(['P', 'Q', 'T', 'S', 'V', 'U', 'TASK-0021', 'TASK-0022', 'TASK-0023'].map(id => [id, HASH]));
const agreed: SplitJudgementInput = { splitSubjectHash: HASH, taskHashes: { before: hashes, after: hashes }, taskJudgements: [],
  splitJudgements: { schemaVersion: 1, items: SPLIT_JUDGED.map(rule => judgement(rule)) } };
const validate = (base: ReturnType<typeof world>, target: string, ops: readonly SimulationOp[], input = agreed) =>
  validateSplitProposal(base, target, ops, input);
const codes = (base: ReturnType<typeof world>, ops: readonly SimulationOp[]) =>
  [...new Set(validate(base, 'T', ops).problems.map(problem => problem.code))];

describe('valid splits', () => {
  test('two parts, relations reconnected, original cancelled with its relations', () => {
    const result = validate(world(), 'T', cut());
    expect(result.problems).toEqual([]);
    expect(result.simulation.next.tasks.find(item => item.id === 'T')?.status).toBe('cancelled');
    expect(result.simulation.next.dependencies.some(item => item.pred === 'T' || item.succ === 'T')).toBe(false);
    expect(result.simulation.next.tasks.at(-1)?.checklist).toHaveLength(1);
    expect(result.simulation.impact.unblockedSuccessors.map(item => [item.taskKey, item.remainingBlockers.length]))
      .toEqual([['S', 1], ['V', 1]]);
  });

  test('uncertain only: an analysis Task in front, original kept', () => {
    const uncertain = { estimate: { est: 3, lo: 2, hi: 4, confidence: '하' as const } };
    const ops: SimulationOp[] = [add('N0', { workType: 'Analysis' }, preds), { op: 'dep-add', pred: 'N0', succ: 'T' }];
    expect(codes(world(uncertain), ops)).toEqual([]);
    expect(codes(world(uncertain), ops.slice(0, 1))).toEqual(['ANALYSIS_REQUIRED', 'RULE_VIOLATION']);
    expect(codes(world(uncertain), [add('N0', {}, preds), { op: 'dep-add', pred: 'N0', succ: 'T' }]))
      .toEqual(['ORIGINAL_NOT_CANCELLED', 'ANALYSIS_REQUIRED', 'RULE_VIOLATION']);
  });

  test('suspicions are warnings, not rejection', () => {
    const result = validate(world(), 'T', cut({ title: 'A/B' }));
    expect(result.problems).toEqual([]);
    expect(result.warnings.map(item => item.message.split(':')[0])).toEqual(['목적이 하나']);
  });

  test('an unsatisfied judgement is itself a reason to cut', () => {
    const small = { estimate: { est: 2, lo: 1.5, hi: 3, confidence: '중' as const } };
    expect(codes(world({ ...small, judgedRules: judged(['revert'], { result: 'not_met' }) }), cut())).toEqual([]);
    expect(codes(world({ ...small, judgedRules: null }), cut())).toEqual(['NOTHING_TO_SPLIT']);
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
    ['successor dropped', cut().filter(op => !(op.op === 'dep-add' && op.succ === 'S')), 'ORDER_NOT_PRESERVED'],
    ['predecessor kept by the first part only', cut().map(op => op.op === 'add' && op.ref === 'N2' ? { ...op, preds: [] } : op),
      'ORDER_NOT_PRESERVED'],
    ['SS predecessor lost by one part', cut().map(op => op.op === 'add' && op.ref === 'N2' ? { ...op, preds: preds.slice(0, 1) } : op),
      'ORDER_NOT_PRESERVED'],
    ['FS successor released before one part ends', cut().map(op => op.op === 'add' && op.ref === 'N2' ? { ...op, preds } : op),
      'ORDER_NOT_PRESERVED'],
    ['SS successor dropped', cut().filter(op => !(op.op === 'dep-add' && op.succ === 'V')), 'ORDER_NOT_PRESERVED'],
    ['FS successor weakened to SS', cut().map(op => op.op === 'dep-add' && op.succ === 'S' ? { ...op, type: 'SS' as const } : op),
      'ORDER_NOT_PRESERVED'],
    ['predecessor dropped', cut().map(op => op.op === 'add' && op.ref === 'N1' ? { ...op, preds: preds.slice(1) } : op),
      'ORDER_NOT_PRESERVED'],
    ['unrelated edit', [...cut(), { op: 'modify', task: 'S', field: 'title', after: 'x' }], 'OUT_OF_SCOPE'],
    ['unrelated relation', [...cut(), { op: 'dep-add', pred: 'S', succ: 'V' }], 'OUT_OF_SCOPE'],
  ] as [string, SimulationOp[], string][])('%s', (_name, ops, code) => {
    expect(codes(world(), ops)).toEqual([code]);
  });
  test('original kept beside its parts', () => {
    expect(codes(world(), cut().slice(0, 4))).toEqual(['ORIGINAL_NOT_CANCELLED', 'RULE_VIOLATION']);
  });
  test('one part only', () => {
    const ops: SimulationOp[] = [add('N1', { ac: big.ac }, preds), { op: 'dep-add', pred: 'N1', succ: 'S' },
      { op: 'dep-add', pred: 'N1', succ: 'V', type: 'SS' }, { op: 'remove', task: 'T' }];
    expect(codes(world(), ops)).toEqual(['TOO_FEW_PARTS']);
  });
  test('simulation holds are passed through; unknown target', () => {
    expect(codes(world(), [...cut(), { op: 'dep-remove', pred: 'N2', succ: 'P' }])).toEqual(['DEPENDENCY_NOT_FOUND']);
    expect(validate(world(), 'NO', cut()).problems.map(item => item.code)).toEqual(['TASK_NOT_FOUND']);
  });
  describe.each(JUDGED)('rule judgement %s', rule => {
    const others = judged(JUDGED.filter(key => key !== rule)).items;
    test.each([['missing', [], 'JUDGEMENT_MISSING'], ['not met', [judgement(rule, { result: 'not_met' })], 'JUDGEMENT_NOT_MET'],
      ['stale', [judgement(rule, { subjectHash: 'old' })], 'JUDGEMENT_MISSING'],
    ] as const)('%s on one new Task holds the split', (_name, own, code) => {
      const judgedRules = { schemaVersion: 1, items: [...others, ...own] } as const;
      expect(validate(world(), 'T', cut({}, { judgedRules })).problems.map(({ code: c, taskKey, rule: r }) => [c, taskKey, r]))
        .toEqual([[code, 'TASK-0022', rule]]);
    });
  });
  describe.each(SPLIT_JUDGED)('split judgement %s', rule => {
    const others = SPLIT_JUDGED.filter(key => key !== rule).map(key => judgement(key));
    test.each([['missing', [], 'JUDGEMENT_MISSING'], ['not met', [judgement(rule, { result: 'not_met' })], 'JUDGEMENT_NOT_MET'],
      ['stale', [judgement(rule, { subjectHash: 'old' })], 'JUDGEMENT_MISSING'],
    ] as const)('%s holds the split', (_name, own, code) => {
      const input: SplitJudgementInput = { ...agreed, splitJudgements: { schemaVersion: 1, items: [...others, ...own] } };
      expect(validate(world(), 'T', cut(), input).problems.map(item => [item.code, item.rule])).toEqual([[code, rule]]);
    });
  });
  test('no split record, or no current hash from the server, holds', () => {
    for (const input of [{ ...agreed, splitJudgements: null }, { ...agreed, splitSubjectHash: null }]) {
      expect(validate(world(), 'T', cut(), input).problems.map(item => item.code)).toEqual(Array(3).fill('JUDGEMENT_MISSING'));
    }
  });
});

describe('any proposal: judgement holds only on added or re-hashed Tasks (D-33)', () => {
  const unjudged = snapshot([task('T', 'ready', { judgedRules: null }), task('O', 'ready', { judgedRules: null })]);
  const holds = (ops: SimulationOp[], after: Record<string, string>, settings = DEFAULT_SPLIT_SETTINGS) =>
    proposalJudgementHolds(unjudged, simulateProposal(unjudged, ops), { before: { T: 'a', O: 'a' }, after }, [], settings);
  test('priority change leaves the hash alone and is not held', () => {
    expect(holds([{ op: 'modify', task: 'T', field: 'priority', after: 0 }], { T: 'a', O: 'a' })).toEqual([]);
  });
  test('changed content, a new Task and an unknown hash are held per enabled rule', () => {
    const title: SimulationOp[] = [{ op: 'modify', task: 'T', field: 'title', after: 'x' }];
    const changed = holds(title, { T: 'b', O: 'a' });
    expect(changed.map(item => [item.code, item.taskKey, item.rule])).toEqual(JUDGED.map(rule => ['JUDGEMENT_MISSING', 'T', rule]));
    expect(holds([add('N', { judgedRules: null })], { T: 'a', O: 'a', 'TASK-0021': HASH })).toHaveLength(3);
    expect(holds([add('N')], { T: 'a', O: 'a', 'TASK-0021': HASH })).toEqual([]);
    expect(holds(title, { O: 'a' })).toHaveLength(3);
    expect(proposalJudgementHolds(unjudged, simulateProposal(unjudged, title), { before: {}, after: {} }, [], DEFAULT_SPLIT_SETTINGS))
      .toHaveLength(6);
    const enabled = { ...DEFAULT_SPLIT_SETTINGS.enabled, revert: false };
    expect(holds(title, { T: 'b', O: 'a' }, { ...DEFAULT_SPLIT_SETTINGS, enabled })).toHaveLength(2);
  });
  test('a Task the proposal cancels needs no judgement', () => {
    expect(holds([{ op: 'remove', task: 'T' }], { O: 'a' })).toEqual([]);
  });
});

describe('taskJudgements: judgement of existing Tasks carried by the CP (data-model §2.3-1)', () => {
  const at = (subjectHash: string, result: 'met' | 'not_met' = 'met') => judged(JUDGED, { subjectHash, result });
  const title: SimulationOp[] = [{ op: 'modify', task: 'T', field: 'title', after: 'x' }];
  const run = (stored: JudgedRules | null, taskJudgements: readonly TaskJudgement[], ops = title, hashes: SubjectHashes =
  { before: { T: 'before' }, after: { T: 'after', 'TASK-0021': 'new' } }) => {
    const base = snapshot([task('T', 'ready', { judgedRules: stored })]);
    const copy = structuredClone(base);
    const simulation = simulateProposal(base, ops);
    const next = structuredClone(simulation.next);
    const holds = proposalJudgementHolds(base, simulation, hashes, taskJudgements, DEFAULT_SPLIT_SETTINGS);
    expect(base).toEqual(copy);
    expect(simulation.next).toEqual(next);
    return [...new Set(holds.map(item => item.code))];
  };
  const of = (judgedRules: JudgedRules | null, taskKey = 'T'): TaskJudgement => ({ taskKey, judgedRules });

  test('the CP record wins over the stored one, both ways', () => {
    expect(run(at('before'), [of(at('after'))])).toEqual([]);
    expect(run(null, [of(at('after'))])).toEqual([]);
    expect(run(at('after'), [of(at('after', 'not_met'))])).toEqual(['JUDGEMENT_NOT_MET']);
    expect(run(at('after', 'not_met'), [of(at('after'))])).toEqual([]);
  });
  test('without a CP record the stored one is used, against the after hash too', () => {
    expect(run(at('after'), [])).toEqual([]);
    expect(run(at('before'), [])).toEqual(['JUDGEMENT_MISSING']);
  });
  test.each([['stale', at('older')], ['before', at('before')], ['empty', null]])('a CP record with %s hash is missing, with no fallback', (_name, record) => {
    expect(run(at('after'), [of(record)])).toEqual(['JUDGEMENT_MISSING']);
  });
  test('a duplicate taskKey is rejected and voids the record instead of falling back', () => {
    expect(run(at('after'), [of(at('after')), of(at('after'))])).toEqual(['VALIDATION_FAILED', 'JUDGEMENT_MISSING']);
  });
  describe('the whole array is validated before any Task or rule filter', () => {
    const all = ['VALIDATION_FAILED'];
    const same = { before: { T: 'before', O: 'o' }, after: { T: 'before', O: 'o', 'TASK-0021': 'new' } };
    const changed = { ...same, after: { ...same.after, T: 'after' } };
    const priority: SimulationOp[] = [{ op: 'modify', task: 'T', field: 'priority', after: 0 }];
    const holds = (ops: SimulationOp[], list: readonly unknown[], hashes: SubjectHashes, settings = DEFAULT_SPLIT_SETTINGS) => {
      const base = snapshot([task('T', 'ready', { judgedRules: at('after') }), task('O'), task('D', 'done')]);
      return proposalJudgementHolds(base, simulateProposal(base, ops),
        { before: { ...hashes.before, D: 'd' }, after: { ...hashes.after, D: 'd' } }, list as TaskJudgement[], settings);
    };
    const rejected = (...args: Parameters<typeof holds>) => holds(...args).map(item => [item.code, item.taskKey]);
    test.each([['unchanged Task', 'O'], ['unknown Task', 'TASK-9999'], ['done Task', 'D']])('%s: single or duplicate', (_name, key) => {
      expect(rejected(title, [of(at('o'), key)], changed)).toEqual([['VALIDATION_FAILED', key]]);
      expect(rejected(title, [of(at('o'), key), of(at('o'), key)], changed)).toEqual([['VALIDATION_FAILED', key]]);
    });
    test('priority-only: the change itself passes, a stray or duplicate judgement does not', () => {
      expect(rejected(priority, [], same)).toEqual([]);
      expect(rejected(priority, [of(at('before'))], same)).toEqual([['VALIDATION_FAILED', 'T']]);
      expect(rejected(priority, [of(null), of(null)], same)).toEqual([['VALIDATION_FAILED', 'T']]);
    });
    test('all judge rules off', () => {
      const enabled = { ...DEFAULT_SPLIT_SETTINGS.enabled, revert: false, contract: false, refactor: false };
      const off = { ...DEFAULT_SPLIT_SETTINGS, enabled };
      expect(rejected(title, [of(at('after'))], changed, off)).toEqual([]);
      expect(rejected(title, [of(at('after')), of(at('after'))], changed, off)).toEqual([['VALIDATION_FAILED', 'T']]);
    });
    test('a new Task by ref or assigned ID, and a Task the proposal cancels', () => {
      for (const key of ['N', 'TASK-0021']) {
        expect(rejected([add('N', { judgedRules: at('new') })], [of(at('new'), key)], same)).toEqual([['VALIDATION_FAILED', key]]);
      }
      expect(rejected([{ op: 'remove', task: 'T' }], [of(at('before'))], same)).toEqual([['VALIDATION_FAILED', 'T']]);
    });
    test('a key-less entry, next to a valid one', () => {
      for (const bad of [null, {}, { taskKey: 1 }]) {
        expect(holds(title, [of(at('after')), bad], changed).map(item => item.code)).toEqual(all);
      }
    });
    test('a split proposal reports it as a problem', () => {
      const input: SplitJudgementInput = { ...agreed, taskJudgements: [of(at(HASH), 'S'), of(at(HASH), 'S')] };
      expect(validate(world(), 'T', cut(), input).problems.map(item => [item.code, item.taskKey])).toEqual([['VALIDATION_FAILED', 'S']]);
    });
  });
  test('no after hash from the server is missing, no before hash still judges the after content', () => {
    expect(run(null, [of(at('after'))], title, { before: { T: 'before' }, after: {} })).toEqual(['JUDGEMENT_MISSING']);
    expect(run(null, [of(at('after'))], title, { before: {}, after: { T: 'after' } })).toEqual([]);
    expect(run(null, [], title, { before: {}, after: { T: 'after' } })).toEqual(['JUDGEMENT_MISSING']);
  });
  test('validateSplitProposal applies the same input', () => {
    const input = (taskJudgements: readonly TaskJudgement[]): SplitJudgementInput =>
      ({ ...agreed, taskJudgements, taskHashes: { before: { ...hashes, S: 'old' }, after: hashes } });
    const base = world();
    const unjudged = { ...base, tasks: base.tasks.map(item => item.id === 'S' ? { ...item, judgedRules: null } : item) };
    expect(validate(unjudged, 'T', cut(), input([])).problems.map(item => [item.code, item.taskKey]))
      .toEqual(Array(3).fill(['JUDGEMENT_MISSING', 'S']));
    expect(validate(unjudged, 'T', cut(), input([of(at(HASH), 'S')])).problems).toEqual([]);
  });
});

describe('execution order (owner decision): equivalent indirect paths pass, lost order holds', () => {
  const edit = (ref: string, list: typeof preds) => (op: SimulationOp): SimulationOp =>
    op.op === 'add' && op.ref === ref ? { ...op, preds: list } : op;
  test('parallel parts, each fully reconnected', () => {
    const ops = [...cut().map(edit('N2', preds)), { op: 'dep-add', pred: 'N1', succ: 'S' } as const];
    expect(codes(world(), ops)).toEqual([]);
  });
  test('successor and predecessor order kept only through another Task', () => {
    const base = world();
    const indirect = { ...base, tasks: [...base.tasks, task('U')],
      dependencies: [...base.dependencies, dep('T', 'U'), dep('U', 'S')] };
    const ops = cut().map(op => op.op === 'dep-add' && op.succ === 'S' ? { ...op, succ: 'U' } : op);
    expect(codes(indirect, ops)).toEqual([]);
    expect(codes(indirect, ops.map(op => op.op === 'dep-add' && op.succ === 'U' ? { ...op, type: 'SS' as const } : op)))
      .toEqual(['ORDER_NOT_PRESERVED']);
  });
  test('an SS predecessor may be strengthened to FS, an FS one not weakened to SS', () => {
    const swap = (type: 'FS' | 'SS') => cut().map(edit('N1', [{ pred: 'P', type }, { pred: 'Q', type: 'FS' }]));
    expect(codes(world(), swap('FS'))).toEqual([]);
    expect(codes(world(), swap('SS'))).toEqual(['ORDER_NOT_PRESERVED']);
  });
  test.each([['P', 'done', 'FS'], ['Q', 'running', 'SS']] as const)('%s already met (%s) need not be reconnected', (id, status, type) => {
    const base = world();
    const met = { ...base, tasks: base.tasks.map(item => item.id === id ? task(id, status) : item) };
    const ops = cut().map(edit('N1', preds.filter(pred => pred.pred !== id)));
    expect(codes(met, ops)).toEqual([]);
    expect(codes(base, ops)).toEqual(['ORDER_NOT_PRESERVED']);
    const other = { ...met, dependencies: met.dependencies.map(item => item.pred === id ? { ...item, type: 'FS' as const } : item) };
    if (type === 'SS') expect(codes(other, ops)).toEqual(['ORDER_NOT_PRESERVED']);
  });
  test('a kept original may move its predecessor behind research, not lose it', () => {
    const kept = { estimate: { est: 3, lo: 2, hi: 4, confidence: '하' as const } };
    const ops = (list: typeof preds): SimulationOp[] => [add('R', { workType: 'Analysis' }, list),
      { op: 'dep-add', pred: 'R', succ: 'T' }, { op: 'dep-remove', pred: 'P', succ: 'T' }];
    expect(codes(world(kept), ops(preds))).toEqual([]);
    expect(codes(world(kept), ops(preds.slice(1)))).toEqual(['ORDER_NOT_PRESERVED']);
    expect(codes(world(kept), [...ops(preds), { op: 'dep-remove', pred: 'T', succ: 'S' }])).toEqual(['ORDER_NOT_PRESERVED']);
  });
});

describe('research must really precede the result (G§5.2-1 rule 10)', () => {
  const uncertain = { estimate: { ...big.estimate, confidence: '하' as const } };
  const research = add('R', { workType: 'Analysis' }, preds);
  const after = (pred: string, type: 'FS' | 'SS' = 'FS') => ({ pred, type });
  const plan = (first: typeof preds, second: typeof preds, rest: SimulationOp[] = []): SimulationOp[] =>
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
  const convert = (raw: unknown): SimulationOp => {
    const op = raw as Old;
    if (op.op !== 'add' || !op.t) return raw as SimulationOp;
    const { wp, est, lo, hi, type, domain, rel, basis, conf, ...rest } = op.t;
    return { ...op, op: 'add', workPackageId: wp, task: { ...rest, workType: type, primaryDomain: domain, relatedDomains: rel,
      splitBasis: basis, estimate: { est, lo, hi, confidence: conf } } as unknown as NewTask } as SimulationOp;
  };
  const all = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`TASK-${String(i + 1).padStart(4, '0')}`, HASH]));
  const run = (id: string) => validateSplitProposal(base, id, original.splitOps(data, id).map(convert),
    { splitJudgements: null, splitSubjectHash: null, taskHashes: { before: all, after: all }, taskJudgements: [] });
  // TASK-0009/0011: uncertain only. TASK-0008: 6h and uncertain, so also cut in two.
  // The mock records no Planning judgement, so after the owner decision that is the only thing left to hold on.
  expect(original.splitOps(data, 'TASK-0008')).toHaveLength(5);
  for (const id of ['TASK-0008', 'TASK-0009', 'TASK-0011']) {
    expect([...new Set(run(id).problems.map(problem => problem.code))], id).toEqual(['JUDGEMENT_MISSING']);
  }
});
