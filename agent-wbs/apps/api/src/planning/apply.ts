import assert from 'node:assert/strict';
import type { PoolClient } from '@awbs/db';
import type { TaskJudgement, TaskStatus } from '@awbs/shared';
import type { WireProposalOp } from '@awbs/shared/api';
import { specBody, subjectHash } from '../tasks/hash.ts';
import { taskDetail } from '../tasks/read.ts';
import { invalidateGate } from '../tasks/routes.ts';
import { changeEvent, nextChecklistKey, record, SYSTEM } from '../tasks/write.ts';
import { designsOf, newTaskSource } from './content.ts';
import type { Evaluation } from './evaluate.ts';

/** 반영 직전에 다시 계산한 판단 대상 hash가 실제로 쓴 내용의 hash와 다르다(data-model §2.3-1 반영 트랜잭션 재대조). */
export class JudgementDrift extends Error {
  readonly taskKeys: string[];
  constructor(taskKeys: string[]) {
    super('반영한 내용의 판단 대상 hash가 판단한 hash와 다릅니다.');
    this.taskKeys = taskKeys;
  }
}

export interface ApplyTarget {
  id: string; cp_key: string; project_id: string; source: string; source_id: string | null;
  ops: readonly WireProposalOp[]; task_judgements: readonly TaskJudgement[];
}

const LABEL: Record<string, string> = { title: '제목', priority: '우선순위', assignee: '담당 Agent', verifier: '검증 Agent', doneCond: '완료 조건', scopeAdd: '범위', acAdd: 'Acceptance Criteria' };
const COLUMN: Record<string, string> = { title: 'title', priority: 'priority', assignee: 'assignee_agent', verifier: 'verifier_agent' };
const depKey = (pred: string, succ: string) => `${pred}>${succ}`;

/**
 * 평가 결과(`ev.simulation.next`)를 그대로 DB에 쓴다. 미리보기가 보여 준 것과 같은 상태를 저장하므로 미리보기 영향 = 반영 결과다.
 * 호출한 트랜잭션 안에서 Task 생성·수정·취소·관계 추가/제거·이력·판단 기록 이전을 함께 처리한다(D-27: 취소와 SS 제거가 한 트랜잭션).
 * 재조정은 호출한 쪽이 같은 트랜잭션에서 이어서 기록한다.
 */
