import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ClaimedJob } from '../../src/api/generated/client.ts';
import { PlanningCheckpointError, type PlanningCheckpoint } from '../../src/planning/checkpoint.ts';
import { runPlanningJob, type PlanningJob } from '../../src/planning/index.ts';
import { PlanningReporter } from '../../src/planning/reporter.ts';
import { wireProblem } from '../../src/planning/wire.ts';
import { addOp, bootstrapJob, content, context, fakeApi, HASH, inputJob, NOW, tempHome, wbsSnapshot } from './harness.ts';

/*
 * 3차 리뷰(Codex, review3-codex.md): 디스크의 어떤 값도 전송 직전 관문(wireProblem)을 거치지 않고 서버로 가지 않는다.
 * 실제 job을 끝까지 돌려 만든 진행 기록의 「보낸 요청」을 하나씩 변조하고, 재실행이 아무것도 보내지 않고 멈추는지 본다.
 */

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ home, cleanup } = await tempHome()));
afterEach(async () => cleanup());

type Job<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
const lease = (id: string) => ({ id, leaseUntil: NOW, fence: 5 });
const tasks = [{ taskKey: 'TASK-0001', workType: 'Implementation' as const, subjectHash: HASH, content: content() }];

/** 시나리오마다: 준비 실행(앞 단계 기록)과 변조할 job */
const SCENARIOS: { name: string; prepare?: PlanningJob; job: PlanningJob; ops?: unknown[] }[] = [
  { name: '차이 분석 CP(기존 Task 수정 → taskJudgements)', job: inputJob(), ops: [addOp('NEW-1'), { op: 'modify', task: 'TASK-0001', field: 'doneCond', after: '새 완료 조건' }] },
  { name: '기존 Task 재판단', job: { ...lease('99999999-0000-4000-8000-999999999999'), kind: 'planning',
    payload: { tasks, policy: {}, proposal: null, planning: null } } as Job<'planning'> },
  { name: '초기 분석(진행·기술 결정)', job: bootstrapJob() },
  { name: '초안 등록', prepare: bootstrapJob(), job: bootstrapJob({ fence: 2, resumeStep: 'draft' }) },
  { name: '차이 분석 CP', job: inputJob() },
  { name: 'CP 판단', job: { ...lease('44444444-4444-4444-8444-444444444444'), kind: 'planning', payload: { tasks: [], policy: {}, proposal: {
    id: '33333333-3333-4333-8333-000000000001', ops: [{ ...addOp('NEW-1'), t: { ...addOp('NEW-1').t, splitBasis: '계약' } }],
    targets: [{ target: 'TASK-0002', subjectHash: HASH, before: content('이전'), after: content('이후') }],
    splitSubjectHash: 'd'.repeat(64), splitTasks: [{ taskKey: 'TASK-0001', content: content('원래') }] }, planning: null } } as Job<'planning'> },
  { name: 'Planning 세션', job: { ...lease('55555555-5555-4555-8555-555555555555'), kind: 'planning',
    payload: { tasks: [], policy: {}, proposal: null, ...{ planning: { id: '66666666-6666-4666-8666-666666666666', title: '주제', scope: '범위' } } } } },
  { name: '추정·등급 재판단', job: { ...lease('77777777-7777-4777-8777-777777777777'), kind: 'estimate',
    payload: { tasks, policy: { rejudge: { reason: 'grade_changed', trigger: '고정', targets: [{ taskKey: 'TASK-0001', roles: ['dev'] }] } } } } },
  { name: '분할', job: { ...lease('88888888-0000-4000-8000-888888888888'), kind: 'split', payload: { tasks, policy: {}, wbs: wbsSnapshot() } } },
];

/** 본문에서 선택 필드가 아닌 최상위 키. 선택 필드는 지워도 정상 요청이다. */
// judgedRules: submitTaskPlan의 선택 필드(추정 job의 등급 재판단은 보내지 않음). 지워도 계약상 정상 요청이라 형식으로 구별할 수 없다.
const OPTIONAL = new Set(['note', 'conditionJudgements', 'splitJudgements', 'taskJudgements', 'judgedRules']);
interface Doc { sent: Record<string, { key: string; request: { body: Record<string, unknown> } }> }

