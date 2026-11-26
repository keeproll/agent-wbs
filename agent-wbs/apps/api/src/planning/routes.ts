import assert from 'node:assert/strict';
import type { Pool, PoolClient } from '@awbs/db';
import type { JudgedRules } from '@awbs/shared';
import { HOLD_ERROR, inputErrors, OPERATIONS, type WireProposalOp } from '@awbs/shared/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { inEpoch } from '../platform/transaction.ts';
import { installTaskErrors, TaskError } from '../tasks/errors.ts';
import { iso } from '../tasks/read.ts';
import { lockGraph, LEAD, realTimestamp } from '../tasks/write.ts';
import { applyEvaluation, JudgementDrift } from './apply.ts';
import { stripJudgements } from './content.ts';
import { evaluate, type Evaluation } from './evaluate.ts';
import { assertJob, requestJudgement } from './jobs.ts';
import { clientOf, CP_COLUMNS, event, idOf, inputOf, insertCp, loadCp, proposalView, type CpRow } from './proposals.ts';
import { recordReplan, scheduleView } from './schedule.ts';
import { registerSessionRoutes } from './sessions.ts';
import { registerSplitRoutes } from './split.ts';

/*
 * Planning·변경 제안(CP) API(contracts §2.1 proposals 상세, §3.3 Planning API).
 * 모든 판정은 evaluate() 하나로 한다: 미리보기·승인·반영·자동 정책이 같은 함수를 부른다.
 */

const ID = { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'] };
const PLANNING = 'Planning';

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** 시뮬레이션 결과 중 화면에 보이는 부분(ProposalPreview·ProposalApplied 공통) */
const shown = (ev: Evaluation) => ({ impact: ev.impact, issues: ev.issues, holdReasons: ev.holdReasons, diff: ev.simulation.diff, idMap: ev.simulation.idMap });

async function transition(client: PoolClient, row: CpRow, status: string, kind: string, actor: string, comment = '', extra: { holdReasons?: unknown; idMap?: unknown; previewHash?: string } = {}) {
  await client.query(`update change_proposals set status=$2,hold_reasons=coalesce($3::jsonb,hold_reasons),id_map=coalesce($4::jsonb,id_map),preview_hash=coalesce($5,preview_hash) where id=$1`,
    [row.id, status, extra.holdReasons === undefined ? null : JSON.stringify(extra.holdReasons), extra.idMap === undefined ? null : JSON.stringify(extra.idMap), extra.previewHash ?? null]);
  await event(client, row, kind, actor, comment);
  return loadCp(client, row.id, false);
}

async function assertCpVersion(client: PoolClient, row: CpRow, expected: string) {
  if (!realTimestamp(expected)) throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'updatedAt', rule: 'format', message: '달력에 없는 날짜·시각입니다.' }]);
  const same = (await client.query<{ same: boolean }>('select $1::timestamptz=$2::timestamptz as same', [row.updated_at, expected])).rows[0]?.same;
  if (!same) throw new TaskError('VERSION_CONFLICT', { current: await proposalView(client, row), changes: [] });
}

const FROM: Record<string, readonly string[]> = { submit: ['draft', 'changes', 'held'], reject: ['review'], 'request-changes': ['review'], approve: ['review'], apply: ['approved'] };
const assertFrom = (row: CpRow, action: string) => {
  if (!FROM[action]?.includes(row.status)) {
    throw new TaskError('INVALID_TRANSITION', { status: row.status, action }, [], `${row.status} 상태의 변경 제안은 ${action}할 수 없습니다.`);
  }
};

