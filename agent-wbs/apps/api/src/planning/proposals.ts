import assert from 'node:assert/strict';
import type { PoolClient } from '@awbs/db';
import { displayKey, type SplitJudgements, type TaskJudgement } from '@awbs/shared';
import type { WireHoldReason, WireProposalOp } from '@awbs/shared/api';
import type { FastifyRequest } from 'fastify';
import { TaskError } from '../tasks/errors.ts';
import { iso } from '../tasks/read.ts';
import type { ProposalInput } from './evaluate.ts';
import { deferChange } from '../changes/events.ts';

/** 변경 제안(CP) 행을 읽고 쓰는 공용 함수. 팀장·Planning 경로가 함께 쓴다. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CpRow {
  id: string; project_id: string; cp_key: string; title: string; reason: string; source: string; source_id: string | null; status: string;
  ops: WireProposalOp[]; id_map: Record<string, string> | null; split_judgements: SplitJudgements | null; task_judgements: TaskJudgement[];
  hold_reasons: { holdReasons: WireHoldReason[]; issues: unknown[] } | null; created_at: string; updated_at: string;
}
export const CP_COLUMNS = `id,project_id,cp_key,title,reason,source,source_id,status::text as status,ops,id_map,split_judgements,task_judgements,hold_reasons,
  ${iso('created_at')} as created_at,${iso('updated_at')} as updated_at`;

export const clientOf = (request: FastifyRequest): PoolClient => {
  const client = request.platform?.client;
  assert(client, '변경 요청은 공통 관문이 연 트랜잭션 안에서 처리한다.');
  return client;
};
export const idOf = (request: FastifyRequest) => (request.params as { id?: string }).id ?? '';
export const inputOf = (row: CpRow): ProposalInput => ({
  projectId: row.project_id, source: row.source, sourceId: row.source_id, ops: row.ops, taskJudgements: row.task_judgements, splitJudgements: row.split_judgements,
});

export async function loadCp(client: PoolClient, id: string, lock: boolean): Promise<CpRow> {
  const row = UUID.test(id) || /^CP-[0-9]+$/.test(id) ? (await client.query<CpRow>(`select ${CP_COLUMNS} from change_proposals where ${UUID.test(id) ? 'id' : 'cp_key'}=$1 and deleted_at is null${lock ? ' for update' : ''}`, [id])).rows[0] : undefined;
  if (!row) throw new TaskError('NOT_FOUND', { resource: 'change_proposal', id });
  return row;
}

export async function proposalView(client: PoolClient, row: CpRow) {
  const events = (await client.query<{ at: string; actor: string; action: string; comment: string }>(
    `select ${iso('created_at')} as at,actor,kind as action,comment from change_proposal_events where proposal=$1 order by record_no`, [row.id])).rows;
  return {
    id: row.id, cpKey: row.cp_key, title: row.title, reason: row.reason, source: { kind: row.source, id: row.source_id }, status: row.status,
    ops: row.ops, idMap: row.id_map ?? {}, splitJudgements: row.split_judgements, taskJudgements: row.task_judgements,
    holdReasons: row.hold_reasons?.holdReasons ?? [], issues: row.hold_reasons?.issues ?? [], events, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** 같은 CP 행의 이벤트 순서가 한 트랜잭션 안에서도 유지되게 실제 시각으로 기록한다. */
export async function event(client: PoolClient, row: Pick<CpRow, 'id' | 'project_id'>, kind: string, actor: string, comment = '') {
  await client.query('insert into change_proposal_events(project_id,proposal,kind,actor,comment,created_at) values($1,$2,$3,$4,$5,clock_timestamp())',
    [row.project_id, row.id, kind, actor, comment]);
  deferChange(client, row.project_id, 'proposal', { id: row.id });
}

/** P5954: 반려·삭제되지 않은 CP가 있으면 세션 조정과 새 작성을 함께 막는다. 같은 잠금으로 두 요청의 경합도 막는다. */
export async function assertPlanningUnlocked(client: PoolClient, projectId: string, planningId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`awbs:planning-proposal:${planningId}`]);
  const existing = (await client.query<{ id: string }>(`select id from change_proposals where project_id=$1 and source='planning' and source_id=$2
    and status<>'rejected' and deleted_at is null order by record_no desc limit 1`, [projectId, planningId])).rows[0];
  if (existing) throw new TaskError('INVALID_TRANSITION', { proposalId: existing.id }, [], '이 Planning 세션에는 반려되지 않은 CP가 있어 조정하거나 새로 작성할 수 없습니다.');
}

/** CP 행을 만든다. 표시 ID(CP-001)는 프로젝트 counters로 재사용하지 않는다. */
export async function insertCp(
  client: PoolClient, projectId: string, body: { title: string; reason: string; source: { kind: string; id?: string }; ops: WireProposalOp[] }, actor: string, status: string,
  judgements: { taskJudgements: TaskJudgement[]; splitJudgements: unknown } = { taskJudgements: [], splitJudgements: null },
): Promise<CpRow> {
  if (body.source.kind === 'planning' && body.source.id) {
    await assertPlanningUnlocked(client, projectId, body.source.id);
  }
  const sequence = (await client.query<{ value: number }>(
    `insert into counters(project_id,kind,value) values($1,'cp',(select coalesce(max((substring(cp_key from 4))::bigint),0)+1 from change_proposals where project_id=$1 and cp_key ~ '^CP-[0-9]+$'))
     on conflict (project_id,kind) do update set value=counters.value+1 returning value::int as value`, [projectId])).rows[0]?.value ?? 1;
  const id = (await client.query<{ id: string }>(
    'insert into change_proposals(project_id,cp_key,title,reason,source,source_id,status,ops,task_judgements,split_judgements) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb) returning id',
    [projectId, displayKey('CP', sequence), body.title, body.reason, body.source.kind, body.source.id ?? null, status, JSON.stringify(body.ops),
      JSON.stringify(judgements.taskJudgements), judgements.splitJudgements === null ? null : JSON.stringify(judgements.splitJudgements)])).rows[0]?.id;
  assert(id);
  await event(client, { id, project_id: projectId }, 'created', actor);
  return loadCp(client, id, false);
}
