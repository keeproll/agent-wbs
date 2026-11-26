import assert from 'node:assert/strict';
import { splitSettingsToDomain, type PoolClient } from '@awbs/db';
import type {
  Agent, Confidence, DesignKind, JudgedRules, ProposalSnapshot, ProposalTask, SplitException, SplitSettings, TaskStatus, TechDomain, WorkType,
} from '@awbs/shared';
import { specBody, type Design, type JudgedSource, type Output } from '../tasks/hash.ts';
import { acOf, overviewOf } from '../tasks/read.ts';

/**
 * 변경 제안 시뮬레이션의 입력(ProposalSnapshot)을 DB에서 읽는다.
 * 미리보기·승인·반영이 모두 이 함수로 현재 상태를 읽으므로, 같은 DB 상태면 같은 결과가 나온다(contracts §2.1).
 */
export interface Loaded {
  snapshot: ProposalSnapshot;
  /** Task 키 → DB id */
  ids: Map<string, string>;
  /** Task 키 → 판단 대상 계산에 쓰는 현재 내용(M2-02 JudgedSource) */
  sources: Map<string, JudgedSource>;
  settings: SplitSettings;
}

interface TaskRow {
  id: string; task_key: string; wbs_node_id: string; status: TaskStatus; title: string; work_type: WorkType; primary_domain: TechDomain;
  related_domains: TechDomain[]; priority: number; assignee_agent: Agent | null; verifier_agent: Agent | null; conflict_group: string | null;
  overview: unknown; spec: Record<string, unknown> | null; ac: unknown; started: boolean;
  basis: string | null; judged_rules: JudgedRules | null; exceptions: SplitException[] | null;
  est: string | null; lo: string | null; hi: string | null; confidence: Confidence | null;
}

/** P DESIGN의 변경 항목(`ents`). 분할 점검은 개수만 본다(shared adapters와 같은 규칙). */
const designItems = (content: Record<string, unknown>): string[] =>
  Array.isArray(content.ents) ? content.ents.map((item) => JSON.stringify(item)) : [];