/** 키별 형식 오류 값: 합의 주체 하나, 틀린 신뢰도, 범위 역전, 숫자 아님, 빈 근거, 틀린 hash */
const BAD: Record<string, unknown> = { agreedBy: ['Claude'], confidence: 'x', loHours: 999, estHours: 'x', basis: '  ', subjectHash: 'bad' };

/** 변조 목록: BAD의 키가 나오는 곳마다 하나씩, 그리고 필수 최상위 필드를 하나씩 삭제 */
function tamperings(doc: Doc): { label: string; apply: (d: Doc) => void }[] {
  const out: { label: string; apply: (d: Doc) => void }[] = [];
  for (const [entryKey, entry] of Object.entries(doc.sent)) {
    const walk = (value: unknown, path: (string | number)[]) => {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          // 근거는 합의 기록(추정·판단)에서만 필수다. subagents.basis 같은 다른 근거는 계약상 빈 문자열도 된다.
          if (k in BAD && (k !== 'basis' || 'agreedBy' in value)) {
            const bad = BAD[k];
            out.push({ label: `${entryKey} ${[...path, k].join('.')}=${JSON.stringify(bad)}`, apply: (d) => set(d.sent[entryKey]?.request.body, [...path, k], bad) });
          }
          walk(v, [...path, k]);
        }
      }
    };
    walk(entry.request.body, []);
    for (const field of Object.keys(entry.request.body)) {
      if (field === 'fence' || OPTIONAL.has(field)) continue;
      out.push({ label: `${entryKey} ${field} 삭제`, apply: (d) => { const body = d.sent[entryKey]?.request.body; if (body) Reflect.deleteProperty(body, field); } });
    }
  }
  return out;
}
function set(root: unknown, path: (string | number)[], value: unknown) {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path.at(-1) as string | number] = value;
}

describe('저장된 보낸 요청을 하나씩 변조하면 아무것도 보내지 않는다', () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      if (scenario.prepare) await runPlanningJob(scenario.prepare, (await context(home, fakeApi().api)).ctx);
      const first = fakeApi();
      const prepared = await context(home, first.api);
      if (scenario.ops) prepared.claude.ops = scenario.ops as never;
      expect((await runPlanningJob(scenario.job, prepared.ctx)).status).toBe('done');
      expect(first.schemaErrors).toEqual([]);
      const dir = join(home, 'state', 'planning');
      const files = await readdir(dir);
      let checked = 0;
      for (const file of files) {
        const original = await readFile(join(dir, file), 'utf8');
        const doc = JSON.parse(original) as Doc;
        // 이 job이 보낸 요청만 변조한다(준비 실행의 요청은 이 job이 다시 보내지 않는다).
        const own = { ...doc, sent: Object.fromEntries(Object.entries(doc.sent).filter(([k]) => k.startsWith(`${scenario.job.id}@${String(scenario.job.fence)}:`))) };
        for (const tampering of tamperings(own)) {
          const copy = JSON.parse(original) as Doc;
          tampering.apply(copy);
          await writeFile(join(dir, file), JSON.stringify(copy));
          const fake = fakeApi();
          const outcome = await runPlanningJob(scenario.job, (await context(home, fake.api)).ctx);
          expect({ label: tampering.label, outcome: outcome.status, code: 'error' in outcome ? outcome.error.code : null, calls: fake.calls.length })
            .toEqual({ label: tampering.label, outcome: 'failed', code: 'CHECKPOINT_UNREADABLE', calls: 0 });
          checked++;
        }
        await writeFile(join(dir, file), original);
      }
      expect(checked).toBeGreaterThan(0);
      // 변조하지 않은 기록은 그대로 다시 보낸다(관문이 정상 요청을 막지 않음).
      const again = fakeApi();
      expect((await runPlanningJob(scenario.job, (await context(home, again.api)).ctx)).status).toBe('done');
    });
  }
});

