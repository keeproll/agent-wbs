import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ClaimedJob } from '../../src/api/generated/client.ts';
import { bindingProblem, bound, boundRef, fingerprint, judgedContentHash, refFingerprint } from '../../src/planning/binding.ts';
import { runPlanningJob } from '../../src/planning/index.ts';
import { wireProblem } from '../../src/planning/wire.ts';
import { addOp, bodyOf, content, context, fakeApi, HASH, inputJob, NOW, tempHome } from './harness.ts';

/*
 * 4차 리뷰(Codex, review4-codex.md):
 * P1 판단은 「Agent에게 실제로 보여 준 입력」에 묶인다. 보여 준 입력과 보내는 내용이 다르면 보내지 않는다.
 * P2 관문은 계약이 정한 필드만 검사한다(자유 JSON 설계 안의 confidence는 해석하지 않음).
 * P3 판단 항목의 합의 주체 누락도 관문이 잡는다.
 */

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => cleanup());

type Job<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
const rejudgeJob = (): Job<'planning'> => ({ id: '99999999-0000-4000-8000-999999999999', leaseUntil: NOW, fence: 1, kind: 'planning',
  payload: { tasks: [{ taskKey: 'TASK-0001', subjectHash: HASH, content: content() }], policy: { judgedRules: ['revert'] }, proposal: null, planning: null } } as Job<'planning'>);

