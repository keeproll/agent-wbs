import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ClaimedJob } from '../../src/api/generated/client.ts';
import { runPlanningJob } from '../../src/planning/index.ts';
import { wireProblem } from '../../src/planning/wire.ts';
import { addOp, apiError, bodyOf, bootstrapJob, content, context, fakeApi, HASH, inputJob, NOW, progress, tempHome, wbsSnapshot } from './harness.ts';

/*
 * 서버 후속 4 계약(srv4 REPORT.md 「Runner가 맞춰야 할 계약」)에 맞춘 Runner 동작.
 */

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => cleanup());

type Job<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
const constraint = { id: 'c1', name: 'QuestDB', level: 'cond' as const, condition: '시계열 데이터가 있으면' };
const decision = (tdKey: string, status: 'fixed' | 'approved' | 'rejected') =>
  ({ id: `00000000-0000-4000-8000-0000000000${tdKey.slice(-2)}`, tdKey, title: tdKey, status, authority: 'agent' as const, updatedAt: NOW, content: { choice: tdKey } });
const defs = [{ id: 'sub-be', defKey: 'be-implementer', version: 1, agent: 'Claude' as const, role: 'dev' }];

describe('계약 1: 필수 값이 없으면 추측하지 않는다', () => {
  test.each(['planningJobId', 'runNo', 'version'])('bootstrap %s 없음 → UNSUPPORTED_PAYLOAD, 보고 없음', async (drop) => {
    const base = bootstrapJob();
    const job = { ...base, payload: Object.fromEntries(Object.entries(base.payload).filter(([key]) => key !== drop)) } as never;
    const fake = fakeApi();
    expect(await runPlanningJob(job, (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'UNSUPPORTED_PAYLOAD' } });
    expect(fake.calls).toEqual([]);
  });

  test('input_diff에 wbs 스냅샷이 없거나 형식이 틀리면 실패한다', async () => {
    for (const wbs of [undefined, { tasks: [] }, { ...wbsSnapshot(), tasks: [{ taskKey: 'TASK-0001', wp: 'WP-01', subjectHash: 'x' }] }]) {
      const job = inputJob();
      const bad = { ...job, payload: { ...job.payload, wbs } } as never;
      expect(await runPlanningJob(bad, (await context(home, fakeApi().api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'UNSUPPORTED_PAYLOAD' } });
    }
  });
});

describe('계약 2~4: 기술 제약·확정 결정·하위 Agent 정의', () => {
  test('기술 제약(서버 발급 id 포함)은 분석·교차 검토에, 확정 결정과 허용 정의는 초안 작성에 넘긴다', async () => {
    const first = bootstrapJob();
    Object.assign(first.payload, { techConstraints: [constraint] });
    const one = await context(home, fakeApi().api);
    await runPlanningJob(first, one.ctx);
    for (const call of [...one.codex.calls, ...one.claude.calls].filter((c) => c.method === 'analyze' || c.method === 'crossReview')) {
      expect(call.request).toMatchObject({ techConstraints: [constraint] });
    }
    const draftJob = bootstrapJob({ fence: 2, resumeStep: 'draft' });
    const techDecisions = [decision('TD-01', 'fixed'), decision('TD-02', 'rejected'), decision('TD-03', 'approved')];
    Object.assign(draftJob.payload, { techConstraints: [constraint], techDecisions, techDecisionVersion: 'a'.repeat(64), subagentDefs: defs });
    const two = await context(home, fakeApi().api);
    expect((await runPlanningJob(draftJob, two.ctx)).status).toBe('done');
    expect(two.claude.calls.find((c) => c.method === 'draft')?.request).toMatchObject({
      decisions: { version: 'a'.repeat(64), decisions: techDecisions, rejected: ['TD-02'] }, subagentDefs: defs, techConstraints: [constraint],
    });
  });

  test('결정이 모두 정해진 목록이 오면(확정 뒤 재시도) 기술 결정을 다시 제안하지 않는다', async () => {
    const job = bootstrapJob();
    Object.assign(job.payload, { techDecisions: [decision('TD-01', 'approved')] });
    const fake = fakeApi();
    const { ctx } = await context(home, fake.api);
    expect((await runPlanningJob(job, ctx)).status).toBe('done');
    expect(fake.ops()).not.toContain('submitTechProposals');
    expect(fake.ops()).toContain('submitDraft');
  });

  test('대기 결정이 있으면(제안 뒤 확정 전) 확정으로 보지 않는다', async () => {
    const job = bootstrapJob();
    Object.assign(job.payload, { techDecisions: [{ ...decision('TD-01', 'approved'), status: 'pending' }] });
    const fake = fakeApi();
    await runPlanningJob(job, (await context(home, fake.api)).ctx);
    expect(fake.ops()).toContain('submitTechProposals');
  });

  test('초안이 허용되지 않은 하위 Agent 정의를 고르면 보내지 않고 초안 단계 실패', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    const job = bootstrapJob({ fence: 2, resumeStep: 'draft' });
    Object.assign(job.payload, { subagentDefs: defs });
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    const original = claude.draft.bind(claude);
    claude.draft = async (r) => { const d = await original(r); return { ...d, tasks: d.tasks.map((t) => ({ ...t, subagents: { ...t.subagents, dev: ['sub-unknown'] } })) }; };
    expect(await runPlanningJob(job, ctx)).toMatchObject({ status: 'failed', error: { code: 'PLANNING_STEP_FAILED' } });
    expect(fake.ops()).not.toContain('submitDraft');
    expect(progress(fake.calls).at(-1)).toBe('draft:fail');
  });
});

