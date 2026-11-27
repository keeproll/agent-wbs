import type { PoolClient } from '@awbs/db';
import type { DesignKind, WorkType } from '@awbs/shared';
import { canonicalJson, judgedContent, subjectHash, type Ac, type JudgedSource } from '../tasks/hash.ts';

/**
 * 판단 대상 내용(JudgedContent, data-model §2.3-1)과 그 hash(subjectHash).
 * estimate job payload의 `tasks[{taskKey,subjectHash,content}]`를 채우는 데 쓴다(contracts §3.2, M2-08 리뷰 지적 1).
 * M2 통합: 규칙은 M2-02 `tasks/hash.ts` 하나만 쓴다. Planning이 같은 hash를 돌려보내야 하므로 사본을 두지 않는다.
 */
const lines = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** 키를 정렬한 JSON(undefined 값은 뺌). `tasks/hash.ts`의 canonicalJson과 같은 함수다. */
export const hashJson = canonicalJson;

export interface JudgedTask { taskKey: string; workType: WorkType; subjectHash: string; content: Record<string, unknown>; gradeChange: string | null }

/** Task들의 현재 판단 대상 내용과 hash를 한 트랜잭션 시점에서 읽는다. 명세가 아직 없으면 빈 값으로 본다. */
export async function judgedTasks(client: PoolClient, taskIds: readonly string[]): Promise<JudgedTask[]> {
  const tasks = (await client.query<{ id: string; task_key: string; work_type: WorkType; title: string; conflict_group: string | null; overview: Record<string, unknown> | null; spec: Record<string, unknown> | null; ac: unknown[] | null; grade_change: string | null }>(
    `select t.id,t.task_key,t.work_type,t.title,t.conflict_group,s.overview,s.spec,s.ac,
      (select h.ref->>'gradeChange' from task_history h where h.task=t.id and h.ref ? 'gradeChange' order by h.record_no desc limit 1) grade_change
     from tasks t left join task_specs s on s.task=t.id
     where t.id=any($1::uuid[]) order by t.task_key`, [taskIds])).rows;
  const outputs = (await client.query<{ task: string; name: string; kind: string; required: boolean; verify: string }>(
    'select task,name,kind,required,verify from task_outputs where task=any($1::uuid[])', [taskIds])).rows;
  const designs = (await client.query<{ task: string; kind: DesignKind; content: Record<string, unknown> }>(
    'select task,kind,content from task_designs where task=any($1::uuid[])', [taskIds])).rows;
  return tasks.map((t) => {
    const overview = t.overview ?? {};
    const source: JudgedSource = {
      title: t.title,
      // 판단 대상이 아닌 칸(목적·배경·선행 조건)은 judgedContent가 쓰지 않는다.
      overview: { purpose: '', background: '', precond: '', scope: lines(overview.scope), out: lines(overview.out), doneCond: text(overview.doneCond) },
      spec: t.spec ?? {},
      ac: (t.ac ?? []).map((item): Ac => { const a = (item ?? {}) as Record<string, unknown>; return { given: text(a.given), when: text(a.when), then: text(a.then), method: text(a.method) }; }),
      outputs: outputs.filter((o) => o.task === t.id).map(({ name, kind, required, verify }) => ({ name, kind, required, verify, delivered: false })),
      designs: designs.filter((d) => d.task === t.id).map(({ kind, content }) => ({ kind, content })),
      conflictGroup: t.conflict_group,
    };
    return { taskKey: t.task_key, workType: t.work_type, subjectHash: subjectHash(source), content: judgedContent(source), gradeChange: t.grade_change };
  });
}