describe('P1: 새 충돌 묶음은 판단에도 보여 준다', () => {
  test('리뷰어 재현의 반대: 작성자가 shared-db를 고르면 두 Agent는 shared-db가 반영된 내용을 판단하고, 그 판단(not_met)을 보낸다', async () => {
    const fake = fakeApi();
    const { ctx, claude, codex } = await context(home, fake.api);
    claude.planTask = (r) => { claude.calls.push({ method: 'planTask', request: r }); return Promise.resolve({ grades: { dev: { modelId: 'm', effort: 'high', reason: 'r' }, qa: { modelId: 'm', effort: 'high', reason: 'r' } }, subagents: { dev: [], qa: [], basis: '' }, conflictGroup: { name: 'shared-db', reason: '공통 파일' } }); };
    for (const agent of [claude, codex]) {
      agent.judgeRules = (r) => { agent.calls.push({ method: 'judgeRules', request: structuredClone(r) });
        return Promise.resolve(r.subjects.flatMap((s) => r.rules.map((rule) => ({ target: s.target, rule, basis: '근거',
          result: (s.content as { conflictGroup: string | null }).conflictGroup === 'shared-db' ? 'not_met' as const : 'met' as const })))); };
    }
    expect((await runPlanningJob(rejudgeJob(), ctx)).status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    for (const agent of [claude, codex]) {
      const shown = (agent.calls.find((c) => c.method === 'judgeRules')?.request as { subjects: { content: { conflictGroup: string | null } }[] }).subjects[0]?.content;
      expect(shown?.conflictGroup).toBe('shared-db');
    }
    const body = bodyOf(fake.calls, 'submitTaskPlan') as { conflictGroup: { name: string }; judgedRules: { items: { result: string; subjectHash: string; sourceRef: string }[] } };
    expect(body.conflictGroup.name).toBe('shared-db');
    const [item] = body.judgedRules.items;
    expect(item?.result).toBe('not_met');
    // 서버 계약(srv4 fix3): subjectHash와 sourceRef 지문 모두 새 묶음을 반영한 변경 후 내용의 서버 hash다.
    expect(item?.subjectHash).toBe(judgedContentHash({ ...content(), conflictGroup: 'shared-db' }));
    expect(refFingerprint(item?.sourceRef)).toBe(judgedContentHash({ ...content(), conflictGroup: 'shared-db' }));
    expect(refFingerprint(item?.sourceRef)).not.toBe(judgedContentHash(content()));
  });

  test('서버와 같은 hash 계산: 고정 벡터(data-model §2.3-1)', () => {
    const vector = { title: '예시', scope: ['기능'], out: [], doneCond: '테스트 통과',
      spec: { req: [], work: [], steps: [], inputs: [], outputs: [], files: [], constraints: [], errors: [], docs: [], verify: [] }, ac: [], outputs: [], designs: [], conflictGroup: null };
    expect(judgedContentHash(vector)).toBe('49813649157306979e9b5652a52674817589723f035e668c9b8a9e372027a1cb');
  });

  test('묶인 판단 검사: 지문 없음·다른 입력의 지문은 문제다', () => {
    const record = (sourceRef: string) => ({ schemaVersion: 1, items: [{ sourceRef }] });
    const fp = fingerprint({ a: 1 });
    expect(bindingProblem(record(boundRef(fp)), fp, 'T')).toBeNull();
    expect(bindingProblem(record('j'), fp, 'T')).toMatch(/지문이 없습니다/);
    expect(bindingProblem(record(boundRef(fingerprint({ a: 2 }))), fp, 'T')).toMatch(/본 입력과 보내는 내용이 다릅니다/);
  });

  test('새로 만든 본문이 묶이지 않으면 한 번 다시 판단하고, 그래도 다르면 멈춘다', async () => {
    let calls = 0;
    const once = await bound(async () => ++calls, (n) => (n === 1 ? '다름' : null), (p) => new Error(p));
    expect([once, calls]).toEqual([2, 2]);
    calls = 0;
    await expect(bound(async () => ++calls, () => '계속 다름', (p) => new Error(p))).rejects.toThrow('계속 다름');
    expect(calls).toBe(2);
  });

  test('저장된 재판단 본문의 충돌 묶음만 바꾸면(판단과 내용 불일치) 아무것도 보내지 않는다', async () => {
    await runPlanningJob(rejudgeJob(), (await context(home, fakeApi().api)).ctx);
    const dir = join(home, 'state', 'planning');
    const [file] = await readdir(dir);
    const path = join(dir, file ?? '');
    const doc = JSON.parse(await readFile(path, 'utf8')) as { sent: Record<string, { request: { body: { conflictGroup: unknown } } }> };
    const entry = doc.sent[`${rejudgeJob().id}@1:plan:TASK-0001`];
    if (entry) entry.request.body.conflictGroup = { name: 'shared-db', reason: '변조' };
    await writeFile(path, JSON.stringify(doc));
    const fake = fakeApi();
    expect(await runPlanningJob(rejudgeJob(), (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    expect(fake.calls).toEqual([]);
  });

  test('저장된 CP 본문의 새 Task 내용만 바꾸면 보내지 않는다(판단한 내용과 다름)', async () => {
    await runPlanningJob(inputJob(), (await context(home, fakeApi().api)).ctx);
    const dir = join(home, 'state', 'planning');
    const [file] = await readdir(dir);
    const path = join(dir, file ?? '');
    const doc = JSON.parse(await readFile(path, 'utf8')) as { sent: Record<string, { request: { body: { ops: { t?: { title: string } }[] } } }> };
    const t = doc.sent[`${inputJob().id}@1:proposal`]?.request.body.ops[0]?.t;
    if (t) t.title = '판단하지 않은 제목';
    await writeFile(path, JSON.stringify(doc));
    const fake = fakeApi();
    expect(await runPlanningJob(inputJob(), (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    // 단계형 작업은 cp 단계 실패를 보고한다(팀장이 다시 시도할 수 있게). CP 자체는 보내지 않는다.
    expect(fake.ops().every((op) => op === 'reportBootstrapProgress')).toBe(true);
    expect(fake.calls.map((c) => `${String(c.request.body?.stepKey)}:${String(c.request.body?.status)}`).slice(-2)).toEqual(['cp:run', 'cp:fail']);
  });
});

describe('P2: 관문은 계약 필드만 본다', () => {
  const design = [{ kind: 'DB' as const, content: { ents: [{ name: 'Prediction', example: { confidence: 0.91 } }] } }];

  test('리뷰어 재현의 반대: 새 Task 설계 예제의 숫자 confidence가 있어도 CP를 보낸다', async () => {
    const fake = fakeApi();
    const { ctx, claude } = await context(home, fake.api);
    claude.ops = [{ ...addOp('NEW-1'), t: { ...addOp('NEW-1').t, design } }];
    expect((await runPlanningJob(inputJob(), ctx)).status).toBe('done');
    expect(fake.schemaErrors).toEqual([]);
    expect(bodyOf(fake.calls, 'submitPlanningProposal')).toMatchObject({ ops: [{ t: { design } }] });
  });

  test('계약 필드의 신뢰도는 여전히 검사한다: CP 새 Task의 conf, 추정의 confidence', () => {
    const proposal = (t: object) => ({ body: { jobId: 'j', fence: 1, title: 't', reason: 'r', source: { kind: 'input' }, ops: [{ ...addOp('NEW-1'), t: { ...addOp('NEW-1').t, ...t } }] } });
    expect(wireProblem('submitPlanningProposal', proposal({ design }))).toBeNull();
    expect(wireProblem('submitPlanningProposal', proposal({ conf: 0.91 }))).toMatch(/conf/);
    expect(wireProblem('submitEstimates', { body: { jobId: 'j', fence: 1, items: [{ taskKey: 'TASK-0001', estHours: 2, loHours: 1, hiHours: 3, confidence: 0.9, basis: 'b', agreedBy: ['Claude', 'Codex'] }] } })).toMatch(/신뢰도/);
  });
});

describe('P3: 판단 항목의 합의 주체 누락', () => {
  test('agreedBy 속성이 없어도 관문이 잡는다(CP 새 Task·기존 Task·분할·초안·재판단)', () => {
    const item = { rule: 'revert', result: 'met', basis: 'b', judgedAt: NOW, sourceRef: 'j' };
    const record = { schemaVersion: 1, items: [item] };
    const base = { jobId: 'j', fence: 1, title: 't', reason: 'r', source: { kind: 'input' }, ops: [addOp('NEW-1')] };
    expect(wireProblem('submitPlanningProposal', { body: { ...base, ops: [{ ...addOp('NEW-1'), t: { ...addOp('NEW-1').t, judgedRules: record } }] } })).toMatch(/합의 주체/);
    expect(wireProblem('submitPlanningProposal', { body: { ...base, taskJudgements: [{ taskKey: 'TASK-0001', judgedRules: record }] } })).toMatch(/합의 주체/);
    expect(wireProblem('submitPlanningProposal', { body: { ...base, splitJudgements: record } })).toMatch(/합의 주체/);
    expect(wireProblem('submitTaskPlan', { params: { taskKey: 'TASK-0001' }, body: { jobId: 'j', fence: 1, grades: { dev: {}, qa: {} }, subagents: { dev: [], qa: [], basis: '' }, conflictGroup: null,
      judgedRules: { schemaVersion: 1, items: [{ ...item, subjectHash: HASH }] } } })).toMatch(/합의 주체/);
  });
});
