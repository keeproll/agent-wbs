import { createHash } from 'node:crypto';
import { OPERATIONS } from '@awbs/shared/api';
import { describe, expect, test } from 'vitest';
import { approvalErrors } from '../src/tasks/approval.ts';
import { canonicalJson, judgedContent, subjectHash, type JudgedSource } from '../src/tasks/hash.ts';
import { wbsPaths } from '../src/tasks/wbs.ts';
import { isTimestamp } from '@awbs/shared/api';


const source: JudgedSource = {
  title: '목록 API',
  overview: { purpose: '목적', background: '배경', scope: ['a'], out: ['b'], precond: '선행', doneCond: '완료' },
  spec: { req: ['r'], files: ['f.ts'] },
  ac: [{ given: 'g', when: 'w', then: 't', method: '' }],
  outputs: [{ name: 'B', kind: '코드', required: true, verify: 'v', delivered: false }, { name: 'A', kind: '문서', required: false, verify: '', delivered: true }],
  designs: [{ kind: 'FE', content: { z: 1, a: [2, { y: 1, b: 2 }] } }, { kind: 'DB', content: {} }],
  conflictGroup: null,
};

describe('tasks 판단 대상 hash(data-model §2.3-1)', () => {
  test('객체 키 순서와 상관없이 같은 정규 JSON을 만든다', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });

  test('명세의 빈 칸은 빈 목록으로 채우고 판단 대상 필드만 남긴다', () => {
    const content = judgedContent(source);
    expect(Object.keys(content).sort()).toEqual(['ac', 'conflictGroup', 'designs', 'doneCond', 'out', 'outputs', 'scope', 'spec', 'title']);
    expect(content.spec).toEqual({ req: ['r'], work: [], steps: [], inputs: [], outputs: [], files: ['f.ts'], constraints: [], errors: [], docs: [], verify: [] });
    // 산출물은 이름순, 설계는 DB·API·FE·DevOps 순서다. 제출 여부(delivered)는 빠진다.
    expect(content.outputs).toEqual([{ name: 'A', kind: '문서', required: false, verify: '' }, { name: 'B', kind: '코드', required: true, verify: 'v' }]);
    expect(content.designs.map((d) => d.kind)).toEqual(['DB', 'FE']);
  });

  test('hash는 정규 JSON의 SHA-256 16진수다', () => {
    const expected = createHash('sha256').update(canonicalJson(judgedContent(source))).digest('hex');
    expect(subjectHash(source)).toBe(expected);
    expect(subjectHash(source)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('완료 조건·AC·설계가 바뀌면 hash가 바뀌고 목적·배경·제출 여부는 영향이 없다', () => {
    const base = subjectHash(source);
    expect(subjectHash({ ...source, overview: { ...source.overview, doneCond: '다름' } })).not.toBe(base);
    expect(subjectHash({ ...source, ac: [] })).not.toBe(base);
    expect(subjectHash({ ...source, designs: [{ kind: 'FE', content: { z: 2 } }] })).not.toBe(base);
    expect(subjectHash({ ...source, conflictGroup: 'cg-1' })).not.toBe(base);
    expect(subjectHash({ ...source, overview: { ...source.overview, purpose: '다른 목적', background: '', precond: '' } })).toBe(base);
    expect(subjectHash({ ...source, outputs: source.outputs.map((o) => ({ ...o, delivered: !o.delivered })).reverse() })).toBe(base);
  });
});

describe('tasks WBS 번호 계산(G§9.1-1)', () => {
  test('Phase·Work Package·Task 순서로 번호를 매기고 삭제된 Task는 번호에서 뺀다', () => {
    const nodes = [
      { id: 'wp2', kind: 'work_package' as const, parentId: 'p1', sortOrder: 1 },
      { id: 'p2', kind: 'phase' as const, parentId: null, sortOrder: 1 },
      { id: 'p1', kind: 'phase' as const, parentId: null, sortOrder: 0 },
      { id: 'wp1', kind: 'work_package' as const, parentId: 'p1', sortOrder: 0 },
      { id: 'wp3', kind: 'work_package' as const, parentId: 'p2', sortOrder: 0 },
    ];
    const tasks = [
      { id: 't3', wbsNodeId: 'wp1', sortOrder: 2, deleted: false },
      { id: 't1', wbsNodeId: 'wp1', sortOrder: 0, deleted: false },
      { id: 't2', wbsNodeId: 'wp1', sortOrder: 1, deleted: true },
      { id: 't4', wbsNodeId: 'wp3', sortOrder: 0, deleted: false },
    ];
    const paths = wbsPaths(nodes, tasks);
    expect(paths.node.get('p2')).toBe('2');
    expect(paths.node.get('wp2')).toBe('1.2');
    expect(paths.task.get('t1')).toBe('1.1.1');
    expect(paths.task.get('t3')).toBe('1.1.2');
    expect(paths.task.get('t4')).toBe('2.1.1');
    expect(paths.task.get('t2')).toBe('');
  });
});

describe('tasks 착수 승인 필수 항목(contracts §2.1)', () => {
  test('모자란 항목마다 경로가 있는 오류를 돌려준다', () => {
    const errors = approvalErrors({ purpose: ' ', doneCond: '', ac: [], checklist: [], outputs: [{ required: false }], assignee: null, verifier: null });
    expect(errors.map((e) => e.path)).toEqual(['overview.purpose', 'overview.doneCond', 'ac', 'checklist', 'outputs', 'assigneeAgent', 'verifierAgent']);
    expect(errors.every((e) => e.rule === 'required' && e.message.length > 0)).toBe(true);
    expect(approvalErrors({ purpose: 'p', doneCond: 'd', ac: [1], checklist: [1], outputs: [{ required: true }], assignee: 'Claude', verifier: 'Codex' })).toEqual([]);
  });
});

describe('tasks subjectHash 계약 고정(독립 리뷰 §5)', () => {
  const vector: JudgedSource = {
    title: '예시',
    overview: { purpose: '빠지는 목적', background: '빠지는 배경', scope: ['기능'], out: [], precond: '빠지는 선행', doneCond: '테스트 통과' },
    spec: {}, ac: [], outputs: [], designs: [], conflictGroup: null,
  };

  test('고정 벡터: 정규 JSON 문자열과 SHA-256 소문자 16진수가 일치한다', () => {
    expect(canonicalJson(judgedContent(vector))).toBe(
      '{"ac":[],"conflictGroup":null,"designs":[],"doneCond":"테스트 통과","out":[],"outputs":[],"scope":["기능"],'
      + '"spec":{"constraints":[],"docs":[],"errors":[],"files":[],"inputs":[],"outputs":[],"req":[],"steps":[],"verify":[],"work":[]},"title":"예시"}');
    expect(subjectHash(vector)).toBe('49813649157306979e9b5652a52674817589723f035e668c9b8a9e372027a1cb');
  });

  test('객체 키와 산출물 이름은 UTF-16 코드 단위 순서로 정렬한다', () => {
    // 'Z'(0x5A) < 'a'(0x61) < 'é'(0xE9) < '가'(0xAC00). localeCompare 순서와 다르다.
    expect(canonicalJson({ 가: 1, a: 2, Z: 3, é: 4 })).toBe('{"Z":3,"a":2,"é":4,"가":1}');
    const names = judgedContent({ ...vector, outputs: ['가', 'é', 'a', 'Z'].map((name) => ({ name, kind: 'k', required: true, verify: '', delivered: false })) })
      .outputs.map((output) => output.name);
    expect(names).toEqual(['Z', 'a', 'é', '가']);
  });

  test('문자열은 trim·대소문자·Unicode 정규화를 하지 않는다', () => {
    const base = subjectHash(vector);
    expect(subjectHash({ ...vector, title: ' 예시' })).not.toBe(base);
    const composed = subjectHash({ ...vector, title: 'é' });
    expect(subjectHash({ ...vector, title: 'é' })).not.toBe(composed);
  });
});

describe('tasks 재리뷰 P2-A·P2-B', () => {
  // M2 통합: Task 버전 시각도 공통 isTimestamp(1970~9999년, 조정자 결정)를 쓴다.
  test('버전 시각은 공통 Timestamp 규칙(1970~9999년의 실재하는 시각)만 실제 값으로 본다', () => {
    expect(isTimestamp('0000-01-01T00:00:00Z')).toBe(false);
    expect(isTimestamp('0000-12-31T23:59:59.999999Z')).toBe(false);
    expect(isTimestamp('0001-01-01T00:00:00Z')).toBe(false);
    expect(isTimestamp('1969-12-31T23:59:59.999999Z')).toBe(false);
    expect(isTimestamp('1970-01-01T00:00:00Z')).toBe(true);
    expect(isTimestamp('2024-02-29T23:59:59.123456Z')).toBe(true);
    expect(isTimestamp('2023-02-29T00:00:00Z')).toBe(false);
  });

  test('완료·취소 보호로 거부하는 9개 API는 계약에 409 INVALID_TRANSITION을 선언한다', () => {
    const ids = ['updateTask', 'deleteTask', 'deleteDependency', 'updateTaskSpec', 'updateTaskDesign', 'addChecklistItem', 'updateChecklistItem', 'deleteChecklistItem', 'updateTaskOutputs'];
    const missing = ids.filter((id) => !OPERATIONS.find((op) => op.id === id)?.errors.includes('INVALID_TRANSITION'));
    expect(missing).toEqual([]);
  });
});
