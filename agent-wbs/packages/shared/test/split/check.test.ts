import { describe, expect, test } from 'vitest';
import { checkSplit, DEFAULT_SPLIT_SETTINGS, SPLIT_RULES, splitExceptionProblem, summarizeSplit } from '../../src/split/index.ts';
import type { SplitRule } from '../../src/split/index.ts';
import type { JudgedRules, ProposalTask } from '../../src/proposal/index.ts';
import { WORK_TYPES } from '../../src/proposal/types.ts';
import { TASK_STATUSES } from '../../src/domain/index.ts';
import { HASH, JUDGED, judged, judgement, task } from '../proposal/fixtures.ts';
import { original, toTask } from '../proposal/original.ts';

const status = (rule: SplitRule, patch: Partial<ProposalTask> = {}, preds: { workType: ProposalTask['workType'] }[] = []) =>
  checkSplit(task('T', 'ready', patch), preds, HASH).items.find(item => item.rule === rule)?.status;
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
    ...WORK_TYPES.map(workType => ['domain', { workType, ...design('DB', 'FE') }, '의심']),
    ['domain', { workType: 'Design', ...design('FE') }, '통과'], ['domain', design('FE'), '통과'],
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
    ['unknown', est(1, 0.5, 2.5), '통과'], ['unknown', est(1, 0.5, 2.51), '위반'],
    ['unknown', est(1, 0, 3), '위반'], ['unknown', est(1, 0, 2), '통과'],
    ['unknown', { estimate: { est: 1, lo: null, hi: 3, confidence: '중' } }, '통과'],
    ['unknown', { estimate: { est: 1, lo: null, hi: 3.01, confidence: '중' } }, '위반'],
    ['unknown', { estimate: { est: 4, lo: 0, hi: null, confidence: '중' } }, '위반'],
  ] as [SplitRule, Partial<ProposalTask>, string][])('%s %j → %s', (rule, patch, expected) => {
    expect(status(rule, patch)).toBe(expected);
  });

  test('a preceding analysis Task satisfies 「불확실하면 조사부터」, another kind does not', () => {
    expect(status('unknown', est(2, 1.5, 3, '하'), [{ workType: 'Analysis' }])).toBe('통과');
    expect(status('unknown', est(2, 1.5, 3, '하'), [{ workType: 'Design' }])).toBe('위반');
  });

  describe.each(JUDGED)('%s: D-33 recorded judgement', rule => {
    const others = judged(JUDGED.filter(key => key !== rule)).items;
    const check = (items: unknown, hash: string | null = HASH, schemaVersion = 1, patch: Partial<ProposalTask> = {}) =>
      checkSplit(task('T', 'ready', { ...patch, judgedRules: { schemaVersion, items } as unknown as JudgedRules }), [], hash);
    test.each([
      ['met', {}, 'met'], ['not met', { result: 'not_met' }, 'not_met'], ['one Agent', { agreedBy: ['Claude'] }, 'missing'],
      ['same Agent twice', { agreedBy: ['Codex', 'Codex'] }, 'missing'],
      ['extra Agent', { agreedBy: ['Claude', 'Codex', 'Other'] }, 'missing'],
      ['stale hash', { subjectHash: 'old' }, 'missing'], ['blank basis', { basis: ' ' }, 'missing'],
      ['unknown result', { result: 'maybe' }, 'missing'], ['no source', { sourceRef: '' }, 'missing'],
      ['local time', { judgedAt: '2026-11-25T00:00:00+09:00' }, 'missing'], ['bad time', { judgedAt: '2026-13-25T00:00:00Z' }, 'missing'],
      ...['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-04-31T12:00:00.5Z', '2026-11-25T24:00:00Z', '2026-11-25T23:59:60Z']
        .map(judgedAt => [judgedAt, { judgedAt }, 'missing'] as const),
      ...['2028-02-29T00:00:00Z', '2026-11-25T00:00:00+00:00', '2026-11-25T23:59:59.9999999Z', '2026-11-25T23:59:59.123456Z'].map(judgedAt => [judgedAt, { judgedAt }, 'met'] as const),
    ])('%s', (_name, patch, expected) => {
      const result = check([...others, { ...judgement(rule), ...patch }]);
      expect(result.items.find(item => item.rule === rule)).toMatchObject({ status: '판단', judgement: expected });
      expect(result.approvalHolds).toEqual(expected === 'met' ? [] : [rule]);
    });
    test('absent, duplicated, hashless or malformed records are no record', () => {
      const one = judgement(rule);
      expect(check(others).approvalHolds).toEqual([rule]);
      expect(check([...others, one, { ...one, result: 'not_met' }]).approvalHolds).toEqual([rule]);
      expect(check([...others, one], null).approvalHolds).toContain(rule);
      expect(check([...others, one], HASH, 2).approvalHolds).toContain(rule);
      expect(check([...others, null]).approvalHolds).toEqual([rule]);
      expect(check('x').approvalHolds).toContain(rule);
      expect(checkSplit(task('T', 'ready', { judgedRules: null }), [], HASH).approvalHolds).toContain(rule);
    });
    test('text carries result, basis and both Agents; an exception does not replace it', () => {
      const result = check([...others, judgement(rule, { result: 'not_met', basis: '사용처와 함께 수정' })], HASH, 1,
        { exceptions: [{ rule, why: 'x', by: 'y', at: 'z' }] });
      expect(result.items.find(item => item.rule === rule)).toMatchObject({ status: '판단', detail: '불충족 — 사용처와 함께 수정 (Claude · Codex)' });
      expect(result.approvalHolds).toEqual([rule]);
    });
    test('a disabled rule does not hold', () => {
      const enabled = { ...DEFAULT_SPLIT_SETTINGS.enabled, [rule]: false };
      expect(checkSplit(task('T', 'ready', { judgedRules: null }), [], HASH, { ...DEFAULT_SPLIT_SETTINGS, enabled }).approvalHolds)
        .not.toContain(rule);
    });
  });
});

