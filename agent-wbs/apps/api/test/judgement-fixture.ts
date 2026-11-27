import type { Pool } from '@awbs/db';
import type { WireProposalOp } from '@awbs/shared/api';
import { evaluate } from '../src/planning/evaluate.ts';
import { stripJudgements } from '../src/planning/content.ts';

/** 정상 CP 시험의 판단 입력을 먼저 확정한다. 거부 시험에서는 준비 뒤 입력이나 지문을 바꾼다. */
export async function proposalFixture(pool: Pool, projectId: string, body: Record<string, unknown>) {
  const client = await pool.connect();
  try {
    const source = body.source as { kind: string; id?: string } | undefined;
    const ev = await evaluate(client, { projectId, source: source?.kind ?? 'planning', sourceId: source?.id ?? null,
      ops: stripJudgements(body.ops as WireProposalOp[]), taskJudgements: [], splitJudgements: null });
    const bind = (record: { items: Record<string, unknown>[] }, hash: string | undefined | null) => {
      if (!hash) throw new Error('판단 fixture의 대상이 없습니다.');
      return { ...record, items: record.items.map((item) => ({ ...item, sourceRef: `sha256:${hash}` })) };
    };
    return { ...body,
      ops: (body.ops as (WireProposalOp & { t?: { judgedRules?: { items: Record<string, unknown>[] } } })[]).map((op) => {
        if (op.op !== 'add' || !op.t.judgedRules) return op;
        return { ...op, t: { ...op.t, judgedRules: bind(op.t.judgedRules, ev.afterHash.get(ev.refs.get(op.ref) ?? '')) } };
      }),
      ...(body.taskJudgements ? { taskJudgements: (body.taskJudgements as { taskKey: string; judgedRules: { items: Record<string, unknown>[] } }[])
        .map((entry) => ({ ...entry, judgedRules: bind(entry.judgedRules, ev.afterHash.get(entry.taskKey)) })) } : {}),
      ...(body.splitJudgements ? { splitJudgements: bind(body.splitJudgements as { items: Record<string, unknown>[] }, ev.splitHash) } : {}),
    };
  } finally { client.release(); }
}