/** 보류 사유가 있으면 수동 승인·반영은 409(contracts §2.1). 판단 보류가 먼저 코드를 정한다. 강제 우회는 없다. */
function holdError(ev: Evaluation): TaskError {
  const codes = ev.holdReasons.map((reason) => HOLD_ERROR[reason.code]);
  const code = (['SPLIT_JUDGEMENT_REQUIRED', 'ORDER_NOT_PRESERVED', 'ACTIVE_TASK_BLOCKED'] as const).find((item) => codes.includes(item)) ?? 'SPLIT_JUDGEMENT_REQUIRED';
  const message = {
    SPLIT_JUDGEMENT_REQUIRED: '분할 기준 판단이 유효한 충족이 아니라 변경 제안을 보류합니다.',
    ORDER_NOT_PRESERVED: '분할 뒤 원래 실행 순서가 보장되지 않아 변경 제안을 보류합니다.',
    ACTIVE_TASK_BLOCKED: '진행 중인 Task를 새로 차단하므로 변경 제안을 보류합니다.',
  }[code];
  return new TaskError(code, { holdReasons: ev.holdReasons, issues: ev.issues, previewHash: ev.previewHash }, [], message);
}

/** rule별 최대 1건(data-model §2.3-1). JSON Schema로 쓸 수 없어 서버가 검사한다. */
interface Judged { schemaVersion: 1; items: readonly { rule: string }[] }
const judgedOf = (op: WireProposalOp): Judged | undefined => (op.op === 'add' ? (op.t as unknown as { judgedRules?: Judged }).judgedRules : undefined);

function duplicateRules(record: { items: readonly { rule: string }[] } | undefined, path: string) {
  const seen = new Set<string>();
  return (record?.items ?? []).flatMap((item, index) => {
    if (!seen.has(item.rule)) { seen.add(item.rule); return []; }
    return [{ path: `${path}.items.${String(index)}.rule`, rule: 'uniqueRule', message: `규칙 ${item.rule} 판단이 두 번 있습니다.` }];
  });
}

async function projectOf(client: PoolClient): Promise<string> {
  const id = (await client.query<{ id: string }>('select id from projects')).rows[0]?.id;
  if (!id) throw new TaskError('PROJECT_NOT_FOUND', {});
  return id;
}

/** 불투명 커서: 목록에서의 위치 */
const cursorOf = (offset: number) => Buffer.from(String(offset)).toString('base64url');
const offsetOf = (cursor: string | undefined) => {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, 'base64url').toString());
  if (!Number.isSafeInteger(value) || value < 0) throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'cursor', rule: 'format', message: '목록 위치를 알 수 없습니다.' }]);
  return value;
};

