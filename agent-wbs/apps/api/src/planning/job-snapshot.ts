import { createHash } from 'node:crypto';
import type { Db } from '../project/db.ts';
import { canonicalJson, judgedContent, subjectHash } from '../tasks/hash.ts';
import { loadSnapshot } from './snapshot.ts';
import type { WireProposalOp } from '@awbs/shared/api';

/** 기술 결정의 ID·상태·버전을 함께 고정한다. 반려도 초안의 전제이므로 뺄 수 없다. */
export async function techSnapshot(db: Db, projectId: string) {
  const techDecisions = (await db.query<{
    id: string; tdKey: string; title: string; status: 'fixed' | 'pending' | 'approved' | 'rejected' | 'noted' | 'change'; authority: 'lead' | 'agent' | 'free'; updatedAt: string; content: Record<string, unknown>;
  }>(`select id,td_key as "tdKey",title,status,authority,
      to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",content
      from tech_decisions where project_id=$1 order by td_key for share`, [projectId])).rows;
  return { techDecisions, techDecisionVersion: snapshotHash(techDecisions) };
}

export const snapshotHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** 판단 내용 계산과 작업 묶음·의존 관계 읽기는 CP 미리보기와 같은 함수를 쓴다. */
export async function wbsSnapshot(db: Db, projectId: string) {
  // Task를 바꾸는 요청은 먼저 Task 행을 잠근다. 여러 표를 읽는 동안 내용·상태가 섞이지 않게 같은 행을 잡는다.
  await db.query('select id from tasks where project_id=$1 and deleted_at is null order by id for share', [projectId]);
  const { snapshot, sources } = await loadSnapshot(db, projectId);
  const tasks = snapshot.tasks.map((task) => {
    const source = sources.get(task.id);
    if (!source) throw new Error(`Task 판단 내용 없음: ${task.id}`);
    const wp = snapshot.phases.flatMap((phase) => phase.wps).find((item) => item.tasks.includes(task.id))?.id;
    if (!wp) throw new Error(`Task 작업 묶음 없음: ${task.id}`);
    return { taskKey: task.id, workType: task.workType, wp, status: task.status, subjectHash: subjectHash(source), content: judgedContent(source) };
  });
  return { phases: snapshot.phases, tasks, dependencies: snapshot.dependencies };
}

type Wbs = Awaited<ReturnType<typeof wbsSnapshot>>;

/** 제안 대상과 한 번에 연결된 이웃만 비교한다. 무관한 실행 진행은 분석을 무효로 만들지 않는다. */
export function proposalBasis(wbs: Wbs | undefined, ops: readonly WireProposalOp[], splitTask?: string) {
  if (!wbs) return null;
  const targets = new Set(splitTask ? [splitTask] : []);
  const wps = new Set<string>();
  for (const op of ops) {
    if (op.op === 'add') {
      wps.add(op.t.wp);
      for (const pred of op.preds) targets.add(pred.pred);
    } else if ('task' in op) targets.add(op.task);
    else { targets.add(op.pred); targets.add(op.succ); }
  }
  const dependencies = wbs.dependencies.filter((dep) => targets.has(dep.pred) || targets.has(dep.succ));
  const neighbors = new Set([...targets, ...dependencies.flatMap((dep) => [dep.pred, dep.succ])]);
  const tasks = wbs.tasks.filter((task) => neighbors.has(task.taskKey)).map(({ taskKey, workType, wp, status, subjectHash }) => {
    wps.add(wp);
    return { taskKey, workType, wp, status, subjectHash };
  });
  const packages = wbs.phases.flatMap((phase) => phase.wps.filter((wp) => wps.has(wp.id)).map((wp) => ({ id: wp.id, phase: phase.id })));
  return { tasks, dependencies, wps: packages };
}

/** 같은 job이 반영한 차이만 기준에 더한다. 무관한 외부 변경까지 새 기준으로 삼으면 낡은 제안이 통과한다. */
export function advanceWbs(before: Wbs, after: Wbs, basis: Wbs): Wbs {
  const old = new Map(before.tasks.map((task) => [task.taskKey, task]));
  const next = new Map(after.tasks.map((task) => [task.taskKey, task]));
  const changed = new Set([...old.keys(), ...next.keys()].filter((key) => snapshotHash(old.get(key)) !== snapshotHash(next.get(key))));
  const tasks = [...basis.tasks.filter((task) => !changed.has(task.taskKey)), ...after.tasks.filter((task) => changed.has(task.taskKey))]
    .sort((a, b) => a.taskKey.localeCompare(b.taskKey));
  const key = (dep: Wbs['dependencies'][number]) => `${dep.pred}:${dep.succ}:${dep.type}`;
  const previousEdges = new Set(before.dependencies.map(key));
  const nextEdges = new Set(after.dependencies.map(key));
  const dependencies = [...basis.dependencies.filter((dep) => !previousEdges.has(key(dep)) || nextEdges.has(key(dep))),
    ...after.dependencies.filter((dep) => !previousEdges.has(key(dep)))]
    .sort((a, b) => a.pred.localeCompare(b.pred) || a.succ.localeCompare(b.succ));
  return { tasks, dependencies, phases: basis.phases.map((phase) => ({ ...phase,
    wps: phase.wps.map((wp) => ({ ...wp, tasks: tasks.filter((task) => task.wp === wp.id).map((task) => task.taskKey) })),
  })) };
}
