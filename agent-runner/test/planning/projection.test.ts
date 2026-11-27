import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ClaimedJob } from '../../src/api/generated/client.ts';
import { judgedContentHash, refFingerprint } from '../../src/planning/binding.ts';
import { runPlanningJob } from '../../src/planning/index.ts';
import { applyContentChanges, judgedOfNewTask } from '../../src/planning/judged.ts';
import { destinationProblem } from '../../src/planning/reporter.ts';
import { addOp, apiError, bodyOf, bootstrapJob, content, context, fakeApi, HASH, NOW, tempHome, wbsSnapshot, type FakeAgent } from './harness.ts';

/*
 * 5차 리뷰(Codex, review5-codex.md)
 * P1 판단 투영은 계약의 JudgedContent 정의 그대로다(분할 상속 포함). 서버가 지문을 대조해 409를 주면 다시 판단하는 경로로 간다.
 * P2 전송 직전에 목적지(경로 인자·jobId·fence·출처)를 지금 job payload와 대조한다. 저장본의 목적지는 믿지 않는다.
 */

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => cleanup());

type Job<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
/** 원 Task TASK-0001이 shared-db 묶음인 WBS 스냅샷 */
const sharedWbs = () => {
  const w = wbsSnapshot();
  return { ...w, tasks: w.tasks.map((t) => ({ ...t, content: { ...t.content, conflictGroup: 'shared-db' } })) };
};
const splitJob = (id = '88888888-0000-4000-8000-888888888888'): Job<'split'> => ({ id, leaseUntil: NOW, fence: 1, kind: 'split',
  payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: HASH, content: { ...content(), conflictGroup: 'shared-db' } }], policy: {}, wbs: sharedWbs() } });
const impl = (ref: string, extra: object = {}) => ({ ...addOp(ref), t: { ...addOp(ref).t, splitBasis: '계약 먼저', ...extra } });
/** 판단 Agent: 보여 준 내용의 충돌 묶음이 shared-db면 not_met */
function groupSensitive(...agents: FakeAgent[]) {
  for (const agent of agents) {
    agent.judgeRules = (r) => { agent.calls.push({ method: 'judgeRules', request: structuredClone(r) });
      return Promise.resolve(r.subjects.flatMap((s) => r.rules.map((rule) => ({ target: s.target, rule, basis: '근거',
        result: (s.content as { conflictGroup: string | null }).conflictGroup === 'shared-db' ? 'not_met' as const : 'met' as const })))); };
  }
}
const shownGroups = (agent: FakeAgent) =>
  (agent.calls.find((c) => c.method === 'judgeRules')?.request as { subjects: { target: string; content: { conflictGroup: string | null } }[] }).subjects.map((s) => `${s.target}:${String(s.content.conflictGroup)}`);

