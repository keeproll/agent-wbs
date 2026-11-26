// 재판단 작업(estimate job)의 payload 계약(M2-08 리뷰 지적 1).
// 재판단도 기존 estimate 모양 {tasks[{taskKey,subjectHash,content}], policy}을 그대로 따르고,
// 재판단의 이유·대상 역할은 policy.rejudge(RejudgeRequest)에 싣는다. 다른 모양을 같은 kind로 쓰지 않는다.
import { describe, expect, test } from 'vitest';
import { buildOpenApi, jobPayloadErrors, OPERATIONS } from '../../src/api/index.ts';

const content = {
  title: 't', scope: [], out: [], doneCond: '', spec: { req: [], work: [], steps: [], inputs: [], outputs: [], files: [], constraints: [], errors: [], docs: [], verify: [] },
  ac: [], outputs: [], designs: [], conflictGroup: null,
};
const valid = {
  tasks: [{ taskKey: 'TASK-0001', subjectHash: 'a'.repeat(64), content }],
  policy: { rejudge: { reason: 'model_disallowed', trigger: 'Claude 허용 모델 변경', targets: [{ taskKey: 'TASK-0001', roles: ['dev'] }] }, floors: { verifyGeDev: true, dbHigh: true } },
};

describe('jobPayloadErrors(estimate)', () => {
  test('계약대로면 오류 없음', () => {
    expect(jobPayloadErrors('estimate', valid)).toEqual([]);
  });
  test('policy·subjectHash·content가 빠지면 오류(리뷰가 본 옛 모양)', () => {
    expect(jobPayloadErrors('estimate', { reason: 'model_disallowed', trigger: 'x', tasks: [{ taskKey: 'TASK-0001', roles: ['dev'] }] }).length).toBeGreaterThan(0);
    expect(jobPayloadErrors('estimate', { ...valid, tasks: [{ taskKey: 'TASK-0001', content }] }).length).toBeGreaterThan(0);
  });
  test('rejudge의 이유는 정해진 3가지, 대상 역할은 1개 이상', () => {
    expect(jobPayloadErrors('estimate', { ...valid, policy: { rejudge: { ...valid.policy.rejudge, reason: 'whim' } } }).length).toBeGreaterThan(0);
    expect(jobPayloadErrors('estimate', { ...valid, policy: { rejudge: { ...valid.policy.rejudge, targets: [{ taskKey: 'TASK-0001', roles: [] }] } } }).length).toBeGreaterThan(0);
  });
  test('rejudge가 없는 일반 추정 정책도 그대로 허용(기존 소비자 호환)', () => {
    expect(jobPayloadErrors('estimate', { ...valid, policy: { anything: 1 } })).toEqual([]);
  });
});

test('OpenAPI의 estimate job policy에 RejudgeRequest가 보인다', () => {
  const doc = JSON.stringify(buildOpenApi(OPERATIONS));
  expect(doc).toContain('RejudgeRequest');
  expect(doc).toContain('model_disallowed');
});

test('Planning 세션과 CP 판단은 각각 필수 입력을 가지며 섞을 수 없다', () => {
  const planning = { id: 'session', title: '분석', scope: '입력 범위' };
  const session = { tasks: [], policy: {}, planning, proposal: null };
  const proposal = {
    id: 'cp', ops: [{ op: 'modify', task: 'TASK-0001', field: 'priority', after: 2 }],
    targets: [{ target: 'TASK-0001', subjectHash: 'a'.repeat(64), before: content, after: content }], splitSubjectHash: null, splitTasks: null,
  };
  expect(jobPayloadErrors('planning', session)).toEqual([]);
  expect(jobPayloadErrors('planning', { tasks: [], policy: {}, planning: null, proposal })).toEqual([]);
  expect(jobPayloadErrors('planning', { ...session, planning: null }).length).toBeGreaterThan(0);
  expect(jobPayloadErrors('planning', { ...session, proposal }).length).toBeGreaterThan(0);
  expect(jobPayloadErrors('planning', { ...session, planning: null, tasks: valid.tasks })).toEqual([]);
});