export function registerPlanningRoutes(app: FastifyInstance, pool: Pool): void {
  void app.register((scope, _options, done) => {
    const actions = new Map<string, string>();
    installTaskErrors(scope, actions);
    const route = (id: string, action: string, handler: Handler, params?: object) => {
      const op = OPERATIONS.find((item) => item.id === id);
      assert(op, `계약에 없는 Planning 경로: ${id}`);
      actions.set(`${op.method} ${op.path}`, action);
      scope.route({
        method: op.method, url: op.path,
        schema: { ...(op.body ? { body: op.body } : {}), ...(op.query ? { querystring: op.query } : {}), ...(params ? { params } : {}) },
        handler: async (request, reply) => {
          // JSON Schema 밖의 입력 규칙(contracts §2.1 입력 규칙)
          const errors = inputErrors(op, request.body);
          if (errors.length) throw new TaskError('VALIDATION_FAILED', {}, errors);
          return handler(request, reply);
        },
      });
    };
    const epochOf = (request: FastifyRequest) => request.platform?.currentEpoch ?? 1;

    /**
     * 판단 job은 409 응답에서도 남아야 한다. 같은 연결(이미 CP·그래프 잠금을 잡은 트랜잭션)에서 job만 쓰고,
     * 보류 응답이어도 이 트랜잭션을 커밋하라고 공통 관문에 알린다. 이 경로는 job 외에는 아무것도 쓰지 않았다.
     * 같은 풀에서 연결을 하나 더 기다리면 동시 요청이 몰릴 때 연결이 바닥나 500이 된다(M2-07 리뷰 F3).
     */
    const holdWithJudgement = async (client: PoolClient, request: FastifyRequest, row: CpRow, ev: Evaluation): Promise<never> => {
      await requestJudgement(client, row, ev, epochOf(request));
      if (request.platform) request.platform.commitOnError = true;
      throw holdError(ev);
    };

    /** 반영. 실제로 쓴 내용의 hash가 판단과 다르면 반영을 되돌리고 보류한다(data-model §2.3-1). */
    const applyNow = async (client: PoolClient, request: FastifyRequest, row: CpRow, ev: Evaluation, actor: string) => {
      await client.query('savepoint cp_apply');
      try {
        await applyEvaluation(client, row, ev, actor);
      } catch (error) {
        if (!(error instanceof JudgementDrift)) throw error;
        await client.query('rollback to savepoint cp_apply');
        const holdReasons = error.taskKeys.map((taskKey) => ({ code: 'JUDGEMENT_MISSING' as const, taskKey, message: `${taskKey}: 반영한 내용이 판단한 내용과 달라 판단 기록이 없는 것으로 봅니다.` }));
        await requestJudgement(client, row, { ...ev, needsJudgement: true }, epochOf(request));
        // 응답 최상위의 보류 사유도 이 최종 판정이어야 한다(리뷰 F6).
        return { row: await transition(client, row, 'held', 'held', actor, '반영 내용 재대조 불일치', { holdReasons: { holdReasons, issues: ev.issues } }), holdReasons };
      }
      await client.query('release savepoint cp_apply');
      // 재조정도 같은 트랜잭션에 기록한다(D-27: 취소 반영과 SS 제거·이력·재조정이 한 트랜잭션).
      await recordReplan(client, row.project_id, { trigger: `${row.cp_key} 반영`, actor, mode: 'drift' });
      return { row: await transition(client, row, 'applied', 'applied', actor, '', { idMap: ev.simulation.idMap, previewHash: ev.previewHash, holdReasons: { holdReasons: [], issues: [] } }), holdReasons: ev.holdReasons };
    };

    route('listProposals', '변경 제안 목록 조회', async (request) => {
      const query = request.query as { status?: string; limit?: number; cursor?: string };
      const offset = offsetOf(query.cursor);
      const limit = Math.min(query.limit ?? 50, 200);
      const client = await pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const rows = (await client.query<CpRow>(`select ${CP_COLUMNS} from change_proposals where ($1::text is null or status::text=$1) order by created_at desc,id desc offset $2 limit $3`,
          [query.status ?? null, offset, limit + 1])).rows;
        const items = await Promise.all(rows.slice(0, limit).map((row) => proposalView(client, row)));
        await client.query('commit');
        return { items, nextCursor: rows.length > limit ? cursorOf(offset + limit) : null };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    });

    route('createProposal', '변경 제안 작성', async (request, reply) => {
      const client = clientOf(request);
      const body = request.body as { title: string; reason: string; source: { kind: string; id?: string }; ops: WireProposalOp[] };
      const projectId = await projectOf(client);
      const row = await insertCp(client, projectId, body, LEAD, 'draft');
      return reply.code(201).send(await proposalView(client, row));
    });

    route('previewProposal', '변경 제안 미리보기', async (request) => {
      // 미리보기에서 대상 hash가 바뀐 것을 찾으면 판단 job을 다시 만든다(contracts §2.1). 그래서 쓰기 트랜잭션으로 연다.
      return inEpoch(pool, epochOf(request), async (client) => {
        const row = await loadCp(client, idOf(request), false);
        const ev = await evaluate(client, inputOf(row));
        if (['review', 'approved', 'held'].includes(row.status)) await requestJudgement(client, row, ev, epochOf(request));
        return { previewHash: ev.previewHash, ...shown(ev) };
      });
    }, ID);

    for (const action of ['submit', 'reject', 'request-changes'] as const) {
      const id = { submit: 'submitProposal', reject: 'rejectProposal', 'request-changes': 'requestChangesProposal' }[action];
      route(id, { submit: '변경 제안 제출', reject: '변경 제안 반려', 'request-changes': '변경 제안 수정 요청' }[action], async (request) => {
        const client = clientOf(request);
        const body = request.body as { updatedAt: string; comment?: string };
        const row = await loadCp(client, idOf(request), true);
        await assertCpVersion(client, row, body.updatedAt);
        assertFrom(row, action);
        if (action !== 'submit') return proposalView(client, await transition(client, row, action === 'reject' ? 'rejected' : 'changes', action === 'reject' ? 'rejected' : 'changes', LEAD, body.comment ?? ''));
        // review에 들어온 CP에 판단이 필요하면 Planning 판단 job을 만든다.
        const ev = await evaluate(client, inputOf(row));
        await requestJudgement(client, row, ev, epochOf(request));
        return proposalView(client, await transition(client, row, 'review', 'submitted', LEAD, body.comment ?? ''));
      }, ID);
    }

    route('approveProposal', '변경 제안 승인', async (request) => {
      const client = clientOf(request);
      const body = request.body as { updatedAt: string; previewHash: string; comment?: string };
      const row = await loadCp(client, idOf(request), true);
      await assertCpVersion(client, row, body.updatedAt);
      assertFrom(row, 'approve');
      await lockGraph(client, row.project_id);
      const ev = await evaluate(client, inputOf(row));
      if (ev.holdReasons.length) await holdWithJudgement(client, request, row, ev);
      if (ev.previewHash !== body.previewHash) throw new TaskError('VERSION_CONFLICT', { current: { previewHash: ev.previewHash, ...shown(ev) }, changes: [] }, [], '미리보기 뒤에 변경 결과가 달라졌습니다.');
      return proposalView(client, await transition(client, row, 'approved', 'approved', LEAD, body.comment ?? ''));
    }, ID);

    route('applyProposal', '변경 제안 반영', async (request) => {
      const client = clientOf(request);
      const body = request.body as { updatedAt: string; previewHash: string; comment?: string };
      const row = await loadCp(client, idOf(request), true);
      await assertCpVersion(client, row, body.updatedAt);
      assertFrom(row, 'apply');
      await lockGraph(client, row.project_id);
      // 반영은 트랜잭션 안에서 다시 시뮬레이션한다(data-model §3.6). 승인 뒤 바뀐 상태로 보류 사유를 다시 판정한다.
      const ev = await evaluate(client, inputOf(row));
      if (ev.holdReasons.length) await holdWithJudgement(client, request, row, ev);
      if (ev.previewHash !== body.previewHash) throw new TaskError('VERSION_CONFLICT', { current: { previewHash: ev.previewHash, ...shown(ev) }, changes: [] }, [], '미리보기 뒤에 변경 결과가 달라졌습니다.');
      // D-33~35 외의 반영 불가 사유만 있으면 200으로 held를 돌려준다(contracts §2.1).
      const result = ev.issues.length
        ? { row: await transition(client, row, 'held', 'held', LEAD, body.comment ?? '', { holdReasons: { holdReasons: [], issues: ev.issues } }), holdReasons: ev.holdReasons }
        : await applyNow(client, request, row, ev, LEAD);
      return { proposal: await proposalView(client, result.row), ...shown(ev), holdReasons: result.holdReasons };
    }, ID);

    route('submitPlanningProposal', 'Planning 변경 제안 제출', async (request, reply) => {
      const client = clientOf(request);
      const body = request.body as {
        jobId: string; fence: number; title: string; reason: string; source: { kind: string; id?: string }; ops: WireProposalOp[];
        taskJudgements?: { taskKey: string; judgedRules: Judged }[]; splitJudgements?: Judged;
      };
      const keys = (body.taskJudgements ?? []).map((entry) => entry.taskKey);
      const errors = [
        ...keys.flatMap((key, index) => (keys.indexOf(key) === index ? [] : [{ path: `taskJudgements.${String(index)}.taskKey`, rule: 'unique', message: `${key} 판단이 두 번 있습니다.` }])),
        ...(body.taskJudgements ?? []).flatMap((entry, index) => duplicateRules(entry.judgedRules, `taskJudgements.${String(index)}.judgedRules`)),
        ...body.ops.flatMap((op, index) => duplicateRules(judgedOf(op), `ops.${String(index)}.t.judgedRules`)),
        ...duplicateRules(body.splitJudgements, 'splitJudgements'),
        ...(body.splitJudgements && body.source.kind !== 'split' ? [{ path: 'splitJudgements', rule: 'splitOnly', message: '분할 판단은 분할 CP에만 씁니다.' }] : []),
      ];
      if (errors.length) throw new TaskError('VALIDATION_FAILED', {}, errors);
      await assertJob(client, body.jobId, body.fence);
      const projectId = await projectOf(client);
      await lockGraph(client, projectId);
      // 판단의 subjectHash는 서버가 「변경 적용 후 내용」으로 계산해 붙인다(contracts §3.3). 판단을 뺀 상태로 먼저 평가한다.
      const plain = await evaluate(client, { projectId, source: body.source.kind, sourceId: body.source.id ?? null, ops: stripJudgements(body.ops), taskJudgements: [], splitJudgements: null });
      const stamp = (record: Judged, hash: string) => ({ ...record, items: record.items.map((item) => ({ ...item, subjectHash: hash })) }) as unknown as JudgedRules;
      const missing = '0'.repeat(64);
      const ops = body.ops.map((op): WireProposalOp => {
        const judged = judgedOf(op);
        if (op.op !== 'add' || !judged) return op;
        const key = plain.refs.get(op.ref);
        return { ...op, t: { ...op.t, judgedRules: stamp(judged, (key && plain.afterHash.get(key)) ?? missing) } } as WireProposalOp;
      });
      const row = await insertCp(client, projectId, { ...body, ops }, PLANNING, 'review', {
        taskJudgements: (body.taskJudgements ?? []).map((entry) => ({ taskKey: entry.taskKey, judgedRules: stamp(entry.judgedRules, plain.afterHash.get(entry.taskKey) ?? missing) })),
        splitJudgements: body.splitJudgements ? stamp(body.splitJudgements, plain.splitHash ?? missing) : null,
      });
      const auto = (await client.query<{ cp_auto: boolean | null }>('select cp_auto from schedule_policy where singleton')).rows[0]?.cp_auto === true;
      const ev = await evaluate(client, inputOf(row));
      let result = row;
      if (auto) {
        // 자동 정책: 보류·반영 불가 사유가 하나라도 있으면 held, 없으면 바로 반영(data-model §3.6). 판정은 수동과 같은 evaluate()다.
        if (ev.holdReasons.length || ev.issues.length) {
          await requestJudgement(client, row, ev, epochOf(request));
          result = await transition(client, row, 'held', 'held', PLANNING, '', { holdReasons: { holdReasons: ev.holdReasons, issues: ev.issues } });
        } else result = (await applyNow(client, request, row, ev, PLANNING)).row;
      } else await requestJudgement(client, row, ev, epochOf(request));
      return reply.code(201).send({ id: result.id, cpKey: result.cp_key, status: result.status });
    });

    route('submitProposalJudgements', 'CP 판단 기록', async (request, reply) => {
      const client = clientOf(request);
      const body = request.body as { jobId: string; fence: number; judgements: { target: string; judgedRules: { items: { rule: string; subjectHash: string }[] } }[]; splitJudgements?: { items: { rule: string; subjectHash: string }[] } };
      const errors = [
        ...body.judgements.flatMap((entry, index) => duplicateRules(entry.judgedRules, `judgements.${String(index)}.judgedRules`)),
        ...duplicateRules(body.splitJudgements, 'splitJudgements'),
      ];
      if (errors.length) throw new TaskError('VALIDATION_FAILED', {}, errors);
      await assertJob(client, body.jobId, body.fence);
      const row = await loadCp(client, idOf(request), true);
      if (['applied', 'rejected'].includes(row.status)) throw new TaskError('INVALID_TRANSITION', { status: row.status }, [], '반영·반려된 변경 제안에는 판단을 덧붙일 수 없습니다.');
      await lockGraph(client, row.project_id);
      const ev = await evaluate(client, inputOf(row));
      const current = new Map(ev.targets.map((target) => [target.target, target.subjectHash]));
      // payload의 hash(판단한 내용)가 지금 내용의 hash와 다르면 판단이 낡았다(contracts §3.3).
      const stale = body.judgements.filter((entry) => entry.judgedRules.items.some((item) => item.subjectHash !== current.get(entry.target)));
      const staleSplit = body.splitJudgements?.items.some((item) => item.subjectHash !== ev.splitHash);
      if (stale.length || staleSplit) {
        throw new TaskError('VERSION_CONFLICT', { targets: ev.targets.map(({ target, subjectHash }) => ({ target, subjectHash })), splitSubjectHash: ev.splitHash, changes: [] }, [], '판단한 내용이 지금 변경 제안의 내용과 다릅니다.');
      }
      // ops의 변경 내용은 바꾸지 않고 판단 기록만 덧붙인다(새 Task → ops[].t.judgedRules, 기존 Task → task_judgements).
      const byTarget = new Map(body.judgements.map((entry) => [entry.target, entry.judgedRules]));
      const ops = row.ops.map((op) => (op.op === 'add' && byTarget.has(op.ref) ? { ...op, t: { ...op.t, judgedRules: byTarget.get(op.ref) } } : op));
      const taskJudgements = [
        ...row.task_judgements.filter((entry) => !byTarget.has(entry.taskKey)),
        ...body.judgements.filter((entry) => !entry.target.startsWith('NEW-')).map((entry) => ({ taskKey: entry.target, judgedRules: entry.judgedRules })),
      ];
      await client.query('update change_proposals set ops=$2::jsonb,task_judgements=$3::jsonb,split_judgements=coalesce($4::jsonb,split_judgements) where id=$1',
        [row.id, JSON.stringify(ops), JSON.stringify(taskJudgements), body.splitJudgements ? JSON.stringify(body.splitJudgements) : null]);
      await event(client, row, 'judged', PLANNING);
      return reply.code(204).send();
    }, ID);

    route('submitEstimates', 'Planning 추정 등록', async (request) => {
      const client = clientOf(request);
      const body = request.body as { jobId: string; fence: number; items: { taskKey: string; estHours: number; loHours: number; hiHours: number; tokensK?: number; confidence: string; basis: string; agreedBy: string[] }[] };
      const errors = body.items.flatMap((item, index) => (item.loHours <= item.estHours && item.estHours <= item.hiHours ? []
        : [{ path: `items.${String(index)}`, rule: 'estimateBounds', message: '추정은 낙관 ≤ 예상 ≤ 비관이어야 합니다.' }]));
      if (errors.length) throw new TaskError('VALIDATION_FAILED', {}, errors);
      await assertJob(client, body.jobId, body.fence);
      const projectId = await projectOf(client);
      for (const item of body.items) {
        const task = (await client.query<{ id: string; status: string }>('select id,status::text as status from tasks where task_key=$1 and deleted_at is null for update', [item.taskKey])).rows[0];
        if (!task) throw new TaskError('TASK_NOT_FOUND', { taskKey: item.taskKey });
        // 완료 Task의 추정은 바꾸지 않는다(P TASK-0012 「완료 Task 거부」). 계약에 전용 코드가 없어 상태 불일치로 답한다.
        if (task.status === 'done') throw new TaskError('INVALID_TRANSITION', { taskKey: item.taskKey, status: task.status }, [], '완료된 Task는 다시 추정하지 않습니다.');
        await client.query('insert into task_estimates(project_id,task,est,lo,hi,tokens_k,confidence,basis,agreed_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [projectId, task.id, item.estHours, item.loHours, item.hiHours, item.tokensK ?? null, item.confidence, item.basis, item.agreedBy.join(',')]);
        await client.query(`insert into task_history(project_id,at,actor,task,kind,text,after,ref)
          values($1,greatest(clock_timestamp(),(select updated_at+interval '1 microsecond' from tasks where id=$2)),$3,$2,'추정',$4,$5::jsonb,'{"field":"estimate"}'::jsonb)`,
        [projectId, task.id, PLANNING, `추정 ${String(item.estHours)}h (${String(item.loHours)}~${String(item.hiHours)}h, 신뢰도 ${item.confidence})`, JSON.stringify({ est: item.estHours, lo: item.loHours, hi: item.hiHours })]);
        await client.query("insert into change_events(project_id,topic,ref) values($1,'task',$2::jsonb)", [projectId, JSON.stringify({ taskKey: item.taskKey })]);
      }
      // 추정이 바뀌면 일정이 바뀐다. 임계값 이상 어긋나면 재조정을 같은 트랜잭션에 기록한다.
      const replan = await recordReplan(client, projectId, { trigger: '재추정', actor: PLANNING, mode: 'drift' });
      return replan ? { replan } : {};
    });

    route('requestReplan', 'Planning 재조정 요청', async (request, reply) => {
      const client = clientOf(request);
      const body = request.body as { jobId: string; fence: number; trigger: string };
      await assertJob(client, body.jobId, body.fence);
      const summary = await recordReplan(client, await projectOf(client), { trigger: body.trigger, actor: PLANNING, mode: 'policy' });
      assert(summary);
      // 자동 재조정이 꺼져 있으면 기준 버전 없이 202 + pending(D-10)
      return reply.code(summary.baselineVersion === null ? 202 : 201).send(summary);
    });

    route('runReplan', '재조정 실행', async (request, reply) => {
      const client = clientOf(request);
      const summary = await recordReplan(client, await projectOf(client), { trigger: '재조정 실행', actor: LEAD, mode: 'manual' });
      assert(summary);
      return reply.code(201).send(summary);
    });

    route('getSchedule', '일정 조회', async () => {
      // 한 시점의 스냅샷으로 계산한다(읽기 전용 반복 읽기).
      const client = await pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const view = await scheduleView(client, await projectOf(client));
        await client.query('commit');
        return view;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    });

    route('listReplans', '재조정 기록 조회', async (request) => {
      const query = request.query as { limit?: number; cursor?: string };
      const offset = offsetOf(query.cursor);
      const limit = Math.min(query.limit ?? 50, 200);
      const rows = (await pool.query<{ id: string; rp_key: string; trigger: string; actor: string; status: string; baseline_v: number | null; after: { end: string; lo: string; hi: string; rate: number }; at: string }>(
        `select id,rp_key,trigger,actor,status,baseline_v,after,${iso('created_at')} as at from replans order by created_at desc,id desc offset $1 limit $2`, [offset, limit + 1])).rows;
      const page = rows.slice(0, limit);
      const moves = (await pool.query<{ replan: string; task_key: string; kind: string; before: { end?: string } | null; after: { end?: string } | null }>(
        'select m.replan,t.task_key,m.kind,m.before,m.after from replan_moves m join tasks t on t.id=m.task where m.replan=any($1::uuid[]) order by t.task_key', [page.map((row) => row.id)])).rows;
      const days = (a?: string, b?: string) => (a && b ? (Date.parse(b) - Date.parse(a)) / 86_400_000 : null);
      return {
        items: page.map((row) => ({
          replanId: row.rp_key, baselineVersion: row.baseline_v, projectEnd: row.after.end, range: { lo: row.after.lo, hi: row.after.hi },
          moved: moves.filter((move) => move.replan === row.id).map((move) => ({ taskKey: move.task_key, kind: move.kind, before: move.before?.end ?? null, after: move.after?.end ?? null, deltaDays: days(move.before?.end, move.after?.end) })),
          trigger: row.trigger, actor: row.actor, status: row.status, rate: row.after.rate, at: row.at,
        })),
        nextCursor: rows.length > limit ? cursorOf(offset + limit) : null,
      };
    });

    registerSplitRoutes(route, epochOf);
    registerSessionRoutes(route, pool, epochOf);
    done();
  });
}