describe('계약 6: WBS 스냅샷과 기존 Task 판단(taskJudgements)', () => {
  test('차이 분석: 스냅샷을 넘기고, 내용이 바뀌는 기존 Task는 두 Agent 합의로 taskJudgements를 보낸다', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex } = await context(home, fake.api);
    claude.ops = [addOp('NEW-1'), { op: 'modify', task: 'TASK-0001', field: 'title', after: '새 제목' }, { op: 'modify', task: 'TASK-0001', field: 'priority', after: 2 }];
    expect((await runPlanningJob(inputJob(), ctx)).status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    for (const agent of [claude, codex]) expect(agent.calls.find((c) => c.method === 'analyze')?.request).toMatchObject({ wbs: wbsSnapshot() });
    expect(claude.calls.find((c) => c.method === 'proposeChanges')?.request).toMatchObject({ wbs: wbsSnapshot() });
    const body = bodyOf(fake.calls, 'submitPlanningProposal') as { taskJudgements: { taskKey: string; judgedRules: { items: { agreedBy: string[]; subjectHash?: string }[] } }[] };
    expect(body.taskJudgements.map((t) => t.taskKey)).toEqual(['TASK-0001']);
    expect(body.taskJudgements[0]?.judgedRules.items.map((i) => i.agreedBy.join())).toEqual(['Claude,Codex', 'Claude,Codex', 'Claude,Codex']);
    expect(JSON.stringify(body.taskJudgements)).not.toContain('subjectHash');
    // 판단 대상은 스냅샷의 현재 내용 + 그 Task의 내용 변경(우선순위 변경은 판단 대상 아님)
    const subject = (codex.calls.find((c) => c.method === 'judgeRules')?.request as { subjects: { target: string; content: { before: unknown; changes: unknown[] } }[] }).subjects.find((s) => s.target === 'TASK-0001');
    expect(subject?.content.before).toEqual(content());
    expect(subject?.content.changes).toEqual([{ op: 'modify', task: 'TASK-0001', field: 'title', after: '새 제목' }]);
  });

  test('내용 변경이 없는 수정(우선순위)만 있으면 taskJudgements를 보내지 않는다', async () => {
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    claude.ops = [{ op: 'modify', task: 'TASK-0001', field: 'priority', after: 2 }];
    expect((await runPlanningJob(inputJob(), ctx)).status).toBe('done');
    expect(bodyOf(fake.calls, 'submitPlanningProposal')).not.toHaveProperty('taskJudgements');
  });

  test('스냅샷에 없는 Task를 고치려 하면 보내지 않는다', async () => {
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    claude.ops = [{ op: 'modify', task: 'TASK-0099', field: 'doneCond', after: 'x' }];
    expect(await runPlanningJob(inputJob(), ctx)).toMatchObject({ status: 'failed' });
    expect(fake.ops()).not.toContain('submitPlanningProposal');
    expect(progress(fake.calls).at(-1)).toBe('cp:fail');
  });

  test('분할: 원 Task의 작업 묶음·그래프가 든 스냅샷을 작성자에게 넘긴다', async () => {
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    const job: Job<'split'> = { id: '88888888-0000-4000-8000-888888888888', leaseUntil: NOW, fence: 1, kind: 'split',
      payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: HASH, content: content() }], policy: {}, wbs: wbsSnapshot() } };
    expect((await runPlanningJob(job, ctx)).status).toBe('done');
    expect(claude.calls.find((c) => c.method === 'proposeSplit')?.request).toMatchObject({ wbs: wbsSnapshot() });
  });
});

