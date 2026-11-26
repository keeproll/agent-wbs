import type { Pool, PoolClient } from '@awbs/db';
import { isTimestamp, type WireProposalOp } from '@awbs/shared/api';
import type { FastifyRequest } from 'fastify';
import { TaskError } from '../tasks/errors.ts';
import { iso } from '../tasks/read.ts';
import { LEAD, TIMESTAMP_MESSAGE } from '../tasks/write.ts';
import { assertJob } from './jobs.ts';
import { clientOf, idOf, insertCp, proposalView } from './proposals.ts';
import type { RouteFn } from './split.ts';

/*
 * Planning 세션(G§4.5): 두 Agent의 독립 분석 → 교차 검토(일치·이견·조정) → 팀장의 이견 선택 → 선택한 변경으로 CP 작성.
 * 검토의 Agent별 변경(codexOps·claudeOps)과 공통 변경(ops)은 planning_reviews의 codex·claude jsonb에 함께 둔다
 * (`{text, ops}`, 공통 변경은 codex 쪽 `common`). 새 열을 만들지 않으려는 선택이며 보고서에 적었다.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'] };
const REVIEW = { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, rid: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id', 'rid'] };

interface Side { text: string; ops: WireProposalOp[]; common?: WireProposalOp[] }
interface PlanningRow { id: string; planning_key: string; project_id: string; title: string; scope: unknown; created_at: string; updated_at: string }
interface ReviewRow { id: string; topic: string; kind: string; codex: Side; claude: Side; choice: string | null; memo: string | null; updated_at: string }

async function loadPlanning(client: PoolClient | Pool, id: string, lock = false): Promise<PlanningRow> {
  const row = UUID.test(id) ? (await client.query<PlanningRow>(
    `select id,planning_key,project_id,title,scope,${iso('created_at')} as created_at,${iso('updated_at')} as updated_at from plannings where id=$1${lock ? ' for update' : ''}`, [id])).rows[0] : undefined;
  if (!row) throw new TaskError('NOT_FOUND', { resource: 'planning', id });
  return row;
}

async function reviewsOf(client: PoolClient | Pool, planningId: string): Promise<ReviewRow[]> {
  return (await client.query<ReviewRow>(
    `select id,topic,kind,codex,claude,choice,memo,${iso('updated_at')} as updated_at from planning_reviews where planning=$1 order by created_at,id`, [planningId])).rows;
}

async function planningView(client: PoolClient | Pool, row: PlanningRow) {
  const [analyses, reviews, proposal] = await Promise.all([
    client.query<{ agent: string; analysis: { summary?: string; items?: string[] }; at: string }>(
      `select agent,analysis,${iso('updated_at')} as at from planning_analyses where planning=$1 order by agent`, [row.id]),
    reviewsOf(client, row.id),
    client.query<{ id: string }>("select id from change_proposals where source='planning' and source_id=$1 and deleted_at is null order by created_at desc limit 1", [row.id]),
  ]);
  return {
    id: row.id, planningKey: row.planning_key, title: row.title, scope: typeof row.scope === 'string' ? row.scope : JSON.stringify(row.scope),
    analyses: analyses.rows.map((item) => ({ agent: item.agent, summary: item.analysis.summary ?? '', items: item.analysis.items ?? [], at: item.at })),
    reviews: reviews.map((review) => ({
      id: review.id, topic: review.topic, kind: reviewKind(review.kind), codex: review.codex.text, claude: review.claude.text, choice: review.choice, memo: review.memo ?? '',
      ops: review.codex.common ?? [], codexOps: review.codex.ops, claudeOps: review.claude.ops, updatedAt: review.updated_at,
    })),
    proposalId: proposal.rows[0]?.id ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function insertPlanning(client: PoolClient, title: string, scope: string): Promise<PlanningRow> {
  const projectId = (await client.query<{ id: string }>('select id from projects')).rows[0]?.id;
  if (!projectId) throw new TaskError('PROJECT_NOT_FOUND', {});
  const sequence = (await client.query<{ value: number }>(
    `insert into counters(project_id,kind,value) values($1,'planning',1) on conflict (project_id,kind) do update set value=counters.value+1 returning value::int as value`, [projectId])).rows[0]?.value ?? 1;
  const id = (await client.query<{ id: string }>("insert into plannings(project_id,planning_key,title,scope,status) values($1,$2,$3,$4::jsonb,'analyzing') returning id",
    [projectId, `PL-${String(sequence).padStart(3, '0')}`, title, JSON.stringify(scope)])).rows[0]?.id ?? '';
  return loadPlanning(client, id);
}

/** 이견을 고른 쪽의 변경. 고르지 않은 이견은 CP로 만들 수 없다. */
function reviewKind(kind: string): 'agree' | 'diff' {
  if (kind === 'agree' || kind === '일치') return 'agree';
  if (kind === 'diff' || kind === '이견') return 'diff';
  throw new Error(`알 수 없는 Planning 검토 kind: ${kind}`);
}

