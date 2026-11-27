import { chmod, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createResetCleanup } from '../../src/cleanup/reset.ts';
import { PlanningCheckpoint, PlanningCheckpoints } from '../../src/planning/checkpoint.ts';
import { agreeEstimates, agreeJudgements } from '../../src/planning/consensus.ts';
import { runPlanningJob } from '../../src/planning/index.ts';
import { PlanningReporter } from '../../src/planning/reporter.ts';
import { apiError, bootstrapJob, content, context, fakeApi, NOW, tempHome, wbsSnapshot } from './harness.ts';

/*
 * M5-04 독립 리뷰(Codex) 지적 1~5의 재현을 「안전한 동작」을 기대하는 회귀 시험으로 바꾼 것.
 * 리뷰 원문: archive/2026-11-27/M5-04-independent-review-codex.md
 */

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => { await chmod(join(home, 'state'), 0o700).catch(() => undefined); await cleanup(); });

const EPOCH = 3; // harness context의 epoch
const BOOT_KEY = 'bootstrap:99999999-9999-4999-8999-999999999999';
const planningDir = () => join(home, 'state', 'planning');
const resetCommand = { id: 'reset', epoch: 4, kind: 'reset-cleanup', payload: { holds: [], generation: null, unparsedPrs: [] } } as never;
const sessionJob = () => ({ id: '55555555-5555-4555-8555-555555555555', fence: 1, leaseUntil: NOW, kind: 'planning' as const,
  payload: { tasks: [], policy: {}, proposal: null, ...{ planning: { id: '66666666-6666-4666-8666-666666666666', title: '주제', scope: '범위' } } } });