describe('전송 직전 관문: 진행 기록 검사를 거치지 않은 값도 보내지 않는다', () => {
  const bad = { body: { jobId: 'j', fence: 1, items: [{ taskKey: 'TASK-0001', estHours: 2, loHours: 1, hiHours: 3, confidence: '중', basis: 'x', agreedBy: ['Claude'] }] } };
  /** load·recordSent의 검사를 하지 않는 가짜 진행 기록. 관문이 보고기 안에 있다는 것만 따로 보인다. */
  const unchecked = (sent?: unknown) => ({
    epoch: 3, sent: () => (sent ? { key: 'submitEstimates:runner-1:00000000-0000-4000-8000-000000000001', request: sent } : undefined),
    recordSent: () => Promise.resolve(),
  }) as unknown as PlanningCheckpoint;

  test('재전송: 저장된 본문이 관문을 통과하지 못하면 보내지 않는다', async () => {
    const fake = fakeApi();
    const reporter = new PlanningReporter({ api: fake.api, epoch: 3, runnerId: 'runner-1', jobId: 'j', checkpoint: unchecked(bad) });
    await expect(reporter.send('submitEstimates', 'estimates', bad as never, { to: { params: null } })).rejects.toBeInstanceOf(PlanningCheckpointError);
    expect(fake.calls).toEqual([]);
  });

  test('첫 전송: 새로 만든 본문도 같은 관문을 지난다', async () => {
    const fake = fakeApi();
    const reporter = new PlanningReporter({ api: fake.api, epoch: 3, runnerId: 'runner-1', jobId: 'j', checkpoint: unchecked() });
    await expect(reporter.send('submitEstimates', 'estimates', () => Promise.resolve(bad as never), { to: { params: null } })).rejects.toThrow(/합의 주체/);
    expect(fake.calls).toEqual([]);
  });

  test('관문 함수: 추정·판단의 합의 주체 둘, 필수 목록', () => {
    expect(wireProblem('submitEstimates', bad)).toMatch(/합의 주체/);
    expect(wireProblem('submitEstimates', { body: { jobId: 'j', fence: 1 } })).toMatch(/items/);
    const both = { ...bad.body.items[0], agreedBy: ['Claude', 'Codex'] };
    expect(wireProblem('submitEstimates', { body: { ...bad.body, items: [{ ...both, loHours: 9 }] } })).toMatch(/낙관 ≤ 예상 ≤ 비관/);
    expect(wireProblem('submitEstimates', { body: { ...bad.body, items: [{ ...both, estHours: 'x' }] } })).toMatch(/유한한 수/);
    expect(wireProblem('submitEstimates', { body: { ...bad.body, items: [{ ...bad.body.items[0], agreedBy: ['Claude', 'Codex'] }] } })).toBeNull();
    const judged = (agreedBy: string[]) => ({ schemaVersion: 1, items: [{ rule: 'revert', result: 'met', agreedBy, basis: 'b', judgedAt: NOW, sourceRef: 'j', subjectHash: HASH }] });
    const judgements = (agreedBy: string[]) => ({ params: { id: 'cp' }, body: { jobId: 'j', fence: 1, judgements: [{ target: 'TASK-0001', judgedRules: judged(agreedBy) }] } });
    expect(wireProblem('submitProposalJudgements', judgements(['Codex']))).toMatch(/합의 주체/);
    expect(wireProblem('submitProposalJudgements', judgements(['Claude', 'Codex']))).toBeNull();
  });
});

describe('저장된 합의 추정과 보낸 추정 본문이 다르면 손상이다', () => {
  test('둘 다 형식은 맞지만 값이 다르면 보내지 않는다', async () => {
    const job = SCENARIOS.find((s) => s.name === '추정·등급 재판단')?.job as PlanningJob;
    await runPlanningJob(job, (await context(home, fakeApi().api)).ctx);
    const dir = join(home, 'state', 'planning');
    const [file] = await readdir(dir);
    const doc = JSON.parse(await readFile(join(dir, file ?? ''), 'utf8')) as Doc;
    const entry = doc.sent[`${job.id}@${String(job.fence)}:estimates`];
    const [item] = entry?.request.body.items as { estHours: number }[];
    if (item) item.estHours = 2.5;
    await writeFile(join(dir, file ?? ''), JSON.stringify(doc));
    const fake = fakeApi();
    expect(await runPlanningJob(job, (await context(home, fake.api)).ctx)).toMatchObject({ status: 'failed', error: { code: 'CHECKPOINT_UNREADABLE' } });
    expect(fake.calls).toEqual([]);
  });
});
