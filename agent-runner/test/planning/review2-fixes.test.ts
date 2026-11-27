import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createResetCleanup } from '../../src/cleanup/reset.ts';
import { PlanningCheckpoint, PlanningCheckpoints } from '../../src/planning/checkpoint.ts';
import { agreedEstimateProblem } from '../../src/planning/consensus.ts';
import { isEstimates } from '../../src/planning/guards.ts';
import { runPlanningJob } from '../../src/planning/index.ts';
import { bootstrapJob, content, context, fakeApi, NOW, tempHome } from './harness.ts';

/*
 * M5-04 재리뷰(Codex, review2-codex.md) 지적 1~3의 재현을 「안전한 동작」을 기대하는 회귀 시험으로 바꾼 것.
 */

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => { await chmod(join(home, 'state'), 0o700).catch(() => undefined); await cleanup(); });

const EPOCH = 3;
const command = { id: 'reset', epoch: 4, kind: 'reset-cleanup', payload: { holds: [], generation: null, unparsedPrs: [] } } as never;
const estimateJob = () => ({ id: '77777777-7777-4777-8777-777777777777', fence: 1, leaseUntil: NOW, kind: 'estimate' as const,
  payload: { tasks: [{ taskKey: 'TASK-0001', workType: 'Implementation' as const, subjectHash: 'a'.repeat(64), content: content() }], policy: {} } });
const workKey = `estimate:${estimateJob().id}`;
const good = { ref: 'TASK-0001', estHours: 2, loHours: 1, hiHours: 3, confidence: '중', basis: 'Claude: a\nCodex: b', agreedBy: ['Claude', 'Codex'] };

/** 디스크 손상을 흉내 낸다: 저장 함수를 거치지 않고 파일을 직접 쓴다. */
async function writeDoc(outputs: Record<string, unknown>, sent: Record<string, unknown> = {}) {
  await (await PlanningCheckpoints.open(home)).load(EPOCH, workKey, 1);
  const file = join(home, 'state', 'planning', PlanningCheckpoint.fileName(EPOCH, workKey));
  const text = JSON.stringify({ version: 1, epoch: EPOCH, outputs: { 1: outputs }, sent });
  await writeFile(file, text);
  return { file, text };
}
async function expectUnreadable(file: string, text: string) {
  const fake = fakeApi();
  const { ctx, claude, codex } = await context(home, fake.api);
  expect(await runPlanningJob(estimateJob(), ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
  expect(fake.calls).toEqual([]);
  expect(claude.called('estimate') + codex.called('estimate')).toBe(0);
  expect(await readFile(file, 'utf8')).toBe(text);
}

describe('재리뷰 1: Planning 폴더를 조회하지 못하면 정리 실패다', () => {
  test('state 폴더 권한이 000이면 「없음」으로 넘기지 않고 planning:local 실패로 보고한다', async () => {
    await runPlanningJob(bootstrapJob(), (await context(home, fakeApi().api)).ctx);
    const dir = join(home, 'state', 'planning');
    const before = await readdir(dir);
    await chmod(join(home, 'state'), 0o000);
    const result = await createResetCleanup({ home, identity: () => ({ hostId: 'h', bootId: 'b' }) })(command);
    await chmod(join(home, 'state'), 0o700);
    expect(result.status).toBe('failed');
    expect(result.items.at(-1)).toMatchObject({ name: 'planning:local', ok: false });
    expect(await readdir(dir)).toEqual(before);
  });

  test('폴더가 정말 없으면(ENOENT) 정리를 막지 않는다', async () => {
    const result = await createResetCleanup({ home, identity: () => ({ hostId: 'h', bootId: 'b' }) })(command);
    expect(result.status).toBe('done');
    expect(result.items.some((i) => i.name === 'planning:local')).toBe(false);
  });
});

describe('재리뷰 2: 저장된 추정도 새 추정과 같은 검증을 거친다', () => {
  test.each([
    ['합의 주체가 하나', { agreedBy: ['Claude'] }],
    ['합의 주체 중복', { agreedBy: ['Claude', 'Claude'] }],
    ['신뢰도가 하·중·상이 아님', { confidence: 'invalid' }],
    ['범위 역전', { loHours: 4 }],
    ['예상 NaN 대신 문자열', { estHours: 'x' }],
    ['근거 없음', { basis: '  ' }],
    ['토큰 음수', { tokensK: -1 }],
  ])('%s → 보내지 않고 CHECKPOINT_UNREADABLE, 원본 보존', async (_name, bad) => {
    const { file, text } = await writeDoc({ 'estimates:agreed': [{ ...good, ...bad }] });
    await expectUnreadable(file, text);
  });

  test('저장된 추정의 Task가 이 작업의 Task와 다르면 거부한다', async () => {
    const { file, text } = await writeDoc({ 'estimates:agreed': [{ ...good, ref: 'TASK-0009' }] });
    await expectUnreadable(file, text);
  });

  test('정상 저장 추정은 다시 묻지 않고 그대로 보낸다', async () => {
    await writeDoc({ 'estimates:agreed': [good] });
    const fake = fakeApi();
    const { ctx, codex } = await context(home, fake.api);
    expect((await runPlanningJob(estimateJob(), ctx)).status).toBe('done');
    expect(codex.called('estimate')).toBe(0);
    expect(fake.schemaErrors).toEqual([]);
  });

  test('저장할 때도 같은 검증 함수로 막는다(잘못된 값을 디스크에 쓰지 않음)', async () => {
    const checkpoint = await (await PlanningCheckpoints.open(home)).load(EPOCH, workKey, 1);
    await expect(checkpoint.saveOutput('estimates:agreed', [{ ...good, agreedBy: ['Claude'] }] as never, isEstimates)).rejects.toThrow(/합의 주체/);
    await expect(readdir(join(home, 'state', 'planning'))).resolves.toEqual([]);
  });

  test('검증 함수 하나가 저장·재사용 기준이다', () => {
    expect(agreedEstimateProblem(good)).toBeNull();
    expect(agreedEstimateProblem({ ...good, agreedBy: ['Codex'] })).toMatch(/합의 주체/);
  });
});

describe('재리뷰 3: 보낸 요청에 필수 본문·경로 인자가 없으면 손상이다', () => {
  const key = 'submitEstimates:runner-1:00000000-0000-4000-8000-000000000001';
  const sentKey = `${estimateJob().id}@1:estimates`;
  test.each([
    ['본문 없음', { key, request: {} }],
    ['fence 없는 본문', { key, request: { body: { jobId: 'j', items: [] } } }],
    ['경로 인자가 필요한 보고에 params 없음', { key: 'submitTaskPlan:runner-1:00000000-0000-4000-8000-000000000002', request: { body: { fence: 1 } } }],
    ['Planning이 보내지 않는 보고 종류', { key: 'heartbeat:runner-1:00000000-0000-4000-8000-000000000003', request: { body: { fence: 1 } } }],
  ])('%s → 다시 보내지 않고 CHECKPOINT_UNREADABLE', async (_name, entry) => {
    const { file, text } = await writeDoc({ 'estimates:agreed': [good] }, { [sentKey]: entry });
    await expectUnreadable(file, text);
  });

  test('기록할 때도 같은 검증으로 막는다', async () => {
    const checkpoint = await (await PlanningCheckpoints.open(home)).load(EPOCH, workKey, 1);
    await expect(checkpoint.recordSent('j', 'estimates', { key, request: {} })).rejects.toThrow(/본문/);
  });
});
