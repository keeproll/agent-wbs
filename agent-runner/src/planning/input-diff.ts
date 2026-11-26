import type { ApiRequest } from '../api/client.ts';
import type { ClaimedJob, PlanningProposalOp } from '../api/generated/client.ts';
import { SPLIT_RULES, type ProposalOp, type SplitProposalOp } from './agents.ts';
import { isAnalysisPair, isDiff, isDisagreements } from './guards.ts';
import type { InputDiffPayload } from './payload.ts';
import { LABELS } from './bootstrap.ts';
import { agreeJudgements, type Disagreement } from './consensus.ts';
import { runSteps, type Step } from './steps.ts';
import { JobRun, type PlanningOutcome } from './run.ts';

/*
 * 입력 자료 차이 분석 — G§4.2 ②, 원본 단계 P L4490.
 *
 *   check  GitHub 접근 · 커밋 고정(팀장이 「이 버전으로 분석」으로 고정한 커밋)
 *   unzip  변경 파일 checkout(prototype/ 읽기 전용)
 *   diff   이전 버전 커밋과 git diff 비교
 *   impact 영향 분석 — Codex·Claude가 같은 diff를 각자 분석한다
 *   cp     변경 제안 작성 — 작성자가 Task 추가·수정·재작업·취소를 CP로 쓰고, 새 Task의 판단은 두 Agent 합의로 채운다
 *
 * CP는 source.kind=input으로 제출한다. 어느 입력 작업에서 왔는지(source.id)는 서버가 job으로 정한다(Agent가 다른 버전을 가리키지 못하게).
 * 영향받는 Task가 없으면 CP 없이 cp 단계를 「변경 없음」으로 끝낸다(CP는 변경이 1개 이상이어야 한다).
 */

type DiffJob = Extract<ClaimedJob, { kind: 'input_diff' }>;

