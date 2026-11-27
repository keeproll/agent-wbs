import { describe, expect, test } from 'vitest';
import { newTaskSource, splitSubjectHash } from '../src/planning/content.ts';
import { draftSource } from '../src/project/draft.ts';
import { subjectHash as draftHash } from '../src/project/hash.ts';
import { subjectHash } from '../src/tasks/hash.ts';
import { task } from './project-fixture.ts';
// Runner의 판단 투영(M5-04 judged.ts). 서버 정의와 같은 지문이 나오는지 서버 함수로 직접 대조한다(5차 리뷰 P1).
import { fingerprint, judgedContentHash } from '../../../../agent-runner/src/planning/binding.ts';
import { judgedOfDraftTask, judgedOfNewTask } from '../../../../agent-runner/src/planning/judged.ts';

/*
 * 서버 subjectHash 정의(packages/shared judgement.ts)와 Runner 투영의 고정 대조.
 * 서버 후속 4가 계약 fixture 벡터를 내면 그 벡터로도 대조한다(아직 없음, fix6 보고).
 */

type AddT = Parameters<typeof newTaskSource>[0];
const base: AddT = { title: '새 Task', type: 'Implementation', domain: 'BE', wp: 'WP-01', priority: 1, assignee: 'Claude', verifier: 'Codex', purpose: '목적', doneCond: '테스트 통과' } as AddT;
const variants: [string, AddT, string | null][] = [
  ['설계 생략(BE → API 권장 구역)', base, null],
  ['설계 생략 + 관련 영역(FE·DB·BE 중복)', { ...base, rel: ['FE', 'DB', 'API'] } as AddT, null],
  ['명시한 설계(종류 역순·숫자 confidence 포함)', { ...base, design: [{ kind: 'FE', content: { s: [] } }, { kind: 'DB', content: { ents: [{ example: { confidence: 0.91 } }] } }] } as AddT, null],
  ['명시한 빈 설계', { ...base, design: [] } as AddT, null],
  ['범위·파일·AC(방법 생략)', { ...base, scope: ['a', 'b'], files: ['src/x.ts'], ac: [{ given: 'g', when: 'w', then: 't' }, { given: '', when: '', then: 'u', method: '수동' }] } as AddT, 'shared-db'],
];

describe('Runner 판단 투영 = 서버 subjectHash', () => {
  test.each(variants)('CP 새 Task: %s', (_name, t, group) => {
    expect(judgedContentHash(judgedOfNewTask(t as never, group))).toBe(subjectHash(newTaskSource(t, group)));
  });

  test('초안 Task(산출물 이름 역순·명세 일부·묶음)', () => {
    const t = task('t1', {
      outputs: [{ name: 'z문서', kind: 'doc', required: false, verify: 'v', delivered: false }, { name: 'a코드', kind: 'code', required: true, verify: 'test', delivered: true }],
      spec: { req: ['r'], work: [], steps: [], inputs: [], outputs: [], files: ['f'], constraints: [], errors: [], docs: [], verify: [] }, conflictGroup: 'auth',
    });
    expect(judgedContentHash(judgedOfDraftTask(t as never))).toBe(draftHash(draftSource(t as never)));
  });

  test('분할 판단(D-34) 지문 = 서버 splitSubjectHash', () => {
    const ops = [{ op: 'add', ref: 'NEW-1', preds: [], t: { ...base, splitBasis: '계약' } }, { op: 'remove', task: 'TASK-0001' }];
    const splitTasks = [{ taskKey: 'TASK-0001', content: { title: '원래', scope: [], out: [], doneCond: 'd', spec: {}, ac: [], outputs: [], designs: [], conflictGroup: 'shared-db' } }];
    expect(fingerprint({ ops, splitTasks })).toBe(splitSubjectHash(ops as never, splitTasks));
  });
});
