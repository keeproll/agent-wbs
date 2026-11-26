import type { PoolClient } from '@awbs/db';
import {
  belowFloor, completionGate, cyclePath, effortLevel, floorOf, gradeError, isBlocked,
  type Agent, type DependencyType, type ExecPolicy, type GateInput, type ModelSettings, type TaskStatus,
} from '@awbs/shared';
import { AGENTS, catalogOf, completeOrder, ranksOf, type ModelRow } from '../policy/rules.ts';

/**
 * 무결성 점검(GET /api/system/integrity). 저장된 데이터끼리 모순이 없는지 본다.
 * G§0.4: 프로토타입의 「데이터 정합성 점검」은 실제 서비스에서 서버 측 무결성 검사로 옮긴다.
 * 한 행만 보면 되는 규칙(자기 참조·열린 시도 1개·lo≤est≤hi 등)은 DB 제약이 이미 막는다(data-model §4).
 * 여기서는 여러 행을 함께 봐야 하는 규칙(「Service가 보장」 목록)과 실행 정책 규칙을 다시 확인한다.
 * 점검은 읽기만 한다. 고치지 않고 무엇이 어긋났는지만 보인다.
 */

const TERMINAL: readonly TaskStatus[] = ['done', 'cancelled'];
const ACTIVE: readonly TaskStatus[] = ['running', 'qa', 'verifying'];
/** 등급이 있어야 하는 상태: 착수 승인 뒤 실행할 수 있거나 실행 중·결과 대기인 Task. 추정 전(planning·approval)은 아직 없어도 된다. */
const NEEDS_GRADE: readonly TaskStatus[] = ['ready', 'running', 'qa', 'verifying', 'rework', 'paused', 'failed', 'gate'];
const DELIVERIES = ['Draft', 'Queued', 'Sent', 'Acknowledged', 'Failed', 'Cancelled'];

export interface IntegritySnapshot {
  tasks: {
    id: string; key: string; status: TaskStatus; deleted: boolean; nodeKind: 'phase' | 'work_package' | null; assignee: Agent; verifier: Agent;
    primaryDomain: string; relatedDomains: readonly string[]; approved: boolean; verifState: string;
  }[];
  deps: { id: string; pred: string; succ: string; type: DependencyType }[];
  grades: { taskId: string; role: 'dev' | 'qa'; modelId: string; effort: string; locked: boolean }[];
  models: ModelRow[];
  ranks: ReadonlyMap<string, number>;
  floors: ExecPolicy['floors'];
  subagents: { taskId: string; role: 'dev' | 'qa'; defKey: string; defAgent: Agent }[];
  messages: { key: string; taskId: string; attemptTaskId: string | null; dir: string; delivery: string | null }[];
  /** 완료 Task의 Completion Gate 입력(저장된 검증·① 검사·체크리스트·산출물·결함·착수 승인에서 읽은 값) */
  gates: { taskId: string; input: GateInput }[];
}

export interface IntegrityItem { key: string; label: string; ok: boolean; detail: string }

const result = (key: string, label: string, bad: readonly string[], okDetail: string): IntegrityItem =>
  ({ key, label, ok: bad.length === 0, detail: bad.length ? bad.join(', ') : okDetail });

