// 전 API 범위 밖 시각 회귀(M2-08 재리뷰 R2). 이 앱에 등록된 모든 경로에서 시각·날짜 입력(쿼리·본문 최상위)에
// 연도 0000·10000·없는 날짜를 넣으면 400이어야 한다. 500(DB 변환 실패)이 나면 안 된다.
// 본문은 가능한 한 유효한 값(같은 경로의 GET 응답, 만든 초안)을 바탕으로 시각 칸 하나만 망가뜨린다.
import { OPERATIONS, type Operation } from '@awbs/shared/api';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { encodeCursor } from '../src/changes/history.ts';
import { harness, projectWith, type Body, type Harness } from './m208-fixture.ts';

let h: Harness;
let draftId = '';
beforeAll(async () => {
  h = await harness('m208_time_range');
  await projectWith(h.owner, ['ready']);
  draftId = (await h.lead('POST', '/api/messages', { taskKey: 'TASK-0001', type: '질문', toAgent: 'Claude', body: 'x' })).body.id as string;
});
afterAll(async () => { await h.close(); });

const BAD_TIMES = ['0000-01-01T00:00:00Z', '10000-01-01T00:00:00Z', '2026-02-30T00:00:00Z', '1969-12-31T23:59:59Z'];
const BAD_DATES = ['0000-01-01', '10000-01-01', '2026-02-30'];
const props = (schema: unknown) => ((schema ?? {}) as { properties?: Record<string, { title?: string; anyOf?: { title?: string }[] }> }).properties ?? {};
const kindOf = (node: { title?: string; anyOf?: { title?: string }[] }) =>
  [node.title, ...(node.anyOf ?? []).map((x) => x.title)].find((t) => t === 'Timestamp' || t === 'DateOnly');

/** 이 앱에 실제로 등록된 경로 중 시각·날짜 입력이 있는 것 */
const targets = () => OPERATIONS.filter((op) => h.app.hasRoute({ method: op.method, url: op.path }))
  .flatMap((op) => (['query', 'body'] as const).flatMap((where) =>
    Object.entries(props(op[where])).flatMap(([field, node]) => { const kind = kindOf(node); return kind ? [{ op, where, field, kind }] : []; })));

async function baseBody(op: Operation): Promise<Record<string, unknown>> {
  const get = OPERATIONS.find((o) => o.method === 'GET' && o.path === op.path);
  if (op.method === 'PUT' && get) {
    const current = (await h.lead('GET', op.path)).body as Record<string, unknown>;
    const base = Object.fromEntries(Object.entries(current).filter(([k]) => k in props(op.body)));
    return op.id === 'putSubagentSettings' ? { ...base, allowed: [] } : base;
  }
  if (op.path.startsWith('/api/messages/:messageId')) {
    const current = (await h.lead('GET', '/api/messages?taskKey=TASK-0001')).body.items.find((m: { id: string }) => m.id === draftId) as Body;
    return op.id === 'updateMessageDraft' ? { updatedAt: current.updatedAt, body: 'x' } : { updatedAt: current.updatedAt };
  }
  // M2 통합: 다른 작업(M2-02·M2-03·M2-07)의 경로도 시각 칸 하나만 망가지도록 나머지 필수 칸을 채운다.
  return EXTRA_BODY[op.id] ?? {};
}

