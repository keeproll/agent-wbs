import type { PoolClient } from '@awbs/db';
import { completionGate, isBlocked, type Dependency as DomainDependency, type TaskStatus } from '@awbs/shared';
import { gateInputs } from '../execution/gate.ts';
import { specBody, type Ac, type Design, type Output, type Overview } from './hash.ts';
import { taskSchedules } from '../planning/schedule.ts';
import { wbsPaths } from './wbs.ts';

/** timestamptz를 마이크로초까지 보존한 UTC ISO 문자열로 읽는다. JS Date는 밀리초에서 잘린다. */
export const iso = (column: string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface TaskRow {
  id: string; task_key: string; wbs_node_id: string; sort_order: number; title: string; work_type: string; primary_domain: string;
  related_domains: string[]; priority: number; assignee_agent: string | null; verifier_agent: string | null; status: TaskStatus;
  verif_state: string; planning_approved_at: string | null; updated_at: string; deleted_at: string | null; conflict_group: string | null;
  src_v: number | null;
}
interface DepRow { id: string; pred: string; succ: string; dep_type: 'FS' | 'SS' }
interface NodeRow { id: string; kind: 'phase' | 'work_package'; parent_id: string | null; title: string; sort_order: number }

const TASK_COLUMNS = `t.id,t.task_key,t.wbs_node_id,t.sort_order,t.title,t.work_type,t.primary_domain,t.related_domains::text[] as related_domains,
  t.priority,t.assignee_agent,t.verifier_agent,t.status,t.verif_state,${iso('t.planning_approved_at')} as planning_approved_at,
  ${iso('t.updated_at')} as updated_at,${iso('t.deleted_at')} as deleted_at,t.conflict_group,iv.v as src_v`;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const lines = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
export const overviewOf = (value: unknown): Overview => {
  const o = (value ?? {}) as Record<string, unknown>;
  return { purpose: text(o.purpose), background: text(o.background), scope: lines(o.scope), out: lines(o.out), precond: text(o.precond), doneCond: text(o.doneCond) };
};
export const acOf = (value: unknown): Ac[] => (Array.isArray(value) ? value : []).map((item: unknown) => {
  const a = (item ?? {}) as Record<string, unknown>;
  return { given: text(a.given), when: text(a.when), then: text(a.then), method: text(a.method) };
});

/** 프로젝트 전체의 Task·관계·노드. 차단과 WBS 번호는 전체를 보고 계산한다(G§9.1-2). */
async function loadGraph(client: PoolClient, projectId: string) {
  const [tasks, deps, nodes, checklist, outputs] = await Promise.all([
    client.query<TaskRow>(`select ${TASK_COLUMNS} from tasks t left join input_versions iv on iv.id=t.src_input_version where t.project_id=$1`, [projectId]),
    client.query<DepRow>('select id,pred,succ,dep_type from task_dependencies where project_id=$1', [projectId]),
    client.query<NodeRow>('select id,kind,parent_id,title,sort_order from wbs_nodes where project_id=$1', [projectId]),
    client.query<{ task: string; required: boolean; done: boolean }>('select task,required,done from checklist_items where project_id=$1', [projectId]),
    client.query<{ task: string; name: string; required: boolean; delivered: boolean }>('select task,name,required,delivered from task_outputs where project_id=$1', [projectId]),
  ]);
  const gates = new Map([...(await gateInputs(client,tasks.rows.map(task => task.id)))].map(([id,input]) => [id,completionGate(input)]));
  return { tasks: tasks.rows, deps: deps.rows, nodes: nodes.rows, checklist: checklist.rows, outputs: outputs.rows, gates };
}
type Graph = Awaited<ReturnType<typeof loadGraph>>;

type Schedules = Awaited<ReturnType<typeof taskSchedules>>;

function summarize(graph: Graph, schedules: Schedules) {
  const keyOf = new Map(graph.tasks.map((task) => [task.id, task.task_key]));
  const live = graph.tasks.filter((task) => !task.deleted_at);
  const domainTasks = live.map((task) => ({ id: task.id, status: task.status }));
  const domainDeps: DomainDependency[] = graph.deps.map((dep) => ({ pred: dep.pred, succ: dep.succ, type: dep.dep_type }));
  const paths = wbsPaths(
    graph.nodes.map((node) => ({ id: node.id, kind: node.kind, parentId: node.parent_id, sortOrder: node.sort_order })),
    graph.tasks.map((task) => ({ id: task.id, wbsNodeId: task.wbs_node_id, sortOrder: task.sort_order, deleted: task.deleted_at !== null })),
  );
  const summary = (task: TaskRow) => {
    const checklist = graph.checklist.filter((item) => item.task === task.id);
    const gate = graph.gates.get(task.id) ?? [];
    return {
      id: task.id, taskKey: task.task_key, wbsNodeId: task.wbs_node_id, wbsPath: paths.task.get(task.id) ?? '', title: task.title,
      workType: task.work_type, primaryDomain: task.primary_domain, relatedDomains: task.related_domains, priority: task.priority,
      assigneeAgent: task.assignee_agent, verifierAgent: task.verifier_agent, lifecycleStatus: task.status, verifState: task.verif_state,
      blocked: !task.deleted_at && isBlocked(domainTasks, domainDeps, task.id),
      preds: graph.deps.filter((dep) => dep.succ === task.id).map((dep) => keyOf.get(dep.pred) ?? '').sort(),
      checklist: { done: checklist.filter((item) => item.done).length, total: checklist.length },
      gate: { passed: gate.filter((condition) => condition.result === 'PASS').length, total: gate.length },
      // 일정 요약(M2-07 일정 계산). 계산할 수 없으면 null.
      schedule: schedules.get(task.task_key) ?? null,
      updatedAt: task.updated_at, deletedAt: task.deleted_at,
    };
  };
  return { keyOf, paths, summary };
}

export interface ListFilter { status?: string | undefined; q?: string | undefined; includeDeleted?: boolean | undefined }

export async function listTasks(client: PoolClient, projectId: string, filter: ListFilter) {
  const graph = await loadGraph(client, projectId);
  const { paths, summary } = summarize(graph, await taskSchedules(client, projectId));
  const q = filter.q?.trim().toLowerCase();
  const tasks = graph.tasks
    .filter((task) => (filter.includeDeleted || !task.deleted_at) && (!filter.status || task.status === filter.status) &&
      (!q || task.title.toLowerCase().includes(q) || task.task_key.toLowerCase().includes(q)))
    .map(summary)
    .sort((a, b) => (a.wbsPath && b.wbsPath ? compareWbs(a.wbsPath, b.wbsPath) : a.wbsPath ? -1 : b.wbsPath ? 1 : 0) || (a.taskKey < b.taskKey ? -1 : 1));
  const nodes = graph.nodes.map((node) => ({
    id: node.id, kind: node.kind, parentId: node.parent_id, title: node.title, wbsPath: paths.node.get(node.id) ?? '', sortOrder: node.sort_order,
  })).sort((a, b) => compareWbs(a.wbsPath, b.wbsPath));
  return { nodes, tasks };
}

const compareWbs = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? -1) - (y[i] ?? -1);
    if (diff) return diff;
  }
  return 0;
};

