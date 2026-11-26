/**
 * WBS E2E용 가짜 API — fakeApi 위에 WBS 화면이 부르는 요청을 더한다.
 * 목록 조회는 서버처럼 status·q를 거르고, Task 생성·선행 추가는 메모리 목록을 바꾼다.
 */
import type { Page } from '@playwright/test';
import type { ResponseOf } from '../../src/shared/api/contract.ts';
import { fakeApi, errorBody, json, RUNNER, type FakeApi, type Handler } from './fake-api.ts';
import { PROJECT_ID, SCHEDULE, TASK_LIST, type ScheduleData, type TaskList, type TaskSummary } from './wbs-fixture.ts';

export const RUNNER_WITH_LIMIT = { ...RUNNER, concurrency: { limit: 10, caps: { total: 10 } } } as unknown as ResponseOf<'getRunnerState'>;

export interface WbsApi extends FakeApi {
  list: TaskList;
  /** 목록 요청을 바꾼다(지연·실패 등). 기본은 서버처럼 거른 결과. */
  onList: (handler: Handler) => void;
  serveList: Handler;
}

const detailOf = (t: TaskSummary) => ({
  ...t,
  spec: { overview: { purpose: '', background: '', scope: [], out: [], precond: '', doneCond: '' }, spec: {}, ac: [] },
  outputs: [], designs: [], checklistItems: [], predecessors: [], successors: [], planningApprovedAt: null, conflictGroup: null,
  srcInputVersion: null, grades: { dev: null, qa: null }, subagents: { dev: [], qa: [] }, split: null,
});

export async function wbsApi(page: Page, options: { list?: TaskList; schedule?: ScheduleData | null } = {}): Promise<WbsApi> {
  const api = await fakeApi(page);
  const list: TaskList = structuredClone(options.list ?? TASK_LIST);
  api.on('GET /api/runner-state', (route) => json(route, 200, RUNNER_WITH_LIMIT));
  api.on('GET /api/schedule', (route) => (options.schedule === null ? json(route, 503, errorBody('UNAVAILABLE')) : json(route, 200, options.schedule ?? SCHEDULE)));
  const serveList: Handler = (route, request) => {
    const url = new URL(request.url());
    const q = url.searchParams.get('q')?.toLowerCase();
    const status = url.searchParams.get('status');
    const tasks = list.tasks.filter((t) => (!status || t.lifecycleStatus === status) && (!q || t.title.toLowerCase().includes(q) || t.taskKey.toLowerCase().includes(q)));
    return json(route, 200, { nodes: list.nodes, tasks });
  };
  api.on(`GET /api/projects/${PROJECT_ID}/tasks`, serveList);
  const onTask = (t: TaskSummary) => {
    api.on(`GET /api/tasks/${t.taskKey}`, (route) => json(route, 200, detailOf(t)));
    api.on(`POST /api/tasks/${t.taskKey}/dependencies`, async (route, request) => {
      const body = request.postDataJSON() as { predTaskKey: string };
      t.preds = [...t.preds, body.predTaskKey].sort();
      t.updatedAt = new Date().toISOString();
      t.blocked = t.preds.some((k) => list.tasks.find((x) => x.taskKey === k)?.lifecycleStatus !== 'done');
      await json(route, 201, { dependency: { id: `dep-${body.predTaskKey}`, pred: body.predTaskKey, succ: t.taskKey, type: 'FS' }, blocked: t.blocked });
    });
  };
  list.tasks.forEach(onTask);
  api.on('GET /api/tasks/TASK-9999', (route) => json(route, 404, errorBody('TASK_NOT_FOUND', { message: 'Task를 찾을 수 없습니다.' })));
  api.on(`POST /api/projects/${PROJECT_ID}/tasks`, async (route, request) => {
    const body = request.postDataJSON() as { title: string; wbsNodeId: string; workType: string; primaryDomain: string; relatedDomains: string[]; priority: number; assigneeAgent: string; verifierAgent: string };
    const wp = list.nodes.find((n) => n.id === body.wbsNodeId && n.kind === 'work_package');
    if (!wp) { await json(route, 404, errorBody('WBS_NODE_NOT_FOUND', { message: '상위 Work Package를 찾을 수 없습니다.', fix: '목록을 다시 불러와 실제 Work Package를 고르세요.' })); return; }
    const n = list.tasks.length + 1;
    const taskKey = `TASK-${String(n).padStart(4, '0')}`;
    const siblings = list.tasks.filter((t) => t.wbsNodeId === wp.id).length;
    const t = {
      id: `id-${taskKey}`, taskKey, wbsNodeId: wp.id, wbsPath: `${wp.wbsPath}.${String(siblings + 1)}`, title: body.title, workType: body.workType,
      primaryDomain: body.primaryDomain, relatedDomains: body.relatedDomains, priority: body.priority, assigneeAgent: body.assigneeAgent,
      verifierAgent: body.verifierAgent, lifecycleStatus: 'planning', verifState: 'none', blocked: false, preds: [], checklist: { done: 0, total: 0 },
      gate: { passed: 0, total: 5 }, schedule: null, updatedAt: new Date().toISOString(), deletedAt: null,
    } as unknown as TaskSummary;
    list.tasks.push(t);
    onTask(t);
    await json(route, 201, { id: t.id, taskKey, wbsPath: t.wbsPath, lifecycleStatus: 'planning' });
  });
  return { ...api, list, serveList, onList: (handler) => { api.on(`GET /api/projects/${PROJECT_ID}/tasks`, handler); } };
}