export async function applyEvaluation(client: PoolClient, cp: ApplyTarget, ev: Evaluation, actor: string): Promise<void> {
  const projectId = cp.project_id;
  const base = ev.loaded.snapshot;
  const next = new Map(ev.simulation.next.tasks.map((task) => [task.id, task]));
  const statusOf = new Map(base.tasks.map((task) => [task.id, task.status]));
  const ids = new Map(ev.loaded.ids);
  const touched = new Set<string>();
  const at = `${cp.cp_key} 반영`;
  const history = async (key: string, input: Omit<Parameters<typeof record>[1], 'projectId' | 'taskId'>) => {
    const taskId = ids.get(key);
    assert(taskId, `반영 대상 Task가 없습니다: ${key}`);
    await record(client, { projectId, taskId, actor, ...input, ref: { proposal: cp.cp_key, ...input.ref } });
  };

  // 1. 새 Task: 시뮬레이션이 정한 예상 키(idMap)와 상속을 적용한 충돌 묶음으로 만든다.
  for (const op of cp.ops) {
    if (op.op !== 'add') continue;
    const key = ev.refs.get(op.ref);
    const task = key ? next.get(key) : undefined;
    assert(key && task, `새 Task의 예상 키가 없습니다: ${op.ref}`);
    const { t } = op;
    await client.query(`insert into counters(project_id,kind,value) values($1,'task',$2)
      on conflict (project_id,kind) do update set value=greatest(counters.value,excluded.value)`, [projectId, Number(key.slice(5))]);
    const srcV = t.srcV === undefined ? null
      : (await client.query<{ id: string }>('select id from input_versions where project_id=$1 and v=$2', [projectId, t.srcV])).rows[0]?.id ?? null;
    const id = (await client.query<{ id: string }>(
      `insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,conflict_group,src_input_version)
       values($1,$2,$3,(select coalesce(max(sort_order)+1,0) from tasks where wbs_node_id=$3),$4,$5,$6,$7::domain[],$8,$9,$10,'planning','none',$11,$12) returning id`,
      [projectId, key, t.wp, t.title, t.type, t.domain, t.rel ?? [], t.priority, t.assignee, t.verifier, task.conflictGroup, srcV])).rows[0]?.id;
    assert(id);
    ids.set(key, id);
    const source = newTaskSource(t, task.conflictGroup);
    await client.query('insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,1)',
      [projectId, id, JSON.stringify(source.overview), JSON.stringify(specBody(source.spec)), JSON.stringify(source.ac)]);
    // 체크리스트는 AC마다 하나(P newTask). 번호는 Task별 counters로 재사용하지 않는다.
    for (const [index, ac] of source.ac.entries()) {
      await client.query('insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) values($1,$2,$3,$4,true,false,$5,$6)',
        [projectId, id, await nextChecklistKey(client, { id, project_id: projectId, task_key: key }), ac.then, ac.method || '자동 테스트', index]);
    }
    for (const design of designsOf(t)) {
      await client.query('insert into task_designs(project_id,task,kind,content) values($1,$2,$3,$4::jsonb)', [projectId, id, design.kind, JSON.stringify(design.content)]);
    }
    if (t.est !== undefined) {
      await client.query('insert into task_estimates(project_id,task,est,lo,hi,tokens_k,confidence,basis,agreed_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [projectId, id, t.est, t.lo ?? t.est, t.hi ?? t.est, t.tok ?? null, t.conf ?? '하', t.basis ?? '', actor]);
    }
    // 분할 근거와 판단 기록. 일반 CP에서 생략한 근거는 빈 문자열 = 미기록이다(data-model §2.3 task_splits).
    const judged = (t as { judgedRules?: unknown }).judgedRules ?? { schemaVersion: 1, items: [] };
    await client.query("insert into task_splits(project_id,task,basis,judged_rules,exceptions) values($1,$2,$3,$4::jsonb,'[]'::jsonb)",
      [projectId, id, t.splitBasis ?? '', JSON.stringify(judged)]);
    if (cp.source === 'split' && cp.source_id && ids.has(cp.source_id)) {
      await client.query('insert into task_source_links(project_id,fix_task,split_from) values($1,$2,$3)', [projectId, id, ids.get(cp.source_id)]);
    }
    await history(key, { kind: '생성', text: `${at}으로 생성 — ${t.type} / ${t.domain}`, after: 'planning' });
    touched.add(key);
  }

  // 2. 필드 수정. 명세가 바뀌면 revision을 올리고 Gate 대기의 검증 근거를 무효로 한다(Q-05 14행).
  const modified = new Map<string, { field: string; before: unknown; after: unknown }[]>();
  for (const change of ev.simulation.diff) {
    if (change.op === 'modify') modified.set(change.target, [...(modified.get(change.target) ?? []), change]);
  }
  for (const [key, changes] of modified) {
    const task = next.get(key);
    const taskId = ids.get(key);
    assert(task && taskId);
    let specChanged = false;
    for (const change of changes) {
      const column = COLUMN[change.field];
      if (column) {
        await client.query(`update tasks set ${column}=$2 where id=$1`, [taskId, change.after]);
      } else specChanged = true;
      await history(key, { kind: '수정', text: `${at} — ${LABEL[change.field] ?? change.field} 변경`, before: change.before, after: change.after, ref: { field: change.field } });
    }
    if (specChanged) {
      const revision = (await client.query<{ revision: number }>(
        `update task_specs set overview=overview || jsonb_build_object('doneCond',$2::text,'scope',$3::jsonb),ac=$4::jsonb,revision=revision+1 where task=$1 returning revision`,
        [taskId, task.doneCond, JSON.stringify(task.scope), JSON.stringify(task.ac.map(({ given, when, then, method }) => ({ given, when, then, method })))])).rows[0]?.revision ?? 1;
      await invalidateGate(client, { id: taskId, project_id: projectId, task_key: key, status: statusOf.get(key) as TaskStatus, updated_at: '', deleted_at: null }, revision);
    }
    touched.add(key);
  }

  // 3. 취소(시작 전 Task만, simulateProposal이 판정). 명세·이력은 보존한다.
  for (const change of ev.simulation.diff) {
    if (change.op !== 'remove') continue;
    await client.query("update tasks set status='cancelled' where id=$1", [ids.get(change.target)]);
    await history(change.target, { kind: '취소', text: `${at}으로 취소`, before: change.before, after: 'cancelled', ref: { field: 'lifecycleStatus' } });
    touched.add(change.target);
  }

  // 4. 관계: 변경 전·후 집합의 차이를 그대로 쓴다. 취소로 제거된 SS·FS 관계도 여기서 같은 트랜잭션에 지운다(D-27).
  const after = new Map(ev.simulation.next.dependencies.map((dep) => [depKey(dep.pred, dep.succ), dep]));
  const beforeDeps = new Map(base.dependencies.map((dep) => [depKey(dep.pred, dep.succ), dep]));
  const reasons = new Map(ev.impact.removedDependencies.map((dep) => [depKey(dep.pred, dep.succ), dep.reason]));
  for (const [key, dep] of beforeDeps) {
    if (after.get(key)?.type === dep.type) continue;
    const removed = (await client.query<{ id: string }>('delete from task_dependencies where pred=$1 and succ=$2 returning id', [ids.get(dep.pred), ids.get(dep.succ)])).rows[0];
    const why = reasons.get(key) === 'pred-cancelled' ? ` (${dep.pred} 취소)` : reasons.get(key) === 'succ-cancelled' ? ` (${dep.succ} 취소)` : '';
    await history(dep.succ, { kind: '선행 관계', text: `${at} — 선행 Task ${dep.pred} 제거${why}`, before: `${dep.pred} (${dep.type})`, ref: { field: 'predecessors', dependencyId: removed?.id ?? null } });
    await changeEvent(client, projectId, 'dependency', { id: removed?.id ?? null, pred: dep.pred, succ: dep.succ });
    touched.add(dep.succ);
  }
  for (const [key, dep] of after) {
    if (beforeDeps.get(key)?.type === dep.type) continue;
    const id = (await client.query<{ id: string }>('insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$3,$4) returning id',
      [projectId, ids.get(dep.pred), ids.get(dep.succ), dep.type])).rows[0]?.id;
    await history(dep.succ, { kind: '선행 관계', text: `${at} — 선행 Task ${dep.pred} 추가 (${dep.type === 'FS' ? '완료 후 시작' : '시작 후 시작'})`, after: `${dep.pred} (${dep.type})`, ref: { field: 'predecessors', dependencyId: id ?? null } });
    await changeEvent(client, projectId, 'dependency', { id: id ?? null, pred: dep.pred, succ: dep.succ });
    touched.add(dep.succ);
  }

  // 5. 차단 변화. 변경 전부터 있던 Task만 본다(새 Task는 처음부터 그 상태).
  for (const { taskKey, notes } of ev.simulation.impact.tasks) {
    if (!statusOf.has(taskKey)) continue;
    if (notes.some((note) => note.kind === 'unblocked')) {
      await history(taskKey, { actor: SYSTEM, kind: '차단', text: `${at}으로 차단 해제`, before: '차단', after: '실행 가능', ref: { field: 'blocked' } });
    } else if (notes.some((note) => note.kind === 'newly-blocked')) {
      await history(taskKey, { actor: SYSTEM, kind: '차단', text: `${at}으로 실행 차단`, before: '실행 가능', after: '차단', ref: { field: 'blocked' } });
    }
  }

  // 6. 판단 기록 이전: CP의 기존 Task 판단 → 그 Task의 task_splits.judged_rules(반영 전에는 바꾸지 않았다, data-model §2.3-1 저장 위치).
  for (const entry of cp.task_judgements) {
    const taskId = ids.get(entry.taskKey);
    if (!taskId || !entry.judgedRules) continue;
    const previous = (await client.query<{ judged_rules: unknown }>('select judged_rules from task_splits where task=$1 for update', [taskId])).rows[0]?.judged_rules ?? null;
    await client.query(`insert into task_splits(project_id,task,basis,judged_rules,exceptions) values($1,$2,'',$3::jsonb,'[]'::jsonb)
      on conflict (task) do update set judged_rules=excluded.judged_rules`, [projectId, taskId, JSON.stringify(entry.judgedRules)]);
    await history(entry.taskKey, { kind: '분할 판단', text: `${at} — 규칙 5·7·9 판단 기록 교체`, before: previous, after: entry.judgedRules, ref: { field: 'judgedRules' } });
    touched.add(entry.taskKey);
  }

  // 7. 버전은 이력보다 늦게 올린다(충돌 창의 「그 뒤 변경」 순서, M2-02 record 참고).
  for (const key of touched) {
    await client.query('update tasks set updated_at=clock_timestamp() where id=$1', [ids.get(key)]);
    await changeEvent(client, projectId, 'task', { taskKey: key });
  }

  // 8. 실제로 쓴 내용으로 판단 대상 hash를 다시 계산해 판단한 hash와 대조한다. 다르면 「기록 없음」이므로 보류한다.
  const drift: string[] = [];
  for (const target of ev.targets) {
    const key = ev.refs.get(target.target) ?? target.target;
    const detail = await taskDetail(client, key);
    if (!detail) { drift.push(key); continue; }
    const stored = subjectHash({ title: detail.title, overview: detail.spec.overview, spec: detail.spec.spec, ac: detail.spec.ac, outputs: detail.outputs, designs: detail.designs, conflictGroup: detail.conflictGroup });
    if (stored !== ev.afterHash.get(key)) drift.push(key);
  }
  if (drift.length) throw new JudgementDrift(drift);
}