/** Task 상세. 없으면 null. 삭제된 Task도 이력 확인을 위해 돌려준다(deletedAt). */
/**
 * `withSchedule`: 일정 요약을 계산한다. 일정은 프로젝트 전체를 계산해야 해서(Task 150여 개에 약 0.2초) 조회 응답(GET 상세)에서만 켠다.
 * 쓰기 경로 안의 상세(변경 응답·충돌 창·승인 검사)는 일정 요약을 null로 둔다(계약상 nullable).
 */
export async function taskDetail(client: PoolClient, taskKey: string, withSchedule = false) {
  const found = (await client.query<{ project_id: string }>('select project_id from tasks where task_key=$1', [taskKey])).rows[0];
  if (!found) return null;
  const graph = await loadGraph(client, found.project_id);
  const { keyOf, summary } = summarize(graph, withSchedule ? await taskSchedules(client, found.project_id) : new Map());
  const task = graph.tasks.find((item) => item.task_key === taskKey);
  if (!task) return null;
  const [spec, outputs, designs, checklist, grades, subagents, split, estimate, execution] = await Promise.all([
    client.query<{ overview: unknown; spec: Record<string, unknown>; ac: unknown }>('select overview,spec,ac from task_specs where task=$1', [task.id]),
    client.query<Output>('select name,kind,required,verify,delivered from task_outputs where task=$1 order by name', [task.id]),
    client.query<Design>('select kind,content from task_designs where task=$1 order by kind', [task.id]),
    client.query<{ item_key: string; content: string; required: boolean; done: boolean; verify_method: string; evidence: unknown; note: string | null }>(
      'select item_key,content,required,done,verify_method,evidence,note from checklist_items where task=$1 order by sort_order,item_key', [task.id]),
    client.query<{ role: 'dev' | 'qa'; model_id: string; effort: string; reason: string; locked: boolean }>('select role,model_id,effort,reason,locked from task_grades where task=$1', [task.id]),
    client.query<{ role: 'dev' | 'qa'; def_key: string }>('select s.role,d.def_key from task_subagents s join subagent_defs d on d.id=s.subagent_id where s.task=$1 order by d.def_key', [task.id]),
    client.query<{ basis: string; judged_rules: unknown; exceptions: unknown }>('select basis,judged_rules,exceptions from task_splits where task=$1', [task.id]),
    client.query<{ estHours: number; loHours: number; hiHours: number; tokensK: number | null; confidence: string; basis: string; agreedBy: string; at: string }>(
      `select est::float8 "estHours",lo::float8 "loHours",hi::float8 "hiHours",tokens_k::float8 "tokensK",confidence,basis,agreed_by "agreedBy",${iso('created_at')} at
       from task_estimates where task=$1 order by created_at desc,id desc limit 1`, [task.id]),
    client.query<{ fixStart: string | null; actStart: string | null; actEnd: string | null; actualHours: number }>(
      `select to_char(fix_start,'YYYY-MM-DD') "fixStart",${iso('act_start')} "actStart",${iso('act_end')} "actEnd",
       coalesce((select sum(greatest(0,extract(epoch from (coalesce(ended_at,clock_timestamp())-started_at)))/3600)::float8
         from task_attempts where task=$1),0) "actualHours" from tasks where id=$1`, [task.id]),
  ]);
  const stored = spec.rows[0];
  const dependency = (dep: DepRow) => ({ id: dep.id, pred: keyOf.get(dep.pred) ?? '', succ: keyOf.get(dep.succ) ?? '', type: dep.dep_type });
  const byPred = (a: { pred: string }, b: { pred: string }) => (a.pred < b.pred ? -1 : 1);
  const byKey = (a: { succ: string }, b: { succ: string }) => (a.succ < b.succ ? -1 : 1);
  const grade = (role: 'dev' | 'qa') => {
    const row = grades.rows.find((item) => item.role === role);
    return row ? { modelId: row.model_id, effort: row.effort, reason: row.reason, locked: row.locked } : null;
  };
  const splitRow = split.rows[0];
  return {
    ...summary(task),
    spec: { overview: overviewOf(stored?.overview), spec: specBody(stored?.spec ?? {}), ac: acOf(stored?.ac) },
    outputs: outputs.rows,
    designs: designs.rows,
    checklistItems: checklist.rows.map((item) => ({
      itemKey: item.item_key, content: item.content, required: item.required, done: item.done, verifyMethod: item.verify_method || null,
      evidence: item.evidence == null ? null : typeof item.evidence === 'string' ? item.evidence : JSON.stringify(item.evidence), note: item.note,
    })),
    predecessors: graph.deps.filter((dep) => dep.succ === task.id).map(dependency).sort(byPred),
    successors: graph.deps.filter((dep) => dep.pred === task.id).map(dependency).sort(byKey),
    planningApprovedAt: task.planning_approved_at,
    estimate: estimate.rows[0] ?? null,
    ...execution.rows[0],
    conflictGroup: task.conflict_group,
    srcInputVersion: task.src_v,
    grades: { dev: grade('dev'), qa: grade('qa') },
    subagents: { dev: subagents.rows.filter((row) => row.role === 'dev').map((row) => row.def_key), qa: subagents.rows.filter((row) => row.role === 'qa').map((row) => row.def_key) },
    split: splitRow ? { basis: splitRow.basis, judgedRules: splitRow.judged_rules ?? null, exceptions: Array.isArray(splitRow.exceptions) ? splitRow.exceptions : [] } : null,
    projectId: found.project_id,
  };
}
export type TaskDetail = NonNullable<Awaited<ReturnType<typeof taskDetail>>>;

/** 응답에는 계약에 없는 내부 필드(projectId)를 내보내지 않는다. */
export const publicDetail = (detail: TaskDetail) => {
  const { projectId, ...rest } = detail;
  void projectId;
  return rest;
};
