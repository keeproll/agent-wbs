import { createHash } from 'node:crypto';
import { DEFAULT_SPLIT_SETTINGS } from '@awbs/shared';
import { OPERATIONS } from '@awbs/shared/api';
import { describe, expect, test } from 'vitest';
import { draftErrors, draftHolds, draftSplitSummary, storeDraft } from '../src/project/draft.ts';
import { canonicalJson, judgedContent, subjectHash } from '../src/project/hash.ts';
import { mergeChanges, nextMdList } from '../src/project/inputs.ts';
import { parseRepoUrl } from '../src/project/repo.ts';
import { bootPhase, BOOT_STEPS } from '../src/project/steps.ts';
import { draft, met, task } from './project-fixture.ts';

describe('project 저장소 주소', () => {
  test('저장소까지만 받고 .git·끝 슬래시를 떼어 정규화한다', () => {
    expect(parseRepoUrl('https://github.com/acme/web.git')).toEqual({ url: 'https://github.com/acme/web', owner: 'acme', name: 'web' });
    expect(parseRepoUrl('https://github.com/acme/web/')).toEqual({ url: 'https://github.com/acme/web', owner: 'acme', name: 'web' });
  });
  test.each(['https://github.com/acme/..', 'https://github.com/acme/.', 'https://github.com/acme/.git', 'https://github.com/acme/web/tree/main'])(
    '저장소 이름이 아닌 %s 는 거부한다', (url) => {
      expect(() => parseRepoUrl(url)).toThrow();
    });
});

describe('project 초안 검증(순환·참조·필수, contracts §3.3)', () => {
  test('올바른 초안은 오류가 없다', () => {
    expect(draftErrors(draft())).toEqual([]);
  });
  test('참조 오류를 경로와 함께 모두 돌려준다', () => {
    const bad = draft([task('t1', { wpRef: 'nope' }), task('t1')], [{ predRef: 't1', succRef: 'zz', depType: 'FS' }]);
    bad.wps.push({ ref: 'wp2', phaseRef: 'missing', title: 'x' });
    const rules = draftErrors(bad).map((e) => `${e.path}:${e.rule}`);
    expect(rules).toEqual(expect.arrayContaining(['wps.1.phaseRef:reference', 'tasks.0.wpRef:reference', 'tasks.1.ref:unique', 'deps.0.succRef:reference']));
  });
  test('자기 참조·중복 의존성·순환은 거부한다', () => {
    expect(draftErrors(draft(undefined, [{ predRef: 't1', succRef: 't1', depType: 'FS' }])).map((e) => e.rule)).toEqual(['dependencySelf']);
    expect(draftErrors(draft(undefined, [{ predRef: 't1', succRef: 't2', depType: 'FS' }, { predRef: 't1', succRef: 't2', depType: 'SS' }])).map((e) => e.rule)).toEqual(['dependencyDuplicate']);
    const cycle = draftErrors(draft([task('t1'), task('t2'), task('t3')], [
      { predRef: 't1', succRef: 't2', depType: 'FS' }, { predRef: 't2', succRef: 't3', depType: 'SS' }, { predRef: 't3', succRef: 't1', depType: 'FS' }]));
    expect(cycle).toEqual([expect.objectContaining({ rule: 'dependencyCycle', path: 'deps.2' })]);
  });
  test('주 영역을 관련 영역에 넣거나 같은 규칙 판단을 두 번 적으면 거부한다', () => {
    expect(draftErrors(draft([task('t1', { relatedDomains: ['BE'] }), task('t2')])).map((e) => `${e.path}:${e.rule}`)).toEqual(['tasks.0.relatedDomains:primaryDomain']);
    const twice = task('t1', { judgedRules: { schemaVersion: 1, items: [met('revert'), met('revert')] } });
    expect(draftErrors(draft([twice, task('t2')])).map((e) => `${e.path}:${e.rule}`)).toEqual(['tasks.0.judgedRules:uniqueRule']);
  });
  test('Phase·Work Package 참조 이름이 겹치면 거부한다', () => {
    const bad = draft();
    bad.phases.push({ ref: 'ph1', title: '중복' });
    expect(draftErrors(bad).map((e) => `${e.path}:${e.rule}`)).toEqual(['phases.1.ref:unique']);
  });
});