describe('지적 1: 초기화 뒤 Planning 기록이 남지 않고, 기록은 초기화 번호별이다', () => {
  test('초기화 정리가 성공하면 Planning 진행 기록 폴더가 사라진다', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    expect((await readdir(planningDir())).length).toBe(1);
    const reset = createResetCleanup({ home, identity: () => ({ hostId: 'host', bootId: 'boot' }) });
    const result = await reset(resetCommand);
    expect(result.status).toBe('done');
    expect(result.items).toContainEqual({ name: 'planning:local', ok: true, detail: 'Planning 진행 기록 삭제' });
    await expect(readdir(planningDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('기록을 지우지 못하면 정리 실패로 보고한다(완료로 꾸미지 않음)', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    await chmod(join(home, 'state'), 0o500);
    const result = await createResetCleanup({ home, identity: () => ({ hostId: 'host', bootId: 'boot' }) })(resetCommand);
    expect(result.status).toBe('failed');
    expect(result.items.at(-1)).toMatchObject({ name: 'planning:local', ok: false });
  });

  test('초기화 뒤 같은 객체로 다시 써도 폴더를 다시 만든다', async () => {
    const { ctx } = await context(home, fakeApi().api);
    await createResetCleanup({ home, identity: () => ({ hostId: 'h', bootId: 'b' }) })(resetCommand);
    expect((await runPlanningJob(bootstrapJob(), ctx)).status).toBe('done');
  });

  test('새 초기화 번호에서는 옛 번호의 기록(키·본문)을 쓰지 않는다', async () => {
    const old = fakeApi();
    await runPlanningJob(bootstrapJob(), (await context(home, old.api)).ctx);
    const fresh = fakeApi();
    const { ctx, codex } = await context(home, fresh.api, { epoch: 4 });
    await runPlanningJob(bootstrapJob(), ctx);
    expect(codex.called('analyze')).toBe(1);
    expect(fresh.calls.every((c) => c.request.epoch === 4)).toBe(true);
    const oldKeys = new Set(old.calls.map((c) => c.request.idempotencyKey));
    expect(fresh.calls.some((c) => oldKeys.has(c.request.idempotencyKey))).toBe(false);
    expect((await readdir(planningDir())).sort()).toEqual([PlanningCheckpoint.fileName(3, BOOT_KEY), PlanningCheckpoint.fileName(4, BOOT_KEY)].sort());
  });

  test('파일 안의 초기화 번호가 다르면 손상으로 보고 멈춘다', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    const { rename } = await import('node:fs/promises');
    await rename(join(planningDir(), PlanningCheckpoint.fileName(3, BOOT_KEY)), join(planningDir(), PlanningCheckpoint.fileName(5, BOOT_KEY)));
    const fake = fakeApi();
    expect(await runPlanningJob(bootstrapJob(), (await context(home, fake.api, { epoch: 5 })).ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    expect(fake.calls).toEqual([]);
  });

  test('보고기는 다른 초기화 번호의 기록으로 보내지 않는다(옛 요청에 새 번호를 붙이지 않음)', async () => {
    const checkpoint = await (await PlanningCheckpoints.open(home)).load(3, BOOT_KEY, 1);
    const fake = fakeApi();
    const reporter = new PlanningReporter({ api: fake.api, epoch: 4, runnerId: 'runner-1', jobId: 'j', checkpoint });
    await expect(reporter.send('submitTechProposals', 'tech', { params: { jobId: 'j' }, body: { fence: 1, decisions: [] } }, { to: { params: { jobId: 'j' } } })).rejects.toMatchObject({ code: 'EPOCH_MISMATCH' });
    expect(fake.calls).toEqual([]);
  });
});

describe('지적 2: 실패·상실 결과에 비밀값이 나오지 않는다', () => {
  test('Agent 오류 메시지의 설정 비밀값과 토큰 형식을 가린다', async () => {
    const { ctx, codex } = await context(home, fakeApi().api, { secrets: ['review-private-secret'] });
    codex.fail.estimate = new Error('CLI token=review-private-secret sk-abcdefghijklmnopqrstuvwxyz');
    const job = { id: '77777777-7777-4777-8777-777777777777', fence: 1, leaseUntil: NOW, kind: 'estimate' as const,
      payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: 'a'.repeat(64), content: content() }], policy: {} } };
    const outcome = await runPlanningJob(job, ctx);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'PLANNING_AGENT_FAILED' } });
    expect(JSON.stringify(outcome)).not.toContain('review-private-secret');
    expect(JSON.stringify(outcome)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(outcome)).toContain('[REDACTED]');
  });

  test('일반 예외 경로도 같은 경계에서 가린다', async () => {
    const { ctx, claude } = await context(home, fakeApi().api, { secrets: ['review-private-secret'] });
    claude.proposeSplit = () => { throw new TypeError('bad review-private-secret'); };
    const job = { id: '88888888-0000-4000-8000-888888888888', fence: 1, leaseUntil: NOW, kind: 'split' as const,
      payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: 'a'.repeat(64), content: content() }], policy: {}, wbs: wbsSnapshot() } };
    expect(JSON.stringify(await runPlanningJob(job, ctx))).not.toContain('review-private-secret');
  });
});