describe('P1: 분할 새 Task의 판단 투영은 상속 묶음을 포함한다', () => {
  test('리뷰어 재현의 반대: 원 Task를 취소하는 분할에서 묶음을 생략한 새 Task는 shared-db를 보고 판단한다', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex } = await context(home, fake.api);
    claude.ops = [impl('NEW-1'), impl('NEW-2'), { op: 'remove', task: 'TASK-0001' }] as never;
    groupSensitive(claude, codex);
    expect((await runPlanningJob(splitJob(), ctx)).status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    for (const agent of [claude, codex]) expect(shownGroups(agent)).toEqual(['NEW-1:shared-db', 'NEW-2:shared-db']);
    const body = bodyOf(fake.calls, 'submitPlanningProposal') as { ops: { op: string; ref?: string; t?: { judgedRules: { items: { result: string; sourceRef: string }[] } } }[] };
    for (const op of body.ops.filter((o) => o.op === 'add')) {
      expect(op.t?.judgedRules.items.every((i) => i.result === 'not_met')).toBe(true);
      // 지문 = 상속을 적용한 새 Task 내용의 JudgedContent hash(서버가 저장할 hash와 같은 계산)
      expect(refFingerprint(op.t?.judgedRules.items[0]?.sourceRef)).toBe(judgedContentHash(judgedOfNewTask(impl(op.ref ?? '').t as never, 'shared-db')));
    }
  });

  test('원 Task를 취소하지 않는 분할은 상속하지 않는다(묶음 없음을 보여 줌)', async () => {
    const { ctx, claude, codex } = await context(home, fakeApi().api);
    claude.ops = [impl('NEW-1')] as never;
    groupSensitive(claude, codex);
    expect((await runPlanningJob(splitJob(), ctx)).status).toBe('done');
    expect(shownGroups(codex)).toEqual(['NEW-1:null']);
  });

  test('명시한 묶음(null 포함)은 상속보다 앞선다', async () => {
    const { ctx, claude, codex } = await context(home, fakeApi().api);
    claude.ops = [impl('NEW-1', { conflictGroup: null }), impl('NEW-2', { conflictGroup: 'other' }), { op: 'remove', task: 'TASK-0001' }] as never;
    groupSensitive(claude, codex);
    expect((await runPlanningJob(splitJob(), ctx)).status).toBe('done');
    expect(shownGroups(codex)).toEqual(['NEW-1:null', 'NEW-2:other']);
  });

  test('조사 Task가 묶음을 생략하면 상속 여부를 정할 수 없어(원 Task 작업 유형 없음) 보내지 않는다', async () => {
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    claude.ops = [impl('NEW-1', { type: 'Analysis' }), impl('NEW-2'), { op: 'remove', task: 'TASK-0001' }] as never;
    expect(await runPlanningJob(splitJob(), ctx)).toMatchObject({ status: 'failed', error: { code: 'PLANNING_AGENT_FAILED' } });
    expect(fake.calls).toEqual([]);
  });

  test('기존 Task 수정의 투영: acAdd 문장은 서버와 같은 규칙으로 AC가 된다', () => {
    const after = applyContentChanges(content(), [
      { op: 'modify', task: 'TASK-0001', field: 'acAdd', after: 'Given 로그인, When 저장, Then 저장된다' },
      { op: 'modify', task: 'TASK-0001', field: 'acAdd', after: '설명만 있는 기준' },
      { op: 'modify', task: 'TASK-0001', field: 'scopeAdd', after: '범위' },
    ]);
    expect(after.ac.slice(1)).toEqual([{ given: '로그인', when: '저장', then: '저장된다', method: '' }, { given: '', when: '', then: '설명만 있는 기준', method: '' }]);
    expect(after.scope).toEqual(['범위']);
  });

  test('서버가 지문 불일치로 409를 주면 VERSION_CONFLICT로 남기고, 새 job은 다시 판단해 보낸다', async () => {
    const first = fakeApi((call) => (call.op === 'submitPlanningProposal' ? apiError(call.op, 409, 'VERSION_CONFLICT') : undefined));
    const one = await context(home, first.api);
    one.claude.ops = [impl('NEW-1'), { op: 'remove', task: 'TASK-0001' }] as never;
    expect(await runPlanningJob(splitJob(), one.ctx)).toMatchObject({ status: 'failed', error: { code: 'VERSION_CONFLICT' } });
    expect(first.ops().filter((o) => o === 'submitPlanningProposal')).toHaveLength(1);
    const second = fakeApi();
    const two = await context(home, second.api);
    two.claude.ops = [impl('NEW-1'), { op: 'remove', task: 'TASK-0001' }] as never;
    expect((await runPlanningJob(splitJob('88888888-0000-4000-8000-888888888889'), two.ctx)).status).toBe('done');
    expect(two.codex.called('judgeRules')).toBe(1);
    expect(second.ops()).toContain('submitPlanningProposal');
  });
});