export async function runInputDiff(run: JobRun<DiffJob>, payload: InputDiffPayload): Promise<PlanningOutcome> {
  const { job, ctx, checkpoint } = run;
  const { commit, previousCommit, instruction, inputName, wbs } = payload;
  // 현재 WBS 스냅샷이 오면 영향 분석·CP 작성에 넘긴다(서버 후속 4 계약). 없으면 지금처럼 새 Task만 판단한다.
  const withWbs = wbs !== undefined ? { wbs } : {};
  const ws = ctx.workspace;
  let inputPath = '';
  let result: { proposalId: string | null; cpKey: string | null; disagreements: Disagreement[] } = { proposalId: null, cpKey: null, disagreements: [] };
  const diff = () => {
    const saved = checkpoint.output('diff', isDiff);
    if (!saved) throw new Error('diff 결과가 없습니다.');
    return saved;
  };
  const computeDiff = async () => {
    const changes = await ws.diff(previousCommit, commit);
    await checkpoint.saveOutput('diff', changes);
    return changes;
  };
  const impact = () => {
    const saved = checkpoint.output('impact', isAnalysisPair);
    if (!saved) throw new Error('영향 분석 결과가 없습니다.');
    return saved;
  };

  const steps: Step[] = [
    { key: 'check', label: LABELS.check ?? '', kind: 'workspace', run: async () => (await ws.fixCommit(commit)).note, ensure: async () => { await ws.fixCommit(commit); } },
    {
      key: 'unzip', label: LABELS.unzip ?? '', kind: 'workspace',
      run: async () => { const out = await ws.checkoutInput(inputName, commit); inputPath = out.path; return out.note; },
      ensure: async () => { inputPath = (await ws.checkoutInput(inputName, commit)).path; },
    },
    {
      key: 'diff', label: LABELS.diff ?? '', kind: 'workspace',
      run: async () => {
        const changes = await computeDiff();
        const added = changes.reduce((sum, c) => sum + c.added, 0);
        const deleted = changes.reduce((sum, c) => sum + c.deleted, 0);
        return `변경 파일 ${String(changes.length)}개 (+${String(added)} −${String(deleted)})`;
      },
      // 다른 PC면 같은 두 커밋으로 다시 계산한다. 같은 커밋 쌍의 diff는 같다.
      ensure: async () => { if (!checkpoint.output('diff', isDiff)) await computeDiff(); },
    },
    {
      key: 'impact', label: LABELS.impact ?? '', kind: 'agent', saved: () => checkpoint.output('impact', isAnalysisPair) !== undefined,
      run: async () => {
        const analyses = await run.both(LABELS.impact ?? '', (a) => a.analyze({ kind: 'input_diff', jobId: job.id, instruction, inputPath, commit, previousCommit, diff: diff(), ...withWbs }));
        await checkpoint.saveOutput('impact', analyses);
        return `Codex: ${analyses.Codex.summary} / Claude: ${analyses.Claude.summary}`;
      },
    },
    {
      key: 'cp', label: LABELS.cp ?? '', kind: 'agent', saved: () => false,
      run: async () => {
        let empty = false;
        const response = await sendProposal(run, async () => {
          const content = await run.ask(LABELS.cp ?? '', (a) => a.proposeChanges({ jobId: job.id, instruction, inputPath, diff: diff(), analyses: impact(), ...withWbs }));
          if (content.ops.length === 0) { empty = true; return null; }
          const { ops, disagreements } = await judgeAdds(run, content.ops);
          await checkpoint.saveOutput(`cp:${job.id}`, { disagreements });
          return { body: { jobId: job.id, fence: job.fence, title: content.title, reason: content.reason, source: { kind: 'input' as const }, ops: ops as PlanningProposalOp[] } };
        });
        if (empty || !response) return '변경 없음 — 영향받는 Task가 없어 변경 제안을 만들지 않았습니다.';
        const saved = checkpoint.output(`cp:${job.id}`, isDisagreements);
        result = { proposalId: response.body.id, cpKey: response.body.cpKey, disagreements: saved?.disagreements ?? [] };
        return `${response.body.cpKey} 제출(${response.body.status})`;
      },
    },
  ];
  const failed = await runSteps(run, steps);
  return failed ?? { status: 'done', result };
}

export type ProposalRequest = Omit<ApiRequest<'submitPlanningProposal'>, 'idempotencyKey' | 'epoch'>;

/** 본문을 만들지 않기로 하면(null) 보내지 않는다. 이 job에서 이미 보낸 본문이 있으면 Agent에게 다시 묻지 않고 그대로 다시 보낸다. */
export async function sendProposal(run: JobRun, build: () => Promise<ProposalRequest | null>) {
  const stored = run.checkpoint.sent(run.job.id, 'proposal');
  const request = stored ? stored.request as ProposalRequest : await build();
  if (request === null) return null;
  return run.reporter.send('submitPlanningProposal', 'proposal', request);
}

/** 새 Task(add op)마다 규칙 5·7·9를 두 Agent가 판단하고 합의한 기록을 t.judgedRules에 넣는다. hash는 서버가 붙인다. */
export async function judgeAdds(run: JobRun, ops: readonly (ProposalOp | SplitProposalOp)[]) {
  const adds = ops.flatMap((op) => (op.op === 'add' ? [op] : []));
  if (adds.length === 0) return { ops: [...ops], disagreements: [] as Disagreement[] };
  const subjects = adds.map((op) => ({ target: op.ref, content: op.t }));
  const verdicts = await run.both('분할 규칙 판단', (a) => a.judgeRules({ jobId: run.job.id, rules: SPLIT_RULES, subjects }));
  const { records, disagreements } = agreeJudgements(subjects.map((s) => s.target), SPLIT_RULES, verdicts, { judgedAt: run.iso(), sourceRef: run.job.id });
  const judged = ops.map((op) => (op.op === 'add' ? { ...op, t: { ...op.t, judgedRules: records.get(op.ref) ?? { schemaVersion: 1 as const, items: [] } } } : op));
  return { ops: judged, disagreements };
}
