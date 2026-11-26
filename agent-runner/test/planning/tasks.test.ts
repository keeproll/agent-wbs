import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ClaimedJob } from '../../src/api/generated/client.ts';
import { runPlanningJob } from '../../src/planning/index.ts';
import { addOp, bodyOf, content, context, fakeApi, HASH, NOW, tempHome } from './harness.ts';

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => cleanup());

type Job<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
const lease = (id: string, fence = 5) => ({ id, leaseUntil: NOW, fence });
const SPLIT_HASH = 'd'.repeat(64);
const NEW_HASH = 'e'.repeat(64);

function judgementJob(split: boolean): Job<'planning'> {
  const targets = [
    { target: 'TASK-0002', subjectHash: HASH, before: content('이전'), after: content('이후') },
    { target: 'NEW-1', subjectHash: NEW_HASH, before: null, after: content('새 Task') },
  ];
  const proposal = split
    ? { id: '33333333-3333-4333-8333-000000000001', ops: [{ ...addOp('NEW-1'), t: { ...addOp('NEW-1').t, splitBasis: '계약 먼저' } }], targets,
      splitSubjectHash: SPLIT_HASH, splitTasks: [{ taskKey: 'TASK-0001', content: content('원래') }] }
    : { id: '33333333-3333-4333-8333-000000000001', ops: [addOp('NEW-1')], targets, splitSubjectHash: null, splitTasks: null };
  return { ...lease('44444444-4444-4444-8444-444444444444'), kind: 'planning', payload: { tasks: [], policy: { judgedRules: ['revert', 'contract'] }, proposal } };
}

describe('CP 판단 job(planning + proposal)', () => {
  test('두 Agent가 변경 후 내용을 각자 판단하고, 합의한 것만 payload hash를 붙여 보낸다. 꺼진 규칙은 판단하지 않는다', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex } = await context(home, fake.api);
    codex.verdicts['NEW-1:contract'] = 'not_met';
    const job = judgementJob(false);
    const outcome = await runPlanningJob(job, ctx);

    expect(outcome).toMatchObject({ status: 'done', result: { disagreements: [{ target: 'NEW-1', rule: 'contract', reason: 'disagree' }] } });
    expect(fake.schemaErrors).toEqual([]);
    const call = fake.calls.find((c) => c.op === 'submitProposalJudgements');
    expect(call?.request.params).toEqual({ id: job.payload.proposal?.id });
    expect(call?.request.body).toEqual({
      jobId: job.id, fence: 5,
      judgements: [
        { target: 'TASK-0002', judgedRules: { schemaVersion: 1, items: ['revert', 'contract'].map((rule) => ({ rule, result: 'met', agreedBy: ['Claude', 'Codex'],
          basis: `Claude: Claude: ${rule} 근거\nCodex: Codex: ${rule} 근거`, judgedAt: NOW, sourceRef: job.id, subjectHash: HASH })) } },
        { target: 'NEW-1', judgedRules: { schemaVersion: 1, items: [{ rule: 'revert', result: 'met', agreedBy: ['Claude', 'Codex'],
          basis: 'Claude: Claude: revert 근거\nCodex: Codex: revert 근거', judgedAt: NOW, sourceRef: job.id, subjectHash: NEW_HASH }] } },
      ],
    });
    for (const agent of [claude, codex]) {
      const request = agent.calls.find((c) => c.method === 'judgeRules')?.request as { rules: string[]; subjects: { target: string; content: { title: string } }[] };
      expect(request.rules).toEqual(['revert', 'contract']);
      expect(request.subjects.map((s) => `${s.target}:${s.content.title}`)).toEqual(['TASK-0002:이후', 'NEW-1:새 Task']);
    }
    expect(claude.called('judgeSplit')).toBe(0);
  });

  test('분할 CP는 AC 의미·계층 순서·테스트 포함을 두 Agent가 판단해 splitSubjectHash로 보낸다', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex } = await context(home, fake.api);
    const outcome = await runPlanningJob(judgementJob(true), ctx);
    expect(outcome.status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    const body = bodyOf(fake.calls, 'submitProposalJudgements') as { splitJudgements: { items: { rule: string; subjectHash: string; agreedBy: string[] }[] } };
    expect(body.splitJudgements.items.map((i) => `${i.rule}:${i.subjectHash === SPLIT_HASH}:${i.agreedBy.join()}`)).toEqual([
      'ac_meaning:true:Claude,Codex', 'layer_order:true:Claude,Codex', 'test_included:true:Claude,Codex',
    ]);
    for (const agent of [claude, codex]) {
      const request = agent.calls.find((c) => c.method === 'judgeSplit')?.request as { splitTasks: { taskKey: string }[]; ops: unknown[] };
      expect(request.splitTasks.map((t) => t.taskKey)).toEqual(['TASK-0001']);
      expect(request.ops).toHaveLength(1);
    }
  });

  test('한 Agent가 판단하지 못하면 아무것도 보내지 않고 실패한다(단독 판단을 합의로 기록하지 않음)', async () => {
    const fake = fakeApi();
    const { ctx, codex } = await context(home, fake.api);
    codex.fail.judgeRules = new Error('Codex 응답 형식 오류');
    const outcome = await runPlanningJob(judgementJob(false), ctx);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'PLANNING_AGENT_FAILED' } });
    expect(fake.calls).toEqual([]);
  });
});