describe('계약 5: 기존 Task 재판단(planning:null, proposal:null, tasks ≥ 1)', () => {
  test('Task마다 등급·판단을 보내고, 판단에는 payload의 hash를 그대로 붙인다', async () => {
    const fake = fakeApi();
    const { ctx } = await context(home, fake.api);
    const job: Job<'planning'> = { id: '99999999-0000-4000-8000-999999999999', leaseUntil: NOW, fence: 1, kind: 'planning',
      payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: HASH, content: content() }], policy: { judgedRules: ['revert'] }, proposal: null, planning: null } } as Job<'planning'>;
    expect((await runPlanningJob(job, ctx)).status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    const body = bodyOf(fake.calls, 'submitTaskPlan') as { judgedRules: { items: { rule: string; subjectHash: string; agreedBy: string[] }[] } };
    expect(body.judgedRules.items).toMatchObject([{ rule: 'revert', subjectHash: HASH, agreedBy: ['Claude', 'Codex'] }]);
  });
});

describe('서버 규칙: VERSION_CONFLICT(전제가 바뀜)', () => {
  test('초안 제출이 VERSION_CONFLICT면 같은 키로 다시 보내지 않고 초안 단계 실패로 남긴다', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    const fake = fakeApi((call) => (call.op === 'submitDraft' ? apiError(call.op, 409, 'VERSION_CONFLICT') : undefined));
    const outcome = await runPlanningJob(bootstrapJob({ fence: 2, resumeStep: 'draft' }), (await context(home, fake.api)).ctx);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'VERSION_CONFLICT' } });
    expect(fake.ops().filter((o) => o === 'submitDraft')).toHaveLength(1);
    expect(progress(fake.calls).at(-1)).toBe('draft:fail');
    expect(String(fake.calls.at(-1)?.request.body?.note)).toContain('VERSION_CONFLICT');
  });

  test('차이 분석 CP가 VERSION_CONFLICT면 cp 단계 실패(cp:done을 보내지 않음)', async () => {
    const fake = fakeApi((call) => (call.op === 'submitPlanningProposal' ? apiError(call.op, 409, 'VERSION_CONFLICT') : undefined));
    expect(await runPlanningJob(inputJob(), (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'VERSION_CONFLICT' } });
    expect(progress(fake.calls).slice(-2)).toEqual(['cp:run', 'cp:fail']);
  });

  test('분할 CP의 VERSION_CONFLICT는 결과 코드로 남긴다', async () => {
    const fake = fakeApi((call) => (call.op === 'submitPlanningProposal' ? apiError(call.op, 409, 'VERSION_CONFLICT') : undefined));
    const job: Job<'split'> = { id: '88888888-0000-4000-8000-888888888889', leaseUntil: NOW, fence: 1, kind: 'split',
      payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: HASH, content: content() }], policy: {}, wbs: wbsSnapshot() } };
    expect(await runPlanningJob(job, (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'VERSION_CONFLICT' } });
  });
});

describe('관문: 새 필드도 전송 직전에 검사한다', () => {
  const item = (agreedBy: string[], subjectHash?: string) => ({ rule: 'revert', result: 'met', agreedBy, basis: 'b', judgedAt: NOW, sourceRef: 'j', ...(subjectHash && { subjectHash }) });
  const proposal = (taskJudgements: unknown) => ({ body: { jobId: 'j', fence: 1, title: 't', reason: 'r', source: { kind: 'input' }, ops: [addOp('NEW-1')], taskJudgements } });
  test('taskJudgements: 합의 주체 둘, taskKey 형식·중복', () => {
    const tj = (taskKey: string, agreedBy = ['Claude', 'Codex']) => ({ taskKey, judgedRules: { schemaVersion: 1, items: [item(agreedBy)] } });
    expect(wireProblem('submitPlanningProposal', proposal([tj('TASK-0001')]))).toBeNull();
    expect(wireProblem('submitPlanningProposal', proposal([tj('TASK-0001', ['Claude'])]))).toMatch(/합의 주체/);
    expect(wireProblem('submitPlanningProposal', proposal([tj('TASK-0001'), tj('TASK-0001')]))).toMatch(/두 번/);
    expect(wireProblem('submitPlanningProposal', proposal([tj('NEW-1')]))).toMatch(/taskKey/);
  });
  test('Task 재판단의 judgedRules는 payload hash가 있어야 한다', () => {
    const plan = (judgedRules: unknown) => ({ params: { taskKey: 'TASK-0001' }, body: { jobId: 'j', fence: 1, grades: { dev: {}, qa: {} }, subagents: { dev: [], qa: [], basis: '' }, conflictGroup: null, judgedRules } });
    expect(wireProblem('submitTaskPlan', plan({ schemaVersion: 1, items: [item(['Claude', 'Codex'], HASH)] }))).toBeNull();
    expect(wireProblem('submitTaskPlan', plan({ schemaVersion: 1, items: [item(['Claude', 'Codex'])] }))).toMatch(/subjectHash/);
  });
});