const SHA = 'a'.repeat(40);
const UUID = '00000000-0000-4000-8000-000000000000';
const EXTRA_BODY: Record<string, Record<string, unknown>> = {
  choosePlanningReview: { choice: 'x' },
  rejectProposal: { comment: '반려 사유' },
  requestChangesProposal: { comment: '수정 사유' },
  updateProject: { name: 'x', description: '', startDate: '2026-11-27', targetDate: null, updatedAt: '2026-11-27T00:00:00Z' },
  excludeProposalOp: { index: 0 },
  // srv-perf: createTask에 고정 시작일(fixStart, DateOnly)이 생겼다. 나머지 필수 칸을 채워 날짜 칸만 망가지게 한다.
  createTask: { title: 'x', wbsNodeId: UUID, workType: 'Implementation', primaryDomain: 'BE' },
  approveProposal: { previewHash: 'a'.repeat(64) },
  applyProposal: { previewHash: 'a'.repeat(64) },
  analyzeInputs: { commit: SHA, commits: [] },
  skipInputs: { commits: [] },
  retryInputs: { version: 1 },
  createProject: { name: 'x', url: 'https://github.com/o/r', constraints: [], instruction: '', repoCheckId: UUID },
  addChecklistItem: { content: 'x', required: false },
  updateTask: { title: 'x', updatedAt: '2026-11-27T00:00:00Z' },
  lockTaskGrade: { role: 'dev', modelId: 'claude-sonnet-5-5', effort: 'high' },
  updateTaskSpec: { ac: [] },
  updateChecklistItem: { done: false },
  addDependency: { predTaskKey: 'TASK-0002', depType: 'FS' },
  addSplitException: { rule: 'one', why: 'x' },
  updateTaskOutputs: { outputs: [] },
  updateTaskDesign: { content: {} },
};
/** 경로 변수도 형식에 맞는 값을 넣는다. 형식이 틀리면 시각보다 경로 변수 오류가 먼저 나온다. */
const urlOf = (op: Operation) => op.path.replace(':messageId', draftId).replace(':taskKey', 'TASK-0001').replace(':kind', 'DB').replace(/:\w+/g, UUID);

test('등록된 경로의 시각·날짜 입력을 빠짐없이 찾는다', () => {
  const found = targets().map((t) => `${t.op.id}.${t.where}.${t.field}`);
  console.log('TIME INPUTS', JSON.stringify(found));
  expect(found).toEqual(expect.arrayContaining(['listHistory.query.from', 'listHistory.query.to', 'pollMessages.query.since',
    'updateMessageDraft.body.updatedAt', 'sendMessage.body.updatedAt', 'putExecPolicy.body.updatedAt', 'putModelSettings.body.updatedAt']));
});

test('전 경로: 범위 밖 시각·날짜는 400(500 아님), 오류 위치는 그 칸', async () => {
  const failures: string[] = [];
  for (const { op, where, field, kind } of targets()) {
    for (const bad of kind === 'DateOnly' ? BAD_DATES : BAD_TIMES) {
      const url = urlOf(op);
      const isRunner = op.principal === 'runner';
      const res = where === 'query'
        ? await (isRunner ? h.runner : h.lead)(op.method, `${url}?${field}=${encodeURIComponent(bad)}${op.id === 'getChanges' ? '&after=0' : ''}${op.id === 'unlockTaskGrade' ? '&role=dev' : ''}`)
        : await (isRunner ? h.runner : h.lead)(op.method, url, { ...(await baseBody(op)), [field]: bad });
      const paths = ((res.body as Body)?.error?.errors ?? []).map((e: { path: string }) => e.path) as string[];
      if (res.status !== 400 || !paths.some((p) => p.endsWith(field))) failures.push(`${op.id} ${where}.${field}=${bad} → ${String(res.status)} ${JSON.stringify(paths)}`);
    }
  }
  expect(failures).toEqual([]);
});

test('커서 안의 범위 밖 시각도 세 경로 모두 400', async () => {
  for (const at of ['0000-01-01T00:00:00Z', '10000-01-01T00:00:00Z', '1969-12-31T23:59:59Z']) {
    const cursor = encodeCursor([at, '00000000-0000-4000-8000-000000000000']);
    const statuses = [
      (await h.lead('GET', `/api/history?cursor=${cursor}`)).status,
      (await h.lead('GET', `/api/messages?cursor=${cursor}`)).status,
      (await h.runner('GET', `/api/runner/messages?cursor=${cursor}`)).status,
    ];
    expect(statuses, at).toEqual([400, 400, 400]);
  }
});