describe('Planning 세션 job(planning + payload.planning, G§4.5)', () => {
  test('두 독립 분석과 교차 검토를 세션에 보고한다', async () => {
    const fake = fakeApi();
    const { ctx } = await context(home, fake.api);
    const job = { ...lease('55555555-5555-4555-8555-555555555555'), kind: 'planning' as const,
      payload: { tasks: [], policy: {}, proposal: null, ...{ planning: { id: '66666666-6666-4666-8666-666666666666', title: '알림 화면', scope: '알림 설정' } } } };
    const outcome = await runPlanningJob(job, ctx);
    expect(outcome.status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    expect(fake.ops()).toEqual(['submitPlanningAnalysis', 'submitPlanningAnalysis', 'submitPlanningReviews']);
    expect(fake.calls.map((c) => c.request.params?.id)).toEqual(Array(3).fill('66666666-6666-4666-8666-666666666666'));
    expect(fake.calls.slice(0, 2).map((c) => c.request.body?.agent)).toEqual(['Codex', 'Claude']);
  });

  test('세션도 CP도 없는 planning payload는 추측하지 않고 실패한다', async () => {
    const fake = fakeApi();
    const { ctx } = await context(home, fake.api);
    const outcome = await runPlanningJob({ ...lease('55555555-5555-4555-8555-000000000000'), kind: 'planning', payload: { tasks: [], policy: {}, proposal: null } }, ctx);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'UNSUPPORTED_PAYLOAD' } });
    expect(fake.calls).toEqual([]);
  });
});