export function integrityItems(s: IntegritySnapshot): IntegrityItem[] {
  const live = s.tasks.filter((t) => !t.deleted);
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const keyOf = (id: string) => byId.get(id)?.key ?? id;
  const liveIds = new Set(live.map((t) => t.id));
  const liveDeps = s.deps.filter((d) => liveIds.has(d.pred) && liveIds.has(d.succ));
  const open = new Set(live.filter((t) => !TERMINAL.includes(t.status)).map((t) => t.id));
  const items: IntegrityItem[] = [];

  items.push(result('task_tree', '모든 Task가 WBS 트리의 Work Package 아래에 있음',
    live.filter((t) => t.nodeKind !== 'work_package').map((t) => t.key), `Task ${String(live.length)}건`));

  items.push(result('dependency_refs', '의존성이 삭제되지 않은 Task만 참조',
    s.deps.filter((d) => !liveIds.has(d.pred) || !liveIds.has(d.succ)).map((d) => `${keyOf(d.pred)} → ${keyOf(d.succ)}`), `의존성 ${String(s.deps.length)}건`));

  items.push(result('dependency_self', '자기 참조 의존성 없음',
    s.deps.filter((d) => d.pred === d.succ).map((d) => `${keyOf(d.pred)} → ${keyOf(d.succ)}`), '없음'));

  let cycle: string[] | null = null;
  for (const dep of liveDeps) {
    if (dep.pred === dep.succ) continue;
    cycle = cyclePath(liveDeps.filter((d) => d !== dep && d.pred !== d.succ), dep);
    if (cycle) break;
  }
  items.push(result('dependency_cycle', '순환 의존성 없음', cycle ? [cycle.map(keyOf).join(' → ')] : [], '없음'));

  const graph = live.map((t) => ({ id: t.id, status: t.status }));
  items.push(result('active_unblocked', '실행·검증 중인 Task에 미충족 선행 없음(D-35)',
    live.filter((t) => ACTIVE.includes(t.status) && isBlocked(graph, liveDeps, t.id)).map((t) => t.key), '없음'));

  // 완료 Task는 저장된 근거로 Gate 5조건(G§5.5)을 다시 판정한다. 근거를 못 읽었으면 통과로 보이지 않는다(리뷰 지적 4).
  const done = live.filter((t) => t.status === 'done');
  items.push(result('done_gate', '완료 Task는 저장된 근거로 Completion Gate 5조건을 충족(G§5.5)',
    done.flatMap((t) => {
      const gate = s.gates.find((g) => g.taskId === t.id);
      if (!gate) return [`${t.key}(근거 없음)`];
      const failed = completionGate(gate.input).filter((c) => c.result !== 'PASS').map((c) => c.reason);
      return failed.length ? [`${t.key}(${failed.join('·')})`] : [];
    }), `완료 ${String(done.length)}건`));

  items.push(result('message_attempt', '메시지에 연결한 실행 시도가 같은 Task의 것',
    s.messages.filter((m) => m.attemptTaskId !== null && m.attemptTaskId !== m.taskId).map((m) => m.key), `메시지 ${String(s.messages.length)}건`));

  items.push(result('message_delivery', '보낸 메시지만 정의된 전달 상태(Draft~Cancelled)를 가짐(G§9.4-1)',
    s.messages.filter((m) => (m.dir === 'out' ? !DELIVERIES.includes(String(m.delivery)) : m.delivery !== null)).map((m) => m.key),
    `보낸 메시지 ${String(s.messages.filter((m) => m.dir === 'out').length)}건`));

  items.push(result('allowed_per_agent', '모델이 보고된 Agent마다 허용 모델이 1개 이상(G§7.2)',
    AGENTS.filter((agent) => s.models.some((m) => m.agent === agent) && !s.models.some((m) => m.agent === agent && m.allowed)), '충족'));

  const catalogs = Object.fromEntries(AGENTS.map((agent) => [agent, catalogOf(agent, s.models, s.ranks)])) as Record<Agent, ReturnType<typeof catalogOf>>;
  const openGrades = s.grades.filter((g) => open.has(g.taskId));
  const agentOf = (taskId: string, role: 'dev' | 'qa') => { const t = byId.get(taskId); return role === 'dev' ? t?.assignee : t?.verifier; };
  items.push(result('grade_allowed', '진행 전·중 Task의 실행 등급이 있고 허용 모델·승인된 Effort 단계 안에 있음',
    [
      ...openGrades.filter((g) => { const agent = agentOf(g.taskId, g.role); return !agent || gradeError(catalogs[agent], g) !== null; })
        .map((g) => `${keyOf(g.taskId)} ${g.role}`),
      // 등급 행이 아예 없는 것도 실행할 수 없는 모순이다(리뷰 지적 3).
      ...live.filter((t) => NEEDS_GRADE.includes(t.status)).flatMap((t) => (['dev', 'qa'] as const)
        .filter((role) => !s.grades.some((g) => g.taskId === t.id && g.role === role)).map((role) => `${t.key} ${role} 없음`)),
    ], `등급 ${String(openGrades.length)}건`));

  items.push(result('grade_floor', 'Planning Agent 판단 등급이 최저선을 지킴(팀장 고정 예외)',
    openGrades.filter((g) => {
      const t = byId.get(g.taskId);
      const agent = agentOf(g.taskId, g.role);
      if (!t || !agent) return false;
      const dev = s.grades.find((x) => x.taskId === g.taskId && x.role === 'dev');
      const devLevel = dev ? effortLevel(t.assignee, dev.modelId, dev.effort) : null;
      const floor = floorOf(g.role, { primaryDomain: t.primaryDomain, relatedDomains: t.relatedDomains, devLevel }, s.floors);
      return belowFloor(agent, g, floor) === true;
    }).map((g) => `${keyOf(g.taskId)} ${g.role}`), '최저선 위반 없음'));

  const designated = s.subagents.filter((x) => open.has(x.taskId));
  items.push(result('subagent_agent', 'Task에 지정한 하위 Agent가 그 역할의 담당 Agent와 일치',
    designated.filter((x) => agentOf(x.taskId, x.role) !== x.defAgent).map((x) => `${keyOf(x.taskId)} ${x.role} ${x.defKey}`), `지정 ${String(designated.length)}건`));

  return items;
}

