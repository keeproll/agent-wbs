import { createHash } from 'node:crypto';
import type { WireProposalOp } from '@awbs/shared/api';
import { describe, expect, test } from 'vitest';
import { judgementJobKey, newTaskSource, previewHash, splitSubjectHash, stripJudgements } from '../src/planning/content.ts';
import { canonicalJson, judgedContent, subjectHash } from '../src/tasks/hash.ts';
import { advanceWbs, type wbsSnapshot } from '../src/planning/job-snapshot.ts';

const add = (t: Record<string, unknown> = {}): Extract<WireProposalOp, { op: 'add' }> => ({
  op: 'add', ref: 'NEW-1', preds: [],
  t: { title: '새 작업', type: 'Implementation', domain: 'BE', rel: ['FE'], wp: 'wp', priority: 2, assignee: 'Claude', verifier: 'Codex', purpose: '목적', doneCond: '완료', ...t },
} as Extract<WireProposalOp, { op: 'add' }>);

test('같은 job의 반영분은 Task 추가·제거와 그래프만 누적하고 무관한 외부 내용은 받아들이지 않는다', () => {
  type Wbs = Awaited<ReturnType<typeof wbsSnapshot>>;
  const task = (taskKey: string, title: string): Wbs['tasks'][number] => {
    const source = newTaskSource(add({ title }).t, null);
    return { taskKey, workType: 'Implementation', wp: 'wp', status: 'ready', subjectHash: subjectHash(source), content: judgedContent(source) };
  };
  const basis: Wbs = { tasks: [task('TASK-0001', 'A'), task('TASK-0002', 'B'), task('TASK-0003', 'C')],
    phases: [{ id: 'phase', wps: [{ id: 'wp', tasks: ['TASK-0001', 'TASK-0002', 'TASK-0003'] }] }],
    dependencies: [{ pred: 'TASK-0001', succ: 'TASK-0002', type: 'FS' }] };
  const before: Wbs = { ...basis, tasks: [task('TASK-0001', 'A'), task('TASK-0002', 'B'), task('TASK-0003', '외부 변경')] };
  const after: Wbs = { ...before, tasks: [task('TASK-0001', '내가 바꾼 A'), task('TASK-0003', '외부 변경'), task('TASK-0004', '추가 D')],
    dependencies: [{ pred: 'TASK-0001', succ: 'TASK-0004', type: 'SS' }] };
  const advanced = advanceWbs(before, after, basis);
  expect(advanced.tasks.map((item) => [item.taskKey, item.content.title])).toEqual([
    ['TASK-0001', '내가 바꾼 A'], ['TASK-0003', 'C'], ['TASK-0004', '추가 D'],
  ]);
  expect(advanced.dependencies).toEqual(after.dependencies);
  expect(advanced.phases[0]?.wps[0]?.tasks).toEqual(['TASK-0001', 'TASK-0003', 'TASK-0004']);
  expect(basis.tasks[0]?.content.title).toBe('A');
});

describe('planning 새 Task의 판단 대상 내용(data-model §2.4-1·§2.3-1)', () => {
  test('선택 필드를 생략하면 범위·파일은 빈 목록, 설계는 영역에 맞는 빈 구역(P recKinds)이다', () => {
    const source = newTaskSource(add().t, null);
    expect(source.overview.scope).toEqual([]);
    expect(source.spec).toEqual({ files: [] });
    // BE→API, FE→FE. 빈 구역의 내용은 P newTask의 {ents:[], b:{}}
    expect(source.designs).toEqual([{ kind: 'API', content: { ents: [], b: {} } }, { kind: 'FE', content: { ents: [], b: {} } }]);
    expect(source.conflictGroup).toBeNull();
    expect(source.outputs).toEqual([]);
  });

  test('명시한 값은 그대로 쓴다. 명시한 빈 설계 []는 구역 없음이다', () => {
    const source = newTaskSource(add({ scope: ['a'], files: ['x.ts'], design: [], ac: [{ given: 'g', when: 'w', then: 't' }] }).t, '묶음');
    expect(source.overview).toMatchObject({ scope: ['a'], doneCond: '완료' });
    expect(source.spec).toEqual({ files: ['x.ts'] });
    expect(source.designs).toEqual([]);
    expect(source.ac).toEqual([{ given: 'g', when: 'w', then: 't', method: '' }]);
    expect(source.conflictGroup).toBe('묶음');
  });

  test('충돌 묶음(상속 결과)이 바뀌면 hash가 바뀐다 — 원래 묶음이 바뀌면 다시 판단한다', () => {
    const t = add().t;
    expect(subjectHash(newTaskSource(t, 'A'))).not.toBe(subjectHash(newTaskSource(t, 'B')));
    expect(subjectHash(newTaskSource(t, 'A'))).toBe(subjectHash(newTaskSource(t, 'A')));
  });
});