describe('지적 3: 재시작해도 서버에 보고한 분석으로 교차 검토한다', () => {
  test('분석 보고 뒤 중단 → 재시작: Agent에게 다시 묻지 않고 보고한 분석으로 검토한다', async () => {
    const one = await context(home, fakeApi().api);
    one.claude.fail.crossReview = new Error('interrupted before review');
    expect((await runPlanningJob(sessionJob(), one.ctx)).status).toBe('failed');
    const second = fakeApi();
    const two = await context(home, second.api);
    two.codex.analyze = () => Promise.resolve({ summary: 'NEW Codex', items: [] });
    two.claude.analyze = () => Promise.resolve({ summary: 'NEW Claude', items: [] });
    expect((await runPlanningJob(sessionJob(), two.ctx)).status).toBe('done');
    const posted = second.calls.filter((c) => c.op === 'submitPlanningAnalysis').map((c) => c.request.body?.summary);
    expect(posted).toEqual(['Codex 분석 요약', 'Claude 분석 요약']);
    const cross = two.claude.calls.find((c) => c.method === 'crossReview')?.request as { analyses: Record<string, { summary: string }> };
    expect([cross.analyses.Codex?.summary, cross.analyses.Claude?.summary]).toEqual(['Codex 분석 요약', 'Claude 분석 요약']);
  });

  test('분석을 저장한 뒤 보고 도중 멈추면, 아직 못 보낸 Agent의 분석도 다시 묻지 않고 저장한 것을 쓴다', async () => {
    const first = fakeApi((call) => (call.op === 'submitPlanningAnalysis' ? apiError(call.op, 400, 'VALIDATION_FAILED') : undefined));
    expect((await runPlanningJob(sessionJob(), (await context(home, first.api)).ctx)).status).toBe('failed');
    const second = fakeApi();
    const two = await context(home, second.api);
    two.claude.analyze = () => Promise.resolve({ summary: 'NEW Claude', items: [] });
    expect((await runPlanningJob(sessionJob(), two.ctx)).status).toBe('done');
    expect(second.calls.filter((c) => c.op === 'submitPlanningAnalysis').map((c) => c.request.body?.summary)).toEqual(['Codex 분석 요약', 'Claude 분석 요약']);
    const cross = two.claude.calls.find((c) => c.method === 'crossReview')?.request as { analyses: Record<string, { summary: string }> };
    expect(cross.analyses.Claude?.summary).toBe('Claude 분석 요약');
  });

  test('분석 결과 없이 보낸 보고만 남은 기록(이전 버전)은 보낸 본문에서 분석을 되살린다', async () => {
    const job = sessionJob();
    const request = (agent: string, summary: string) => ({ params: { id: job.payload.planning.id }, body: { jobId: job.id, fence: 1, agent, summary, items: ['x'] } });
    const doc = { version: 1, epoch: EPOCH, outputs: {}, sent: {
      [`${job.id}:analysis:Codex`]: { key: 'submitPlanningAnalysis:runner-1:00000000-0000-4000-8000-000000000001', request: request('Codex', 'SENT Codex') },
      [`${job.id}:analysis:Claude`]: { key: 'submitPlanningAnalysis:runner-1:00000000-0000-4000-8000-000000000002', request: request('Claude', 'SENT Claude') },
    } };
    await (await PlanningCheckpoints.open(home)).load(EPOCH, `planning:${job.id}`, 1);
    await writeFile(join(planningDir(), PlanningCheckpoint.fileName(EPOCH, `planning:${job.id}`)), JSON.stringify(doc));
    const { ctx, claude, codex } = await context(home, fakeApi().api);
    expect((await runPlanningJob(job, ctx)).status).toBe('done');
    expect(claude.called('analyze') + codex.called('analyze')).toBe(0);
    const cross = claude.calls.find((c) => c.method === 'crossReview')?.request as { analyses: Record<string, { summary: string }> };
    expect(cross.analyses.Codex?.summary).toBe('SENT Codex');
  });

  test('추정을 보낸 뒤 재시작해도 다시 묻지 않고 같은 합의를 보낸다', async () => {
    const job = { id: '77777777-7777-4777-8777-777777777778', fence: 1, leaseUntil: NOW, kind: 'estimate' as const,
      payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: 'a'.repeat(64), content: content() }], policy: {} } };
    const a = fakeApi();
    await runPlanningJob(job, (await context(home, a.api)).ctx);
    const b = fakeApi();
    const two = await context(home, b.api);
    expect((await runPlanningJob(job, two.ctx)).status).toBe('done');
    expect(two.codex.called('estimate')).toBe(0);
    expect(b.calls[0]?.request).toEqual(a.calls[0]?.request);
  });
});

