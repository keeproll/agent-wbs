import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlanningJob } from '../../src/planning/index.ts';
import { bodyOf, context, fakeApi, inputJob, PREV, progress, SHA, tempHome } from './harness.ts';

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => cleanup());

describe('입력 자료 차이 분석(G§4.2 ②)', () => {
  test('커밋 고정 → 입력 checkout → 이전 버전과 git diff → 두 Agent 영향 분석 → 판단을 붙인 CP 제출', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex, ws } = await context(home, fake.api);
    const job = inputJob();
    const outcome = await runPlanningJob(job, ctx);

    expect(outcome).toEqual({ status: 'done', result: { proposalId: '00000000-0000-4000-8000-00000000c0de', cpKey: 'CP-0001', disagreements: [] } });
    expect(progress(fake.calls)).toEqual(['check:run', 'check:done', 'unzip:run', 'unzip:done', 'diff:run', 'diff:done', 'impact:run', 'impact:done', 'cp:run', 'cp:done']);
    expect(fake.schemaErrors).toEqual([]);
    expect(ws.calls.find((c) => c.method === 'diff')?.args).toEqual([PREV, SHA]);
    // 두 Agent가 같은 diff를 각자 분석한다(독립).
    for (const agent of [claude, codex]) {
      const request = agent.calls.find((c) => c.method === 'analyze')?.request as { kind: string; diff: unknown[] };
      expect(request.kind).toBe('input_diff');
      expect(request.diff).toHaveLength(1);
    }
    const cp = bodyOf(fake.calls, 'submitPlanningProposal') as { jobId: string; fence: number; source: unknown; ops: { t: { judgedRules: { items: { agreedBy: string[] }[] } } }[] };
    expect(cp).toMatchObject({ jobId: job.id, fence: 1, source: { kind: 'input' } });
    expect(cp.ops[0]?.t.judgedRules.items.map((i) => i.agreedBy.join())).toEqual(['Claude,Codex', 'Claude,Codex', 'Claude,Codex']);
    // CP를 제출한 뒤에야 cp 단계를 끝낸다.
    expect(fake.ops().indexOf('submitPlanningProposal')).toBeLessThan(fake.calls.findIndex((c) => c.request.body?.stepKey === 'cp' && c.request.body.status === 'done'));
    expect(String(fake.calls.find((c) => c.request.body?.stepKey === 'diff' && c.request.body.status === 'done')?.request.body?.note)).toContain('1');
  });

  test('영향이 없으면 CP를 만들지 않고 cp 단계를 「변경 없음」으로 끝낸다', async () => {
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    claude.ops = [];
    const outcome = await runPlanningJob(inputJob(), ctx);
    expect(outcome).toEqual({ status: 'done', result: { proposalId: null, cpKey: null, disagreements: [] } });
    expect(fake.ops()).not.toContain('submitPlanningProposal');
    expect(String(fake.calls.at(-1)?.request.body?.note)).toContain('변경 없음');
  });

  test('영향 분석 실패 후 다시 시도는 영향 분석부터 하고 diff는 저장된 결과를 쓴다', async () => {
    const one = await context(home, fakeApi().api);
    one.codex.fail.analyze = new Error('Codex 사용량 한도');
    expect((await runPlanningJob(inputJob(), one.ctx)).status).toBe('failed');

    const fake = fakeApi();
    const two = await context(home, fake.api);
    const outcome = await runPlanningJob(inputJob({ id: '22222222-2222-4222-8222-333333333333', fence: 2, resumeStep: 'impact' }), two.ctx);
    expect(outcome.status).toBe('done');
    expect(progress(fake.calls)).toEqual(['impact:run', 'impact:done', 'cp:run', 'cp:done']);
    expect(two.ws.count('diff')).toBe(0);
    expect((two.codex.calls.find((c) => c.method === 'analyze')?.request as { diff: unknown[] }).diff).toHaveLength(1);
  });

  test('다른 PC에서 diff 결과가 없으면 같은 두 커밋으로 다시 계산한다(보고는 하지 않음)', async () => {
    const fake = fakeApi();
    const { ctx, ws } = await context(home, fake.api);
    await runPlanningJob(inputJob({ fence: 2, resumeStep: 'cp' }), ctx);
    expect(progress(fake.calls)).toEqual(['impact:run', 'impact:done', 'cp:run', 'cp:done']);
    expect(ws.count('diff')).toBe(1);
  });
});