export async function loadSnapshot(client: PoolClient, projectId: string): Promise<Loaded> {
  const [tasks, deps, nodes, designs, outputs, checklist, counter, settings] = await Promise.all([
    client.query<TaskRow>(
      `select t.id,t.task_key,t.wbs_node_id,t.status,t.title,t.work_type,t.primary_domain,t.related_domains::text[] as related_domains,t.priority,
              t.assignee_agent,t.verifier_agent,t.conflict_group,s.overview,s.spec,s.ac,
              (exists(select 1 from task_attempts a where a.task=t.id) or exists(select 1 from execution_holds h where h.task=t.id and h.closed_at is null)) as started,
              sp.basis,sp.judged_rules,sp.exceptions,e.est::text as est,e.lo::text as lo,e.hi::text as hi,e.confidence
         from tasks t left join task_specs s on s.task=t.id left join task_splits sp on sp.task=t.id
         left join lateral (select est,lo,hi,confidence from task_estimates where project_id=t.project_id and task=t.id order by created_at desc,id desc limit 1) e on true
        where t.project_id=$1 and t.deleted_at is null order by t.task_key`, [projectId]),
    client.query<{ pred: string; succ: string; type: 'FS' | 'SS' }>(
      `select p.task_key as pred,s.task_key as succ,d.dep_type as type from task_dependencies d join tasks p on p.id=d.pred join tasks s on s.id=d.succ
        where d.project_id=$1 and p.deleted_at is null and s.deleted_at is null order by p.task_key,s.task_key`, [projectId]),
    client.query<{ id: string; kind: 'phase' | 'work_package'; parent_id: string | null }>('select id,kind,parent_id from wbs_nodes where project_id=$1 order by sort_order,id', [projectId]),
    client.query<Design & { task: string }>('select task,kind,content from task_designs where project_id=$1', [projectId]),
    client.query<Output & { task: string }>('select task,name,kind,required,verify,delivered from task_outputs where project_id=$1', [projectId]),
    client.query<{ task: string; item_key: string; content: string; required: boolean; done: boolean; verify_method: string }>(
      'select task,item_key,content,required,done,verify_method from checklist_items where project_id=$1 order by sort_order,item_key', [projectId]),
    // 표시 ID 순번은 counters가 기준이다(지운 Task 번호도 재사용하지 않는다). 없으면 기존 최대값.
    client.query<{ value: number }>(
      `select greatest(coalesce((select value from counters where project_id=$1 and kind='task'),0),
                       coalesce((select max((substring(task_key from 6))::bigint) from tasks where project_id=$1),0))::int as value`, [projectId]),
    client.query<{ split: Record<string, unknown> }>('select split from app_settings where singleton'),
  ]);
  const split = settings.rows[0]?.split;
  assert(split, '분할 기준 설정이 필요합니다.');
  const byTask = <T extends { task: string }>(rows: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.task, [...(map.get(row.task) ?? []), row]);
    return map;
  };
  const designMap = byTask(designs.rows);
  const outputMap = byTask(outputs.rows);
  const checklistMap = byTask(checklist.rows);

  const ids = new Map<string, string>();
  const sources = new Map<string, JudgedSource>();
  const proposalTasks: ProposalTask[] = tasks.rows.map((row) => {
    ids.set(row.task_key, row.id);
    const overview = overviewOf(row.overview);
    const spec = specBody(row.spec ?? {});
    const ac = acOf(row.ac);
    const taskDesigns = (designMap.get(row.id) ?? []).map(({ kind, content }) => ({ kind, content }));
    sources.set(row.task_key, {
      title: row.title, overview, spec: row.spec ?? {}, ac, conflictGroup: row.conflict_group,
      outputs: (outputMap.get(row.id) ?? []).map(({ name, kind, required, verify, delivered }) => ({ name, kind, required, verify, delivered })),
      designs: taskDesigns,
    });
    return {
      id: row.task_key, status: row.status, title: row.title, workType: row.work_type, primaryDomain: row.primary_domain,
      relatedDomains: row.related_domains, priority: row.priority,
      // 담당이 비어 있는 Task는 없도록 생성하지만, 비어 있으면 시뮬레이션 기본값(Claude 개발 → Codex QA)으로 본다.
      assignee: row.assignee_agent ?? 'Claude', verifier: row.verifier_agent ?? 'Codex',
      purpose: overview.purpose, scope: overview.scope, doneCond: overview.doneCond, ac, files: spec.files,
      design: taskDesigns.map(({ kind, content }) => ({ kind: kind as DesignKind, items: designItems(content) })),
      estimate: row.est === null ? null : { est: Number(row.est), lo: Number(row.lo), hi: Number(row.hi), confidence: row.confidence ?? '하' },
      conflictGroup: row.conflict_group, splitBasis: row.basis ?? '', judgedRules: row.judged_rules,
      checklist: (checklistMap.get(row.id) ?? []).map((item) => ({ id: item.item_key, text: item.content, required: item.required, done: item.done, method: item.verify_method })),
      exceptions: Array.isArray(row.exceptions) ? row.exceptions : [], hasExecutionHistory: row.started,
    };
  });
  const wpTasks = new Map<string, string[]>();
  for (const row of tasks.rows) wpTasks.set(row.wbs_node_id, [...(wpTasks.get(row.wbs_node_id) ?? []), row.task_key]);
  const phases = nodes.rows.filter((node) => node.kind === 'phase').map((phase) => ({
    id: phase.id,
    wps: nodes.rows.filter((node) => node.kind === 'work_package' && node.parent_id === phase.id).map((node) => ({ id: node.id, tasks: wpTasks.get(node.id) ?? [] })),
  }));
  return {
    snapshot: { phases, tasks: proposalTasks, dependencies: deps.rows, taskSequence: counter.rows[0]?.value ?? 0 },
    ids, sources, settings: splitSettingsToDomain(split),
  };
}