describe('지적 4: 문법만 맞는 손상 기록도 거부한다', () => {
  const write = async (doc: unknown) => {
    await (await PlanningCheckpoints.open(home)).load(EPOCH, BOOT_KEY, 1);
    await writeFile(join(planningDir(), PlanningCheckpoint.fileName(EPOCH, BOOT_KEY)), JSON.stringify(doc));
  };
  const expectUnreadable = async (job = bootstrapJob()) => {
    const fake = fakeApi();
    expect(await runPlanningJob(job, (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    expect(fake.calls).toEqual([]);
  };
  test.each([
    ['outputs·sent가 배열', { version: 1, epoch: EPOCH, outputs: [], sent: [] }],
    ['outputs만 배열', { version: 1, epoch: EPOCH, outputs: [], sent: {} }],
    ['sent만 배열', { version: 1, epoch: EPOCH, outputs: {}, sent: [] }],
    ['회차 결과가 배열', { version: 1, epoch: EPOCH, outputs: { 1: [] }, sent: {} }],
    ['초기화 번호 없음', { version: 1, outputs: {}, sent: {} }],
    ['보낸 요청의 키 형식이 틀림', { version: 1, epoch: EPOCH, outputs: {}, sent: { 'j:draft': { key: 'x', request: {} } } }],
    ['보낸 요청 본문이 객체가 아님', { version: 1, epoch: EPOCH, outputs: {}, sent: { 'j:draft': { key: 'submitDraft:runner-1:00000000-0000-4000-8000-000000000001', request: 'body' } } }],
  ])('%s', async (_name, doc) => {
    await write(doc);
    await expectUnreadable();
  });

  test('불러올 단계 결과의 모양이 다르면 거부한다', async () => {
    await write({ version: 1, epoch: EPOCH, outputs: { 1: { 'analysis:Codex': { summary: 5 } } }, sent: {} });
    await expectUnreadable(bootstrapJob({ resumeStep: 'claude' }));
  });

  test('거부해도 원본 파일을 덮어쓰지 않는다', async () => {
    const doc = { version: 1, epoch: EPOCH, outputs: [], sent: [] };
    await write(doc);
    await expectUnreadable();
    const { readFile } = await import('node:fs/promises');
    expect(JSON.parse(await readFile(join(planningDir(), PlanningCheckpoint.fileName(EPOCH, BOOT_KEY)), 'utf8'))).toEqual(doc);
  });
});

describe('지적 5: 잘못된 Agent 출력은 합의로 바꾸지 않고 오류·기록 없음으로 둔다', () => {
  const good = { ref: 'T1', estHours: 2, loHours: 1, hiHours: 3, confidence: '중', basis: '근거' };
  test.each([
    ['신뢰도', { confidence: 'invalid' }, /신뢰도/],
    ['예상 NaN', { estHours: Number.NaN }, /유한한 수/],
    ['비관 Infinity', { hiHours: Number.POSITIVE_INFINITY }, /유한한 수/],
    ['토큰 음수', { tokensK: -1 }, /유한한 수/],
    ['근거가 문자열 아님', { basis: null }, /근거/],
  ])('추정 %s 오류', (_name, bad, message) => {
    expect(() => agreeEstimates(['T1'], { Claude: [{ ...good, ...bad }], Codex: [good] } as never)).toThrow(message);
  });

  test('판단의 근거·결론 형식이 틀리면 예외 대신 invalid로 기록하지 않는다', () => {
    const meta = { judgedAt: NOW, sourceRef: 'job' };
    const ok = { target: 'T1', rule: 'revert' as const, result: 'met' as const, basis: '근거' };
    for (const bad of [{ ...ok, basis: null }, { ...ok, result: 'yes' }]) {
      const { records, disagreements } = agreeJudgements(['T1'], ['revert'], { Claude: [ok], Codex: [bad] } as never, meta);
      expect(records.get('T1')?.items).toEqual([]);
      expect(disagreements).toEqual([{ target: 'T1', rule: 'revert', reason: 'invalid' }]);
    }
  });
});