describe('planning 판단 기록 제외와 분할 hash', () => {
  const judged = { schemaVersion: 1, items: [{ rule: 'revert', result: 'met', agreedBy: ['Claude', 'Codex'], basis: 'b', judgedAt: '2026-11-26T00:00:00Z', sourceRef: `sha256:${'a'.repeat(64)}`, subjectHash: 'a'.repeat(64) }] };
  test('ops에서 판단 기록만 뺀다. 원본은 바꾸지 않는다', () => {
    const op = add({ judgedRules: judged, conflictGroup: 'G' });
    const stripped = stripJudgements([op, { op: 'remove', task: 'TASK-0001' }]);
    expect(stripped[0]).toEqual(add({ conflictGroup: 'G' }));
    expect((op.t as { judgedRules?: unknown }).judgedRules).toBe(judged);
    expect(stripped[1]).toEqual({ op: 'remove', task: 'TASK-0001' });
  });

  test('분할 hash는 판단 기록을 뺀 ops 전체 + 대상 Task 현재 내용의 SHA-256이고 판단을 적어도 바뀌지 않는다', () => {
    const tasks = [{ taskKey: 'TASK-0001', content: { title: 'x' } }];
    const plain = splitSubjectHash([add()], tasks);
    expect(plain).toBe(createHash('sha256').update(canonicalJson({ ops: [add()], splitTasks: tasks })).digest('hex'));
    expect(splitSubjectHash([add({ judgedRules: judged })], tasks)).toBe(plain);
    expect(splitSubjectHash([add({ title: '다른 제목' })], tasks)).not.toBe(plain);
    expect(splitSubjectHash([add()], [{ taskKey: 'TASK-0001', content: { title: 'y' } }])).not.toBe(plain);
  });
});

describe('planning 미리보기 hash와 판단 job 키', () => {
  const sim = { idMap: { 'NEW-1': 'TASK-0009' }, issues: [], diff: [{ index: 0, op: 'add', target: 'TASK-0009', field: 'task', before: null, after: { b: 1, a: 2 } }],
    impact: { removedDependencies: [], unblockedSuccessors: [] } };
  test('키 순서와 상관없이 같고, 보류 사유가 다르면 다르다', () => {
    const reordered = { ...sim, diff: [{ ...sim.diff[0], after: { a: 2, b: 1 } }] };
    expect(previewHash(sim, [])).toBe(previewHash(reordered, []));
    expect(previewHash(sim, [])).not.toBe(previewHash(sim, [{ code: 'JUDGEMENT_MISSING', taskKey: 'TASK-0009', rule: 'revert', message: 'm' }]));
  });

  test('판단 job 키는 CP와 대상 hash 조합마다 하나다(대상 순서와 무관)', () => {
    const a = judgementJobKey('cp-1', [{ target: 'NEW-1', subjectHash: 'h1' }, { target: 'TASK-0001', subjectHash: 'h2' }], null);
    expect(judgementJobKey('cp-1', [{ target: 'TASK-0001', subjectHash: 'h2' }, { target: 'NEW-1', subjectHash: 'h1' }], null)).toBe(a);
    expect(judgementJobKey('cp-1', [{ target: 'NEW-1', subjectHash: 'h3' }, { target: 'TASK-0001', subjectHash: 'h2' }], null)).not.toBe(a);
    expect(judgementJobKey('cp-2', [{ target: 'NEW-1', subjectHash: 'h1' }, { target: 'TASK-0001', subjectHash: 'h2' }], null)).not.toBe(a);
    expect(judgementJobKey('cp-1', [{ target: 'NEW-1', subjectHash: 'h1' }, { target: 'TASK-0001', subjectHash: 'h2' }], 's')).not.toBe(a);
    expect(a).toMatch(/^cp-judgement:cp-1:[a-f0-9]{64}$/);
  });
});