describe('project 판단 대상 hash(data-model §2.3-1)', () => {
  const source = { title: 'A', overview: { purpose: 'p', background: 'b', scope: ['s'], out: [], precond: 'x', doneCond: 'd' },
    spec: {}, ac: [], outputs: [{ name: 'b', kind: 'k', required: true, verify: 'v', delivered: true }, { name: 'a', kind: 'k', required: false, verify: '', delivered: false }],
    designs: [], conflictGroup: null };
  test('정렬된 JSON의 SHA-256이고 목적·배경·선행 조건·제출 여부는 포함하지 않는다', () => {
    const expected = createHash('sha256').update(canonicalJson(judgedContent(source))).digest('hex');
    expect(subjectHash(source)).toBe(expected);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
    const same = { ...source, overview: { ...source.overview, purpose: '다름', background: '다름', precond: '다름' },
      outputs: source.outputs.map((o) => ({ ...o, delivered: !o.delivered })).reverse() };
    expect(subjectHash(same)).toBe(subjectHash(source));
  });
  test('완료 조건이 바뀌면 hash도 바뀐다', () => {
    expect(subjectHash({ ...source, overview: { ...source.overview, doneCond: 'd2' } })).not.toBe(subjectHash(source));
  });
  test('초안 저장 때 각 판단에 서버가 계산한 hash를 붙인다(요청에는 없음)', () => {
    const stored = storeDraft(draft());
    const [first] = stored.tasks;
    expect(first?.judgedRules?.items.every((item) => item.subjectHash === first.subjectHash)).toBe(true);
    expect(first?.subjectHash).toMatch(/^[0-9a-f]{64}$/);
  });
  test('우선순위·담당은 hash에 들어가지 않는다', () => {
    const a = storeDraft(draft([task('t1'), task('t2')])).tasks[0]?.subjectHash;
    const b = storeDraft(draft([task('t1', { priority: 3, assigneeAgent: 'Codex' }), task('t2')])).tasks[0]?.subjectHash;
    expect(a).toBe(b);
  });
});

describe('project 초기 WBS 승인의 판단 보류(D-33)', () => {
  test('두 Agent가 합의한 충족 기록이 현재 hash와 맞으면 보류가 없다', () => {
    expect(draftHolds(storeDraft(draft()), DEFAULT_SPLIT_SETTINGS)).toEqual([]);
  });
  test('기록 없음·불충족·합의 1인·낡은 hash는 모두 보류다', () => {
    const notMet = task('t1', { judgedRules: { schemaVersion: 1, items: [{ ...met('revert'), result: 'not_met' }, met('contract'), met('refactor')] } });
    const single = task('t2', { judgedRules: { schemaVersion: 1, items: [{ ...met('revert'), agreedBy: ['Claude'] }, met('contract'), met('refactor')] } });
    const none = task('t3', { judgedRules: undefined });
    const stored = storeDraft(draft([notMet, single, none], []));
    // 저장 뒤 내용이 바뀐 것처럼 hash를 낡게 만든다.
    const stale = storeDraft(draft([task('t4')], []));
    const t4 = stale.tasks[0];
    if (t4?.judgedRules) t4.judgedRules = { ...t4.judgedRules, items: t4.judgedRules.items.map((i) => ({ ...i, subjectHash: '0'.repeat(64) })) };
    const holds = [...draftHolds(stored, DEFAULT_SPLIT_SETTINGS), ...draftHolds(stale, DEFAULT_SPLIT_SETTINGS)];
    expect(holds.map((h) => `${h.ref}:${h.rule}:${h.code}`)).toEqual([
      't1:revert:JUDGEMENT_NOT_MET', 't2:revert:JUDGEMENT_MISSING',
      't3:revert:JUDGEMENT_MISSING', 't3:contract:JUDGEMENT_MISSING', 't3:refactor:JUDGEMENT_MISSING',
      't4:revert:JUDGEMENT_MISSING', 't4:contract:JUDGEMENT_MISSING', 't4:refactor:JUDGEMENT_MISSING',
    ]);
  });
  test('승인 때는 저장된 hash가 아니라 지금 내용으로 다시 계산해 대조한다', () => {
    const stored = storeDraft(draft());
    const first = stored.tasks[0];
    if (first) { first.title = '저장 뒤 바뀐 제목'; }
    expect(draftHolds(stored, DEFAULT_SPLIT_SETTINGS).map((h) => `${h.ref}:${h.rule}`)).toEqual(['t1:revert', 't1:contract', 't1:refactor']);
  });
  test('꺼진 규칙은 판단을 요구하지 않는다', () => {
    const settings = { ...DEFAULT_SPLIT_SETTINGS, enabled: { ...DEFAULT_SPLIT_SETTINGS.enabled, revert: false, contract: false, refactor: false } };
    expect(draftHolds(storeDraft(draft([task('t1', { judgedRules: undefined })], [])), settings)).toEqual([]);
  });
  test('분할 점검 요약은 Task마다 한 번, 위반을 먼저 센다', () => {
    const big = task('t2', { estimate: { estHours: 9, loHours: 8, hiHours: 10, confidence: '중', basis: 'b', agreedBy: ['Claude'] } });
    expect(draftSplitSummary(storeDraft(draft([task('t1'), big], [])), DEFAULT_SPLIT_SETTINGS)).toEqual({ pass: 1, suspect: 0, violation: 1 });
  });
});