describe('P2: 저장본의 목적지는 믿지 않는다', () => {
  const rejudge = (): Job<'planning'> => ({ id: '99999999-0000-4000-8000-999999999999', leaseUntil: NOW, fence: 1, kind: 'planning',
    payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: HASH, content: content() }], policy: { judgedRules: ['revert'] }, proposal: null, planning: null } } as Job<'planning'>);
  async function tamper(job: { id: string; fence: number }, name: string, change: (request: { params?: Record<string, string>; body: Record<string, unknown> }) => void) {
    const dir = join(home, 'state', 'planning');
    for (const file of await readdir(dir)) {
      const doc = JSON.parse(await readFile(join(dir, file), 'utf8')) as { sent: Record<string, { request: { params?: Record<string, string>; body: Record<string, unknown> } }> };
      const entry = doc.sent[`${job.id}@${String(job.fence)}:${name}`];
      if (!entry) continue;
      change(entry.request);
      await writeFile(join(dir, file), JSON.stringify(doc));
      return;
    }
    throw new Error(`${name} 기록 없음`);
  }

  test('리뷰어 재현의 반대: 재판단 보고의 taskKey만 바꾸면 보내지 않는다', async () => {
    await runPlanningJob(rejudge(), (await context(home, fakeApi().api)).ctx);
    await tamper(rejudge(), 'plan:TASK-0001', (r) => { if (r.params) r.params.taskKey = 'TASK-0002'; });
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    expect(await runPlanningJob(rejudge(), ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    expect(fake.calls).toEqual([]);
    expect(claude.called('planTask')).toBe(0);
  });

  test.each([
    ['본문 jobId', (r: { body: Record<string, unknown> }) => { r.body.jobId = '00000000-0000-4000-8000-000000000000'; }],
    ['본문 fence', (r: { body: Record<string, unknown> }) => { r.body.fence = 9; }],
  ])('재판단 보고의 %s만 바꾸면 보내지 않는다', async (_name, change) => {
    await runPlanningJob(rejudge(), (await context(home, fakeApi().api)).ctx);
    await tamper(rejudge(), 'plan:TASK-0001', change);
    const fake = fakeApi();
    expect(await runPlanningJob(rejudge(), (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    expect(fake.calls).toEqual([]);
  });

  test('분할 CP의 출처(원 Task)만 바꾸면 보내지 않는다', async () => {
    const one = await context(home, fakeApi().api);
    one.claude.ops = [impl('NEW-1'), { op: 'remove', task: 'TASK-0001' }] as never;
    await runPlanningJob(splitJob(), one.ctx);
    await tamper(splitJob(), 'proposal', (r) => { r.body.source = { kind: 'split', id: 'TASK-0002' }; });
    const fake = fakeApi();
    expect(await runPlanningJob(splitJob(), (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    expect(fake.calls).toEqual([]);
  });

  test('초기 분석 진행 보고의 jobId 경로만 바꾸면 보내지 않는다(단계 실패만 보고)', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    await tamper(bootstrapJob(), 'progress:check:run', (r) => { if (r.params) r.params.jobId = '00000000-0000-4000-8000-000000000000'; });
    const fake = fakeApi();
    expect(await runPlanningJob(bootstrapJob(), (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    // 변조된 목적지로는 아무것도 가지 않는다. 실패 보고는 이 job의 올바른 경로로만 간다.
    expect(fake.calls.every((c) => c.request.params?.jobId === bootstrapJob().id)).toBe(true);
  });

  test('목적지 검사 함수', () => {
    const to = { params: { taskKey: 'TASK-0001' } };
    const ok = { params: { taskKey: 'TASK-0001' }, body: { jobId: 'j', fence: 1 } };
    expect(destinationProblem(ok, to, 'j', 1)).toBeNull();
    expect(destinationProblem({ ...ok, params: { taskKey: 'TASK-0002' } }, to, 'j', 1)).toMatch(/경로 인자/);
    expect(destinationProblem({ ...ok, params: { taskKey: 'TASK-0001', extra: 'x' } }, to, 'j', 1)).toMatch(/경로 인자/);
    expect(destinationProblem({ ...ok, body: { jobId: 'k', fence: 1 } }, to, 'j', 1)).toMatch(/jobId/);
    expect(destinationProblem({ ...ok, body: { jobId: 'j', fence: 2 } }, to, 'j', 1)).toMatch(/fence/);
    expect(destinationProblem({ body: { fence: 1, source: { kind: 'split', id: 'TASK-0002' } } }, { params: null, source: { kind: 'split', id: 'TASK-0001' } }, 'j', 1)).toMatch(/출처/);
  });
});
