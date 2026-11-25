import { describe, expect, test } from 'vitest';
import { checkSplit, DEFAULT_SPLIT_SETTINGS, SPLIT_RULES, splitExceptionProblem, summarizeSplit } from '../../src/split/index.ts';
import type { SplitRule } from '../../src/split/index.ts';
import type { ProposalTask } from '../../src/proposal/index.ts';
import { TASK_STATUSES } from '../../src/domain/index.ts';
import { task } from '../proposal/fixtures.ts';
import { original, toTask } from '../proposal/original.ts';

const status = (rule: SplitRule, patch: Partial<ProposalTask> = {}, preds: { workType: ProposalTask['workType'] }[] = []) =>
  checkSplit(task('T', 'ready', patch), preds).items.find(item => item.rule === rule)?.status;
const est = (value: number, lo: number, hi: number, confidence: '상' | '중' | '하' = '중') =>
  ({ estimate: { est: value, lo, hi, confidence } });
const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
const design = (...kinds: ('DB' | 'API' | 'FE' | 'DevOps')[]) => ({ design: kinds.map(kind => ({ kind, items: ['x'] })) });

test('rules, order, labels, modes and limits are the original ones', () => {
  expect(SPLIT_RULES.map(rule => [rule.key, rule.label, rule.mode])).toEqual(original.rules.map(x => [x[0], x[1], x[3]]));
  expect({ maxH: DEFAULT_SPLIT_SETTINGS.maxHours, minH: DEFAULT_SPLIT_SETTINGS.minHours, maxFiles: DEFAULT_SPLIT_SETTINGS.maxFiles,
    on: DEFAULT_SPLIT_SETTINGS.enabled }).toEqual({ maxH: original.splitDefaults.maxH, minH: original.splitDefaults.minH,
    maxFiles: original.splitDefaults.maxFiles, on: original.splitDefaults.on });
});

describe('ten rules at their boundaries', () => {
  test.each([
    ['one', { title: 'A 및 B' }, '의심'], ['one', { title: 'A 그리고 B' }, '의심'], ['one', { title: 'A/B' }, '의심'],
    ['one', { title: 'A + B' }, '의심'], ['one', { title: 'C++ 및정' }, '통과'],
    ['domain', design('API', 'FE'), '의심'], ['domain', { workType: 'Configuration', ...design('API', 'FE') }, '의심'],
    ['domain', { workType: 'Design', ...design('API', 'FE') }, '통과'], ['domain', design('FE'), '통과'],
    ['domain', { design: [{ kind: 'FE', items: ['x'] }, { kind: 'DB', items: [] }] }, '통과'],
    ['size', est(4, 3, 5), '통과'], ['size', est(4.01, 3, 5), '위반'], ['size', est(0.5, 0.5, 0.5), '통과'],
    ['size', est(0.49, 0.4, 0.5), '주의'], ['size', { files: files(8) }, '통과'], ['size', { files: files(9) }, '위반'],
    ['size', { estimate: null }, '주의'], ['size', { estimate: null, files: files(9) }, '위반'],
    ['verify', { ac: [], checklist: [] }, '위반'], ['verify', { ac: [], checklist: [], status: 'planning' }, '주의'],
    ['verify', { ac: [] }, '통과'], ['verify', { checklist: [] }, '통과'],
    ['cg', { conflictGroup: 'M' }, '통과'],
    ['irrev', design('DB'), '의심'], ['irrev', { primaryDomain: 'DB', ...design('DB') }, '통과'],
    ['irrev', { workType: 'Design', ...design('DB') }, '통과'],
    ['unknown', est(2, 1.5, 3, '하'), '위반'], ['unknown', est(2, 1, 3.1), '위반'], ['unknown', est(2.5, 2, 5), '통과'],
    ['unknown', est(1, 0.5, 2.5), '통과'],
  ] as [SplitRule, Partial<ProposalTask>, string][])('%s %j → %s', (rule, patch, expected) => {
    expect(status(rule, patch)).toBe(expected);
  });

  test('a preceding analysis Task satisfies 「불확실하면 조사부터」, another kind does not', () => {
    expect(status('unknown', est(2, 1.5, 3, '하'), [{ workType: 'Analysis' }])).toBe('통과');
    expect(status('unknown', est(2, 1.5, 3, '하'), [{ workType: 'Design' }])).toBe('위반');
  });

  test.each(['revert', 'contract', 'refactor'] as const)('%s never claims an unrecorded agreement', rule => {
    const missing = checkSplit(task('T'), []).items.find(item => item.rule === rule);
    expect(missing).toMatchObject({ status: '판단', judgementMissing: true });
    const recorded = checkSplit(task('T', 'ready', { judgements: [{ rule, why: '단독 커밋', by: 'Codex · Claude 합의' }] }), []);
    expect(recorded.items.find(item => item.rule === rule)).toMatchObject({ status: '판단', judgementMissing: false,
      detail: '단독 커밋 (Codex · Claude 합의)' });
  });
});