test('off beats exception, exception replaces only violation/suspicion, settings are honoured', () => {
  const exception = { rule: 'size', why: '이유', by: '합의', at: 'now' };
  const big = task('T', 'running', { ...est(6, 5, 7), exceptions: [exception] });
  expect(checkSplit(big, [], HASH).items[2]?.status).toBe('예외');
  expect(checkSplit({ ...big, ...est(2, 1.5, 3) }, [], HASH).items[2]?.status).toBe('통과');
  const off = { ...DEFAULT_SPLIT_SETTINGS, enabled: { ...DEFAULT_SPLIT_SETTINGS.enabled, size: false } };
  expect(checkSplit(big, [], HASH, off).items[2]?.status).toBe('꺼짐');
  expect(checkSplit({ ...big, exceptions: [] }, [], HASH, { ...DEFAULT_SPLIT_SETTINGS, maxHours: 6 }).items[2]?.status).toBe('통과');
});

test('summary counts each Task once, violation first', () => {
  const ok = checkSplit(task('A'), [], HASH);
  const suspect = checkSplit(task('B', 'ready', { title: 'A/B' }), [], HASH);
  const both = checkSplit(task('C', 'ready', { title: 'A/B', ...est(6, 5, 7) }), [], HASH);
  expect(both).toMatchObject({ violations: 1, suspicions: 1 });
  expect(summarizeSplit([ok, suspect, both])).toEqual({ passed: 1, suspicions: 1, violations: 1, exceptions: 0, approvalHeld: 0 });
  const held = checkSplit(task('D', 'ready', { judgedRules: null }), [], HASH);
  expect(summarizeSplit([ok, held])).toEqual({ passed: 2, suspicions: 0, violations: 0, exceptions: 0, approvalHeld: 1 });
});

test('exceptions need a started Task, a flagged rule and a reason', () => {
  const big = est(6, 5, 7);
  const entry = { rule: 'size', why: '작음', by: '합의', at: 'now' };
  const problem = (subject: ProposalTask, value = entry) => splitExceptionProblem(subject, checkSplit(subject, [], HASH), value);
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
        const now = checkSplit(toTask(t, data), preds, HASH);
        expect(now.items.map(item => [item.rule, item.status])).toEqual(old.items.map(item => [item.k, item.st]));
        expect([now.violations, now.suspicions, now.cautions, now.exceptions]).toEqual([old.viol, old.sus, old.warn, old.exc]);
        flagged += old.viol + old.sus;
      }
    }
  }
  expect(flagged).toBeGreaterThan(50);
});