/** 점검에 필요한 데이터를 한 시점(읽기 전용 반복 읽기 트랜잭션)에서 읽는다. */
export async function loadIntegrity(client: PoolClient): Promise<IntegritySnapshot> {
  const tasks = (await client.query<{ id: string; key: string; status: TaskStatus; deleted: boolean; node_kind: 'phase' | 'work_package' | null; assignee: Agent; verifier: Agent; primary_domain: string; related_domains: string[]; approved: boolean; verif_state: string }>(
    `select t.id,t.task_key as key,t.status,t.deleted_at is not null as deleted,n.kind as node_kind,t.assignee_agent as assignee,t.verifier_agent as verifier,
       t.primary_domain,t.related_domains::text[] as related_domains,t.planning_approved_at is not null as approved,t.verif_state
     from tasks t left join wbs_nodes n on n.id=t.wbs_node_id`)).rows;
  const deps = (await client.query<{ id: string; pred: string; succ: string; type: DependencyType }>('select id,pred,succ,dep_type as type from task_dependencies')).rows;
  const grades = (await client.query<{ task_id: string; role: 'dev' | 'qa'; model_id: string; effort: string; locked: boolean }>('select task as task_id,role,model_id,effort,locked from task_grades')).rows;
  const modelRows = (await client.query<{ agent: Agent; model_id: string; allowed: boolean; is_new: boolean; report: { label?: string; efforts?: string[] | null } | null }>('select agent,model_id,allowed,is_new,report from agent_models')).rows;
  const models: ModelRow[] = modelRows.map((r) => ({ agent: r.agent, modelId: r.model_id, label: r.report?.label ?? r.model_id, allowed: r.allowed, isNew: r.is_new, efforts: Array.isArray(r.report?.efforts) ? r.report.efforts : null }));
  const settings = (await client.query<{ model_settings: ModelSettings }>('select model_settings from app_settings where singleton')).rows[0]?.model_settings;
  const floors = (await client.query<{ floors: ExecPolicy['floors'] }>('select floors from exec_policy where singleton')).rows[0]?.floors ?? { verifyGeDev: true, dbHigh: true };
  const subagents = (await client.query<{ task_id: string; role: 'dev' | 'qa'; def_key: string; def_agent: Agent }>(
    'select s.task as task_id,s.role,d.def_key,d.agent as def_agent from task_subagents s join subagent_defs d on d.id=s.subagent_id')).rows;
  const messages = (await client.query<{ key: string; task_id: string; attempt_task: string | null; dir: string; delivery: string | null }>(
    'select m.msg_key as key,m.task as task_id,a.task as attempt_task,m.dir,m.delivery from messages m left join task_attempts a on a.id=m.attempt')).rows;
  return {
    gates: await loadGates(client),
    tasks: tasks.map((t) => ({ id: t.id, key: t.key, status: t.status, deleted: t.deleted, nodeKind: t.node_kind, assignee: t.assignee, verifier: t.verifier,
      primaryDomain: t.primary_domain, relatedDomains: t.related_domains, approved: t.approved, verifState: t.verif_state })),
    deps,
    grades: grades.map((g) => ({ taskId: g.task_id, role: g.role, modelId: g.model_id, effort: g.effort, locked: g.locked })),
    models,
    ranks: settings ? ranksOf(completeOrder(settings, models)) : new Map(),
    floors,
    subagents: subagents.map((x) => ({ taskId: x.task_id, role: x.role, defKey: x.def_key, defAgent: x.def_agent })),
    messages: messages.map((m) => ({ key: m.key, taskId: m.task_id, attemptTaskId: m.attempt_task, dir: m.dir, delivery: m.delivery })),
  };
}

/**
 * 완료 Task의 Gate 입력을 저장된 근거에서 읽는다(리뷰 지적 4).
 * - 코드 근거(basis): 마지막 시도의 head SHA·입력 버전, 현재 명세 revision(완료 뒤에는 명세를 바꿀 수 없다).
 * - 검증: 그 Task의 가장 최근 QA·재검증 시도의 검증과 무효화 여부(시도가 진행 중이면 진행 중, 결과가 없으면 없음). ① Task 검사: 가장 최근 1단계(task) CI 실행.
 *   ci_runs에는 명세 revision·입력 버전이 없어 그 두 값은 코드 근거와 같다고 본다(head SHA는 대조한다).
 * - 결함: 그 Task 검증의 차단 결함 중 해결 검증(resolved_by_verification)이 기록되지 않은 것.
 * Gate 조회 API(M2-06)가 생기면 같은 근거 조회를 쓰도록 합친다.
 */