test('off beats exception, exception replaces only violation/suspicion, settings are honoured', () => {
  const exception = { rule: 'size', why: '이유', by: '합의', at: 'now' };
  const big = task('T', 'running', { ...est(6, 5, 7), exceptions: [exception] });
  expect(checkSplit(big, []).items[2]?.status).toBe('예외');
  expect(checkSplit({ ...big, ...est(2, 1.5, 3) }, []).items[2]?.status).toBe('통과');
  const off = { ...DEFAULT_SPLIT_SETTINGS, enabled: { ...DEFAULT_SPLIT_SETTINGS.enabled, size: false } };
  expect(checkSplit(big, [], off).items[2]?.status).toBe('꺼짐');
  expect(checkSplit({ ...big, exceptions: [] }, [], { ...DEFAULT_SPLIT_SETTINGS, maxHours: 6 }).items[2]?.status).toBe('통과');
});

test('summary counts each Task once, violation first', () => {
  const ok = checkSplit(task('A'), []);
  const suspect = checkSplit(task('B', 'ready', { title: 'A/B' }), []);
  const both = checkSplit(task('C', 'ready', { title: 'A/B', ...est(6, 5, 7) }), []);
  expect(both).toMatchObject({ violations: 1, suspicions: 1 });
  expect(summarizeSplit([ok, suspect, both])).toEqual({ passed: 1, suspicions: 1, violations: 1, exceptions: 0 });
});

test('exceptions need a started Task, a flagged rule and a reason', () => {
  const big = est(6, 5, 7);
  const entry = { rule: 'size', why: '작음', by: '합의', at: 'now' };
  const problem = (subject: ProposalTask, value = entry) => splitExceptionProblem(subject, checkSplit(subject, []), value);
  for (const state of TASK_STATUSES) {
    const started = !['planning', 'approval', 'ready'].includes(state);
    expect(problem(task('T', state, big)) === null, state).toBe(started);
  }
  expect(problem(task('T', 'running'))).not.toBeNull();
  expect(problem(task('T', 'running', big), { ...entry, why: ' ' })).not.toBeNull();
});

test('all original Tasks, and perturbed copies, get the original rule statuses', () => {
  const data = original.load();
  const variants: Record<string, unknown>[] = [{}, { title: 'A 및 B' }, { est: 9 }, { est: 0.2, lo: 0.1, hi: 0.3 }, { conf: '하' },
    { lo: 1, hi: 9 }, { status: 'planning' }, { status: 'ready', checklist: [] }, { type: 'Implementation' }, { type: 'Configuration' }];
  let flagged = 0;
  for (const source of Object.values(data.tasks)) {
    for (const variant of variants) {
      for (const bare of [false, true]) {
        const t = { ...source, ...variant, spec: { ...source.spec, ac: bare ? [] : source.spec.ac, files: source.spec.files ?? [] } };
        const preds = data.deps.filter(d => d.succ === t.id).map(d => ({ workType: data.tasks[d.pred]?.type ?? 'Design' }));
        const old = original.splitCheck(data, t);
        const now = checkSplit(toTask(t, data), preds);
        expect(now.items.map(item => [item.rule, item.status])).toEqual(old.items.map(item => [item.k, item.st]));
        expect([now.violations, now.suspicions, now.cautions, now.exceptions]).toEqual([old.viol, old.sus, old.warn, old.exc]);
        flagged += old.viol + old.sus;
      }
    }
  }
  expect(flagged).toBeGreaterThan(50);
});