describe('project 초기 분석 단계(data-model §3.4)', () => {
  const steps = (done: number, run?: string) => BOOT_STEPS.map((key, index) => ({ key, status: index < done ? 'done' as const : key === run ? 'run' as const : 'wait' as const }));
  test('기술 결정·초안·승인 대기를 단계 진행으로 구분한다', () => {
    expect(bootPhase(steps(0))).toBe('analyzing');
    expect(bootPhase(steps(6, 'tech'))).toBe('tech_wait');
    expect(bootPhase(steps(7))).toBe('drafting');
    expect(bootPhase(steps(8, 'approve'))).toBe('approval_wait');
  });
});

describe('project 입력 변경 묶기(G§4.2 ②)', () => {
  test('여러 커밋의 같은 파일 변경을 처음과 끝 상태로 합친다', () => {
    expect(mergeChanges([
      { path: 'prototype/docs/a.md', change: 'added' }, { path: 'prototype/docs/a.md', change: 'modified' },
      { path: 'prototype/docs/b.md', change: 'added' }, { path: 'prototype/docs/b.md', change: 'deleted' },
      { path: 'prototype/uiux/c.html', change: 'modified' }, { path: 'prototype/uiux/c.html', change: 'deleted' },
      { path: 'prototype/uiux/d.html', change: 'deleted' }, { path: 'prototype/uiux/d.html', change: 'added' },
    ])).toEqual([
      { path: 'prototype/docs/a.md', change: 'added' },
      { path: 'prototype/uiux/c.html', change: 'deleted' },
      { path: 'prototype/uiux/d.html', change: 'modified' },
    ]);
  });
  test('설계 문서 목록은 prototype/docs 아래 md의 추가·삭제만 반영한다', () => {
    expect(nextMdList(['prototype/docs/a.md', 'prototype/docs/b.md'], [
      { path: 'prototype/docs/c.md', change: 'added' }, { path: 'prototype/docs/a.md', change: 'deleted' },
      { path: 'prototype/uiux/x.md', change: 'added' }, { path: 'prototype/docs/img.png', change: 'added' },
    ])).toEqual(['prototype/docs/b.md', 'prototype/docs/c.md']);
  });
});

describe('project 계약의 오류 선언(리뷰 9)', () => {
  // 서버가 실제로 돌려주는 오류는 계약(OpenAPI)에 선언되어 있어야 클라이언트가 처리할 수 있다.
  test.each([
    ['analyzeInputs', ['INVALID_TRANSITION', 'INPUT_UNCHANGED', 'CLEANUP_PENDING']],
    ['skipInputs', ['INVALID_TRANSITION', 'VERSION_CONFLICT']],
    ['retryInputs', ['INVALID_TRANSITION', 'CLEANUP_PENDING']],
    ['reportInputChanges', ['INVALID_TRANSITION']],
    ['reportBootstrapProgress', ['INVALID_TRANSITION', 'EXTERNAL_WRITE_BLOCKED', 'LEASE_LOST', 'NOT_FOUND']],
    ['submitDraft', ['INVALID_TRANSITION', 'EXTERNAL_WRITE_BLOCKED', 'LEASE_LOST']],
    ['submitTechProposals', ['INVALID_TRANSITION', 'EXTERNAL_WRITE_BLOCKED', 'LEASE_LOST']],
    ['reportRepoCheck', ['LEASE_LOST', 'NOT_FOUND']],
  ] as const)('%s 는 %j 를 선언한다', (id, codes) => {
    const op = OPERATIONS.find((item) => item.id === id);
    expect(op?.errors).toEqual(expect.arrayContaining([...codes]));
  });
});