async function loadGates(client: PoolClient): Promise<IntegritySnapshot['gates']> {
  const rows = (await client.query<{
    id: string; approved_at: string | null; revision: number | null; head_sha: string | null; input_version: string | null;
    a_status: string | null; v_result: 'PASS' | 'FAIL' | 'BLOCKED' | null; v_head: string | null; v_revision: number | null; v_input: string | null; v_invalidated: boolean | null;
    c_status: string | null; c_head: string | null; defects: number;
  }>(
    `select t.id,t.planning_approved_at::text as approved_at,s.revision,la.head_sha,la.input_version::text as input_version,
       lv.a_status,lv.result as v_result,lv.head_sha as v_head,lv.spec_revision as v_revision,lv.input_version::text as v_input,lv.invalidated as v_invalidated,
       lc.status::text as c_status,lc.head_sha as c_head,
       (select count(*)::int from defects d join verifications dv on dv.id=d.verification join task_attempts da on da.id=dv.attempt
          where da.task=t.id and d.blocking and not exists(select 1 from defect_events e where e.defect=d.id and e.resolved_by_verification is not null)) as defects
     from tasks t
     left join task_specs s on s.task=t.id
     left join lateral (select head_sha,input_version from task_attempts where task=t.id order by attempt_no desc,started_at desc limit 1) la on true
     left join lateral (select a.status::text as a_status,v.result,v.head_sha,v.spec_revision,a.input_version,
                          v.id is not null and exists(select 1 from verification_invalidations i where i.verification=v.id) as invalidated
                        from task_attempts a left join verifications v on v.attempt=a.id
                        where a.task=t.id and a.kind in ('qa','reverify') order by a.attempt_no desc,a.started_at desc limit 1) lv on true
     left join lateral (select status,head_sha from ci_runs where task=t.id and stage=1 order by created_at desc limit 1) lc on true
     where t.status='done' and t.deleted_at is null`)).rows;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const checklist = (await client.query<{ task: string; required: boolean; done: boolean }>('select task,required,done from checklist_items where task=any($1::uuid[])', [ids])).rows;
  const outputs = (await client.query<{ task: string; name: string; required: boolean; delivered: boolean }>('select task,name,required,delivered from task_outputs where task=any($1::uuid[])', [ids])).rows;
  const versions = new Map<string, number>();
  const versionNo = (id: string | null) => { if (id === null) return 0; if (!versions.has(id)) versions.set(id, versions.size + 1); return versions.get(id) ?? 0; };
  return rows.map((r) => {
    const basis = { headSha: r.head_sha ?? '', specRevision: r.revision ?? 0, inputVersion: versionNo(r.input_version) };
    const input: GateInput = {
      checklist: checklist.filter((c) => c.task === r.id).map((c) => ({ required: c.required, done: c.done })),
      outputs: outputs.filter((o) => o.task === r.id).map((o) => ({ name: o.name, required: o.required, delivered: o.delivered })),
      basis,
      // 가장 최근 QA·재검증 시도 기준(재리뷰 R1). 진행 중이면 「검증 진행 중」, 결과가 없으면 예전 PASS를 쓰지 않고 「검증 미실시」.
      verificationState: r.a_status === 'running' ? 'running' : r.a_status === null ? 'none' : 'completed',
      verification: r.v_result === null ? null : {
        result: r.v_result, headSha: r.v_head ?? '', specRevision: r.v_revision ?? -1, inputVersion: versionNo(r.v_input), invalidated: r.v_invalidated ?? false,
      },
      taskCheck: r.c_status === 'pass' || r.c_status === 'fail'
        ? { result: r.c_status === 'pass' ? 'PASS' : 'FAIL', headSha: r.c_head ?? '', specRevision: basis.specRevision, inputVersion: basis.inputVersion }
        : null,
      unresolvedBlockingDefects: r.defects,
      planningApprovedAt: r.approved_at,
      headSync: null,
    };
    return { taskId: r.id, input };
  });
}

export async function checkIntegrity(client: PoolClient) {
  const checkedAt = (await client.query<{ at: string }>(`select to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`)).rows[0]?.at ?? new Date().toISOString();
  return { checkedAt, items: integrityItems(await loadIntegrity(client)) };
}