describe('추정 job(estimate)', () => {
  const estimateJob = (policy: Job<'estimate'>['payload']['policy'] = {}): Job<'estimate'> => ({
    ...lease('77777777-7777-4777-8777-777777777777'), kind: 'estimate',
    payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: HASH, content: content() }, { taskKey: 'TASK-0002', subjectHash: HASH, content: { ...content(), conflictGroup: 'auth' } }], policy },
  });

  test('두 Agent의 독립 추정을 합의해 한 번에 등록한다', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex } = await context(home, fake.api);
    claude.estimates['TASK-0001'] = { estHours: 2, loHours: 1, hiHours: 4, confidence: '상', basis: 'C' };
    codex.estimates['TASK-0001'] = { estHours: 4, loHours: 2, hiHours: 6, confidence: '하', basis: 'X' };
    const outcome = await runPlanningJob(estimateJob(), ctx);
    expect(outcome.status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    expect(fake.ops()).toEqual(['submitEstimates']);
    expect(bodyOf(fake.calls, 'submitEstimates')).toEqual({
      jobId: '77777777-7777-4777-8777-777777777777', fence: 5,
      items: [
        { taskKey: 'TASK-0001', estHours: 3, loHours: 1, hiHours: 6, confidence: '하', basis: 'Claude: C\nCodex: X', agreedBy: ['Claude', 'Codex'] },
        { taskKey: 'TASK-0002', estHours: 2, loHours: 1, hiHours: 3, confidence: '중', basis: 'Claude: Claude 근거\nCodex: Codex 근거', agreedBy: ['Claude', 'Codex'] },
      ],
    });
  });

  test('등급 재판단(policy.rejudge)이면 대상 Task의 등급 판단을 먼저 보고하고 재추정을 등록한다. 기존 충돌 묶음은 유지한다', async () => {
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    const outcome = await runPlanningJob(estimateJob({ rejudge: { reason: 'grade_changed', trigger: '팀장 등급 고정', targets: [{ taskKey: 'TASK-0002', roles: ['dev'] }] } }), ctx);
    expect(outcome.status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    expect(fake.ops()).toEqual(['submitTaskPlan', 'submitEstimates']);
    const plan = fake.calls[0];
    expect(plan?.request.params).toEqual({ taskKey: 'TASK-0002' });
    expect(plan?.request.body).toMatchObject({ jobId: '77777777-7777-4777-8777-777777777777', fence: 5, conflictGroup: { name: 'auth' } });
    expect((claude.calls.find((c) => c.method === 'planTask')?.request as { taskKey: string; roles: string[] })).toMatchObject({ taskKey: 'TASK-0002', roles: ['dev'] });
  });
});

describe('분할 job(split, G§5.2-1)', () => {
  const splitJob = (): Job<'split'> => ({
    ...lease('88888888-0000-4000-8000-888888888888'), kind: 'split',
    payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: HASH, content: content('큰 Task') }], policy: { split: { maxHours: 4 } } },
  });

  test('작성자가 나눈 CP에 새 Task별 판단과 분할 판단(D-34)을 두 Agent 합의로 붙여 분할 CP로 제출한다', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex } = await context(home, fake.api);
    const outcome = await runPlanningJob(splitJob(), ctx);
    expect(outcome).toMatchObject({ status: 'done', result: { cpKey: 'CP-0001' } });
    expect(fake.schemaErrors).toEqual([]);
    const body = bodyOf(fake.calls, 'submitPlanningProposal') as { source: unknown; ops: { op: string; t?: { judgedRules: { items: unknown[] } } }[]; splitJudgements: { items: { rule: string; agreedBy: string[] }[] } };
    expect(body.source).toEqual({ kind: 'split', id: 'TASK-0001' });
    expect(body.ops.filter((o) => o.op === 'add').map((o) => o.t?.judgedRules.items.length)).toEqual([3, 3]);
    expect(body.splitJudgements.items.map((i) => `${i.rule}:${i.agreedBy.join()}`)).toEqual(['ac_meaning:Claude,Codex', 'layer_order:Claude,Codex', 'test_included:Claude,Codex']);
    expect(claude.called('proposeSplit') + codex.called('proposeSplit')).toBe(1);
    // 분할 판단은 판단 기록을 뺀 ops와 원래 Task 내용을 본다.
    const seen = codex.calls.find((c) => c.method === 'judgeSplit')?.request as { ops: unknown[]; splitTasks: { taskKey: string }[] };
    expect(JSON.stringify(seen.ops)).not.toContain('judgedRules');
    expect(seen.splitTasks).toEqual([{ taskKey: 'TASK-0001', content: content('큰 Task') }]);
  });

  test('분할 근거가 빈 새 Task가 있으면 보내지 않고 실패한다(근거를 지어 넣지 않음)', async () => {
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    claude.ops = [{ ...addOp('NEW-1'), t: { ...addOp('NEW-1').t, splitBasis: '  ' } }];
    const outcome = await runPlanningJob(splitJob(), ctx);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'PLANNING_AGENT_FAILED' } });
    expect(fake.calls).toEqual([]);
  });
});
