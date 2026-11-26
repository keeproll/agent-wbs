import { createHash } from 'node:crypto';
import type { PoolClient } from '@awbs/db';
import { DESIGN_KINDS, type DesignKind } from '@awbs/shared';

/**
 * 판단 대상 내용(JudgedContent, data-model §2.3-1)과 그 hash(subjectHash).
 * estimate job payload의 `tasks[{taskKey,subjectHash,content}]`를 채우는 데 쓴다(contracts §3.2, M2-08 리뷰 지적 1).
 * 규칙은 M2-02 `apps/api/src/tasks/hash.ts`와 같다 — Planning이 같은 hash를 돌려보내야 하므로 통합 때 하나로 합친다.
 */
const SPEC_KEYS = ['req', 'work', 'steps', 'inputs', 'outputs', 'files', 'constraints', 'errors', 'docs', 'verify'] as const;
const lines = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** 키를 정렬한 JSON(undefined 값은 뺌). 배열 순서는 의미가 있으므로 그대로 둔다. */
export function hashJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(hashJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${hashJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface JudgedTask { taskKey: string; subjectHash: string; content: Record<string, unknown> }

/** Task들의 현재 판단 대상 내용과 hash를 한 트랜잭션 시점에서 읽는다. 명세가 아직 없으면 빈 값으로 본다. */
export async function judgedTasks(client: PoolClient, taskIds: readonly string[]): Promise<JudgedTask[]> {
  const tasks = (await client.query<{ id: string; task_key: string; title: string; conflict_group: string | null; overview: Record<string, unknown> | null; spec: Record<string, unknown> | null; ac: unknown[] | null }>(
    `select t.id,t.task_key,t.title,t.conflict_group,s.overview,s.spec,s.ac from tasks t left join task_specs s on s.task=t.id
     where t.id=any($1::uuid[]) order by t.task_key`, [taskIds])).rows;
  const outputs = (await client.query<{ task: string; name: string; kind: string; required: boolean; verify: string }>(
    'select task,name,kind,required,verify from task_outputs where task=any($1::uuid[])', [taskIds])).rows;
  const designs = (await client.query<{ task: string; kind: DesignKind; content: Record<string, unknown> }>(
    'select task,kind,content from task_designs where task=any($1::uuid[])', [taskIds])).rows;
  return tasks.map((t) => {
    const overview = t.overview ?? {};
    const spec = t.spec ?? {};
    const content = {
      title: t.title,
      scope: lines(overview.scope),
      out: lines(overview.out),
      doneCond: text(overview.doneCond),
      spec: Object.fromEntries(SPEC_KEYS.map((key) => [key, lines(spec[key])])),
      ac: (t.ac ?? []).map((item) => { const a = (item ?? {}) as Record<string, unknown>; return { given: text(a.given), when: text(a.when), then: text(a.then), method: text(a.method) }; }),
      outputs: outputs.filter((o) => o.task === t.id).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, kind, required, verify }) => ({ name, kind, required, verify })),
      designs: designs.filter((d) => d.task === t.id).sort((a, b) => DESIGN_KINDS.indexOf(a.kind) - DESIGN_KINDS.indexOf(b.kind))
        .map(({ kind, content: c }) => ({ kind, content: c })),
      conflictGroup: t.conflict_group,
    };
    return { taskKey: t.task_key, subjectHash: createHash('sha256').update(hashJson(content)).digest('hex'), content };
  });
}