function chosenOps(review: ReviewRow): WireProposalOp[] | null {
  if (review.choice === 'codex') return review.codex.ops;
  if (review.choice === 'claude') return review.claude.ops;
  if (review.choice === null && reviewKind(review.kind) === 'diff') return null;
  return review.codex.common ?? [];
}

export function registerSessionRoutes(route: RouteFn, pool: Pool, epochOf: (request: FastifyRequest) => number): void {
  route('listPlannings', 'Planning 목록 조회', async (request) => {
    const query = request.query as { limit?: number; cursor?: string };
    const offset = query.cursor ? Number(Buffer.from(query.cursor, 'base64url').toString()) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'cursor', rule: 'format', message: '목록 위치를 알 수 없습니다.' }]);
    const limit = Math.min(query.limit ?? 50, 200);
    const rows = (await pool.query<PlanningRow>(
      `select id,planning_key,project_id,title,scope,${iso('created_at')} as created_at,${iso('updated_at')} as updated_at from plannings order by created_at desc,id desc offset $1 limit $2`, [offset, limit + 1])).rows;
    return { items: await Promise.all(rows.slice(0, limit).map((row) => planningView(pool, row))), nextCursor: rows.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null };
  });

  route('createPlanning', 'Planning 시작', async (request, reply) => {
    const client = clientOf(request);
    const body = request.body as { title: string; scope: string };
    const row = await insertPlanning(client, body.title, body.scope);
    const jobId = (await client.query<{ id: string }>(
      "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'planning',$2::jsonb,'queued',$3,$4) returning id",
      [row.project_id, JSON.stringify({ tasks: [], policy: {}, planning: { id: row.id, title: body.title, scope: body.scope }, proposal: null }), epochOf(request), `planning:${row.id}`])).rows[0]?.id;
    return reply.code(202).send({ id: row.id, jobId });
  });

  route('choosePlanningReview', 'Planning 이견 선택', async (request) => {
    const client = clientOf(request);
    const body = request.body as { updatedAt: string; choice: string; memo?: string };
    const { rid = '' } = request.params as { rid?: string };
    const planning = await loadPlanning(client, idOf(request), true);
    const review = UUID.test(rid) ? (await client.query<{ updated_at: string }>(`select ${iso('updated_at')} as updated_at from planning_reviews where id=$1 and planning=$2 for update`, [rid, planning.id])).rows[0] : undefined;
    if (!review) throw new TaskError('NOT_FOUND', { resource: 'planning_review', id: rid });
    if (!isTimestamp(body.updatedAt)) throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'updatedAt', rule: 'format', message: TIMESTAMP_MESSAGE }]);
    const same = (await client.query<{ same: boolean }>('select $1::timestamptz=$2::timestamptz as same', [review.updated_at, body.updatedAt])).rows[0]?.same;
    if (!same) throw new TaskError('VERSION_CONFLICT', { current: await planningView(client, planning), changes: [] });
    await client.query('update planning_reviews set choice=$2,memo=coalesce($3,memo) where id=$1', [rid, body.choice, body.memo ?? null]);
    await client.query('update plannings set status=status where id=$1', [planning.id]);
    return planningView(client, await loadPlanning(client, planning.id));
  }, REVIEW);

  route('createPlanningProposal', 'Planning 결과로 변경 제안 작성', async (request, reply) => {
    const client = clientOf(request);
    const body = request.body as { title: string; reason: string };
    const planning = await loadPlanning(client, idOf(request), true);
    const reviews = await reviewsOf(client, planning.id);
    const picked = reviews.map(chosenOps);
    const unchosen = picked.flatMap((ops, index) => (ops ? [] : [{ path: `reviews.${String(index)}.choice`, rule: 'required', message: `「${reviews[index]?.topic ?? ''}」 이견을 먼저 선택하세요.` }]));
    if (unchosen.length) throw new TaskError('VALIDATION_FAILED', {}, unchosen);
    const ops = picked.flat() as WireProposalOp[];
    if (!ops.length) throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'reviews', rule: 'minItems', message: '선택한 변경이 없습니다.' }]);
    const row = await insertCp(client, planning.project_id, { title: body.title, reason: body.reason, source: { kind: 'planning', id: planning.id }, ops }, LEAD, 'draft');
    await client.query("update plannings set status='proposed' where id=$1", [planning.id]);
    return reply.code(201).send(await proposalView(client, row));
  }, ID);

  route('createPlanningSession', 'Planning 세션 생성', async (request, reply) => {
    const client = clientOf(request);
    const body = request.body as { jobId: string; fence: number; title: string; scope: string };
    await assertJob(client, body.jobId, body.fence);
    const row = await insertPlanning(client, body.title, body.scope);
    return reply.code(201).send({ id: row.id });
  });

  route('submitPlanningAnalysis', 'Planning 독립 분석', async (request, reply) => {
    const client = clientOf(request);
    const body = request.body as { jobId: string; fence: number; agent: string; summary: string; items: string[] };
    await assertJob(client, body.jobId, body.fence);
    const planning = await loadPlanning(client, idOf(request), true);
    // Agent별 독립 분석은 하나다(unique(planning, agent)). 다시 보내면 최신 분석으로 바꾼다.
    await client.query(`insert into planning_analyses(project_id,planning,agent,analysis) values($1,$2,$3,$4::jsonb)
      on conflict (planning,agent) do update set analysis=excluded.analysis`, [planning.project_id, planning.id, body.agent, JSON.stringify({ summary: body.summary, items: body.items })]);
    return reply.code(201).send();
  }, ID);

  route('submitPlanningReviews', 'Planning 교차 검토', async (request, reply) => {
    const client = clientOf(request);
    const body = request.body as { jobId: string; fence: number; reviews: { topic: string; kind: string; codex: string; claude: string; ops?: WireProposalOp[]; codexOps?: WireProposalOp[]; claudeOps?: WireProposalOp[]; memo?: string }[] };
    await assertJob(client, body.jobId, body.fence);
    const planning = await loadPlanning(client, idOf(request), true);
    for (const review of body.reviews) {
      await client.query('insert into planning_reviews(project_id,planning,topic,kind,codex,claude,choice,memo,created_at) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,null,$7,clock_timestamp())',
        [planning.project_id, planning.id, review.topic, reviewKind(review.kind), JSON.stringify({ text: review.codex, ops: review.codexOps ?? [], common: review.ops ?? [] }),
          JSON.stringify({ text: review.claude, ops: review.claudeOps ?? [] }), review.memo ?? null]);
    }
    await client.query("update plannings set status='reviewed' where id=$1", [planning.id]);
    return reply.code(201).send();
  }, ID);
}
