import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlanningJob } from '../../src/planning/index.ts';
import { apiError, bodyOf, bootstrapJob, context, fakeApi, NOW, progress, SHA, tempHome, transportError } from './harness.ts';

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => cleanup());

describe('초기 분석(G§4.2 PL-000) 단계 진행', () => {
  test('첫 실행: 준비 3단계 → Codex·Claude 독립 분석 → 교차 검토 → 기술 결정 제안 후 팀장 확정을 기다린다', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex, ws } = await context(home, fake.api);
    const outcome = await runPlanningJob(bootstrapJob(), ctx);

    expect(outcome).toEqual({ status: 'done', result: { waiting: 'tech' } });
    expect(progress(fake.calls)).toEqual([
      'check:run', 'check:done', 'unzip:run', 'unzip:done', 'repo:run', 'repo:done',
      'codex:run', 'codex:done', 'claude:run', 'claude:done', 'cross:run', 'cross:done',
    ]);
    expect(fake.ops().at(-1)).toBe('submitTechProposals');
    expect(fake.ops()).not.toContain('submitDraft');
    expect(fake.schemaErrors).toEqual([]);
    // 기술 결정은 팀장이 확정하므로(LEAD_STEPS) Runner는 tech 단계를 보고하지 않는다.
    expect(progress(fake.calls).some((p) => p.startsWith('tech'))).toBe(false);
    // 독립 분석: 각 Agent는 상대 분석을 받지 않는다. 교차 검토만 두 분석을 함께 본다.
    expect(JSON.stringify(claude.calls.find((c) => c.method === 'analyze')?.request)).not.toContain('Codex 분석 요약');
    expect(codex.called('analyze')).toBe(1);
    expect(claude.called('crossReview')).toBe(1);
    expect(JSON.stringify(claude.calls.find((c) => c.method === 'crossReview')?.request)).toContain('Codex 분석 요약');
    expect(ws.calls.map((c) => c.method)).toEqual(['fixCommit', 'checkoutInput', 'prepareWork']);
    // 보고에는 job 경로·fence·초기화 번호가 있다.
    const first = fake.calls[0];
    expect(first?.request.params).toEqual({ jobId: bootstrapJob().id });
    expect(first?.request.body).toMatchObject({ fence: 1, at: NOW });
    expect(first?.request.epoch).toBe(3);
    expect(bodyOf(fake.calls, 'submitTechProposals')).toMatchObject({ fence: 1, decisions: [{ choice: 'PostgreSQL 16' }], conditionJudgements: [] });
  });

  test('단계가 실패하면 그 단계를 fail로 보고하고 멈춘다. 다시 시도 job은 실패한 단계부터 잇고 끝난 분석은 다시 하지 않는다', async () => {
    const first = fakeApi();
    const one = await context(home, first.api);
    one.claude.fail.analyze = new Error('Claude 세션이 비정상 종료했습니다. token=sk-secret-value-0123456789');
    const failed = await runPlanningJob(bootstrapJob(), one.ctx);

    expect(failed).toMatchObject({ status: 'failed', error: { code: 'PLANNING_STEP_FAILED' } });
    expect(progress(first.calls).slice(-2)).toEqual(['claude:run', 'claude:fail']);
    const note = String(first.calls.at(-1)?.request.body?.note);
    expect(note).toContain('Claude 독립 분석');
    expect(note).not.toContain('sk-secret-value');
    expect(first.ops()).not.toContain('submitTechProposals');

    // 서버의 「다시 시도」는 같은 Planning 작업에 새 Runner job(resumeStep=실패 단계)을 만든다.
    const second = fakeApi();
    const two = await context(home, second.api);
    const resumed = await runPlanningJob(bootstrapJob({ id: '11111111-1111-4111-8111-222222222222', fence: 7, resumeStep: 'claude' }), two.ctx);

    expect(resumed).toEqual({ status: 'done', result: { waiting: 'tech' } });
    expect(progress(second.calls)).toEqual(['claude:run', 'claude:done', 'cross:run', 'cross:done']);
    expect(two.codex.called('analyze')).toBe(0);
    expect(two.claude.called('analyze')).toBe(1);
    // 준비 단계는 다시 보고하지 않지만, 분석에 필요한 읽기 전용 입력은 이 PC에 다시 마련한다. 원격 쓰기(repo)는 다시 하지 않는다.
    expect(two.ws.calls.map((c) => c.method)).toEqual(['fixCommit', 'checkoutInput']);
    expect(JSON.stringify(two.claude.calls.find((c) => c.method === 'crossReview')?.request)).toContain('Codex 분석 요약');
    expect(second.calls.every((c) => c.request.body?.fence === 7)).toBe(true);
  });

  test('기술 결정 확정 뒤(resumeStep=draft) 두 Agent 합의로 판단·추정을 채운 초안을 계약 스키마대로 등록한다', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    const fake = fakeApi();
    const { ctx, claude, codex } = await context(home, fake.api);
    const jobId = '11111111-1111-4111-8111-333333333333';
    const outcome = await runPlanningJob(bootstrapJob({ id: jobId, fence: 2, resumeStep: 'draft' }), ctx);

    expect(outcome).toEqual({ status: 'done', result: { revision: 1, disagreements: [] } });
    expect(progress(fake.calls)).toEqual(['draft:run']);
    expect(fake.ops()).toEqual(['reportBootstrapProgress', 'submitDraft']);
    expect(fake.schemaErrors).toEqual([]);
    const draft = bodyOf(fake.calls, 'submitDraft') as { fence: number; tasks: { ref: string; judgedRules: { items: { rule: string; agreedBy: string[]; sourceRef: string; judgedAt: string }[] }; estimate: { agreedBy: string[]; estHours: number } }[] };
    expect(draft.fence).toBe(2);
    for (const task of draft.tasks) {
      expect(task.judgedRules.items.map((i) => i.rule)).toEqual(['revert', 'contract', 'refactor']);
      expect(task.judgedRules.items.every((i) => i.agreedBy.join() === 'Claude,Codex' && i.sourceRef.startsWith('sha256:') && i.judgedAt === NOW)).toBe(true);
      // 작성자 초안의 단독 추정은 버리고 두 Agent의 독립 추정을 합의한 값으로 바꾼다.
      expect(task.estimate).toMatchObject({ estHours: 2, agreedBy: ['Claude', 'Codex'] });
    }
    // 독립 판단: 두 Agent가 각자 판단한다. 초안 작성은 작성자 한 명.
    expect(claude.called('judgeRules')).toBe(1);
    expect(codex.called('judgeRules')).toBe(1);
    expect(claude.called('draft') + codex.called('draft')).toBe(1);
    // 확정된 교차 검토 결과 위에서 초안을 쓴다.
    expect(JSON.stringify(claude.calls.find((c) => c.method === 'draft')?.request)).toContain('일치 2 · 이견 0');
    // 판단 hash는 서버가 계산하므로 보내지 않는다.
    expect(JSON.stringify(draft)).not.toContain('subjectHash');
  });

  test('두 Agent의 판단이 갈리면 그 규칙은 기록하지 않고(승인 보류) 이견을 결과에 남긴다', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    const fake = fakeApi();
    const { ctx, codex } = await context(home, fake.api);
    codex.verdicts['T1:contract'] = 'not_met';
    const outcome = await runPlanningJob(bootstrapJob({ fence: 2, resumeStep: 'draft' }), ctx);

    expect(outcome).toMatchObject({ status: 'done', result: { disagreements: [{ target: 'T1', rule: 'contract', reason: 'disagree' }] } });
    const draft = bodyOf(fake.calls, 'submitDraft') as { tasks: { ref: string; judgedRules: { items: { rule: string }[] } }[] };
    expect(draft.tasks.find((t) => t.ref === 'T1')?.judgedRules.items.map((i) => i.rule)).toEqual(['revert', 'refactor']);
    expect(draft.tasks.find((t) => t.ref === 'T2')?.judgedRules.items).toHaveLength(3);
  });

  test('다른 PC라 이 Planning 작업의 분석 기록이 없으면 초안 전에 분석부터 다시 하고 보고한다. 기술 결정은 다시 제안하지 않는다', async () => {
    const fake = fakeApi();
    const { ctx, codex } = await context(home, fake.api);
    const outcome = await runPlanningJob(bootstrapJob({ fence: 2, resumeStep: 'draft' }), ctx);

    expect(outcome).toMatchObject({ status: 'done', result: { revision: 1 } });
    expect(progress(fake.calls)).toEqual(['codex:run', 'codex:done', 'claude:run', 'claude:done', 'cross:run', 'cross:done', 'draft:run']);
    expect(fake.ops()).not.toContain('submitTechProposals');
    expect(codex.called('analyze')).toBe(1);
  });

  test('재분석(runNo 2, resumeStep=codex)은 이전 회차 분석을 쓰지 않고, 확정된 기술 결정을 유지한 채 초안까지 간다', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    const fake = fakeApi();
    const { ctx, codex } = await context(home, fake.api);
    const outcome = await runPlanningJob(bootstrapJob({ fence: 4, resumeStep: 'codex', runNo: 2 }), ctx);

    expect(outcome).toMatchObject({ status: 'done', result: { revision: 1 } });
    expect(progress(fake.calls)).toEqual(['codex:run', 'codex:done', 'claude:run', 'claude:done', 'cross:run', 'cross:done', 'draft:run']);
    expect(fake.ops()).not.toContain('submitTechProposals');
    expect(codex.called('analyze')).toBe(1);
    expect(JSON.stringify(codex.calls[0]?.request)).toContain('계약 먼저');
  });

  test('같은 job을 다시 실행하면(응답 유실·재시작) 같은 멱등 키로 보내 서버가 중복 처리하지 않는다', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    const a = fakeApi();
    await runPlanningJob(bootstrapJob({ fence: 2, resumeStep: 'draft' }), (await context(home, a.api)).ctx);
    const b = fakeApi();
    await runPlanningJob(bootstrapJob({ fence: 2, resumeStep: 'draft' }), (await context(home, b.api)).ctx);
    const key = (calls: typeof a.calls) => calls.find((c) => c.op === 'submitDraft')?.request.idempotencyKey;
    expect(key(a.calls)).toMatch(/^submitDraft:runner-1:[0-9a-f-]{36}$/);
    expect(key(b.calls)).toBe(key(a.calls));
    // 다른 job(새 fence)은 새 요청이므로 새 키다.
    const c = fakeApi();
    await runPlanningJob(bootstrapJob({ id: '11111111-1111-4111-8111-444444444444', fence: 3, resumeStep: 'draft' }), (await context(home, c.api)).ctx);
    expect(key(c.calls)).not.toBe(key(a.calls));
  });

  test('일시 오류(503·연결 끊김)는 같은 키로 다시 보낸다', async () => {
    const fake = fakeApi((call, index) => (index === 0 ? apiError(call.op, 503, 'UNAVAILABLE') : index === 1 ? transportError(call.op) : undefined));
    const { ctx } = await context(home, fake.api);
    const outcome = await runPlanningJob(bootstrapJob(), ctx);
    expect(outcome.status).toBe('done');
    expect(fake.calls.slice(0, 3).map((c) => c.request.idempotencyKey)).toEqual(Array(3).fill(fake.calls[0]?.request.idempotencyKey));
  });

  test('임대를 잃으면(LEASE_LOST) 더 보고하지 않고 멈춘다. 실패 단계 보고도 보내지 않는다', async () => {
    const fake = fakeApi((call) => (call.op === 'reportBootstrapProgress' && call.request.body?.stepKey === 'unzip' ? apiError(call.op, 409, 'LEASE_LOST') : undefined));
    const { ctx, codex } = await context(home, fake.api);
    const outcome = await runPlanningJob(bootstrapJob(), ctx);
    expect(outcome).toMatchObject({ status: 'lost' });
    expect(progress(fake.calls)).toEqual(['check:run', 'check:done', 'unzip:run']);
    expect(codex.called('analyze')).toBe(0);
  });

  test('기술 결정 제안이 거부되면 교차 검토 단계 실패로 보고해 팀장이 다시 시도할 수 있게 한다', async () => {
    const fake = fakeApi((call) => (call.op === 'submitTechProposals' ? apiError(call.op, 400, 'VALIDATION_FAILED') : undefined));
    const { ctx } = await context(home, fake.api);
    const outcome = await runPlanningJob(bootstrapJob(), ctx);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'PLANNING_STEP_FAILED' } });
    expect(progress(fake.calls).at(-1)).toBe('cross:fail');
    expect(String(fake.calls.at(-1)?.request.body?.note)).toContain('VALIDATION_FAILED');
  });

  test('알 수 없는 재개 단계는 추측하지 않고 실패한다', async () => {
    const fake = fakeApi();
    const { ctx } = await context(home, fake.api);
    const outcome = await runPlanningJob(bootstrapJob({ resumeStep: 'approve' }), ctx);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INVALID_RESUME_STEP' } });
    expect(fake.calls).toEqual([]);
  });

  test('준비 단계 실패도 그 단계부터 다시 한다', async () => {
    const first = fakeApi();
    const one = await context(home, first.api);
    one.ws.fail.prepareWork = new Error('push 거부');
    expect((await runPlanningJob(bootstrapJob(), one.ctx)).status).toBe('failed');
    expect(progress(first.calls).at(-1)).toBe('repo:fail');
    const second = fakeApi();
    const two = await context(home, second.api);
    await runPlanningJob(bootstrapJob({ fence: 2, resumeStep: 'repo' }), two.ctx);
    expect(progress(second.calls).slice(0, 2)).toEqual(['repo:run', 'repo:done']);
    expect(two.ws.calls.map((c) => c.method)).toEqual(['fixCommit', 'checkoutInput', 'prepareWork']);
    expect(two.ws.calls[2]?.args).toEqual([SHA]);
  });
});
