import type { ApiRequest } from '../api/client.ts';
import type { ClaimedJob, PlanningProposalOp } from '../api/generated/client.ts';
import { SPLIT_RULES, type ProposalOp, type SplitProposalOp } from './agents.ts';
import { isAnalysisPair, isDiff, isDisagreements } from './guards.ts';
import type { InputDiffPayload, WbsSnapshot } from './payload.ts';
import { LABELS } from './bootstrap.ts';
import { agreeJudgements, type Disagreement } from './consensus.ts';
import { runSteps, type Step } from './steps.ts';
import { JobRun, PlanningAgentFailed, type PlanningOutcome } from './run.ts';

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


export async function runInputDiff(run: JobRun<Extract<ClaimedJob, { kind: 'input_diff' }>>, payload: InputDiffPayload): Promise<PlanningOutcome> {
  const { job, ctx, checkpoint } = run;
  const { commit, previousCommit, instruction, inputName, wbs } = payload;
  // 현재 WBS 스냅샷을 영향 분석·CP 작성에 넘긴다(서버 후속 4 계약 6). 기존 Task 수정의 판단도 이 스냅샷으로 만든다.
  const withWbs = { wbs };
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
    await checkpoint.saveOutput('diff', changes, isDiff);
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
        await checkpoint.saveOutput('impact', analyses, isAnalysisPair);
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
          const { ops, taskJudgements, disagreements } = await judgeChanges(run, content.ops, wbs);
          await checkpoint.saveOutput(`cp:${job.id}`, { disagreements }, isDisagreements);
          return { body: { jobId: job.id, fence: job.fence, title: content.title, reason: content.reason, source: { kind: 'input' as const }, ops: ops as PlanningProposalOp[],
            ...(taskJudgements.length && { taskJudgements: taskJudgements as never }) } };
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

/** 판단 대상 내용(JudgedContent)을 바꾸는 수정 항목. 우선순위·담당 변경은 판단 대상이 아니다(data-model §2.3-1). */
const CONTENT_FIELDS = new Set(['title', 'doneCond', 'scopeAdd', 'acAdd']);

/**
 * CP의 판단 기록을 채운다. 두 Agent가 각자 판단하고 합의한 것만 남긴다(D-33).
 * - 새 Task(add op): 그 Task 내용(op.t)을 판단해 `t.judgedRules`에 넣는다.
 * - 내용이 바뀌는 기존 Task(modify op의 title·doneCond·scopeAdd·acAdd): WBS 스냅샷의 현재 내용과 그 Task의 변경 목록을 함께 판단해
 *   `taskJudgements[{taskKey,judgedRules}]`로 보낸다(서버 후속 4 계약 6).
 *   - 「변경 후 내용」을 Runner가 직접 만들지 않는다. acAdd 문장 해석 같은 적용 규칙은 서버(simulate)가 기준이기 때문이다.
 *   - hash도 보내지 않는다. 서버가 변경 적용 후 내용으로 계산해 붙인다(contracts §3.3).
 * - 스냅샷에 없는 Task를 바꾸려 하면 Agent 출력 오류다(서버도 거부한다).
 */
export async function judgeChanges(run: JobRun, ops: readonly (ProposalOp | SplitProposalOp)[], wbs: WbsSnapshot) {
  const current = new Map(wbs.tasks.map((t) => [t.taskKey, t]));
  const changes = new Map<string, unknown[]>();
  for (const op of ops) {
    if (op.op !== 'modify' || !CONTENT_FIELDS.has(op.field)) continue;
    if (!current.has(op.task)) throw new PlanningAgentFailed(run.author.name, '변경 제안', `${op.task}는 WBS 스냅샷에 없는 Task입니다.`);
    changes.set(op.task, [...(changes.get(op.task) ?? []), op]);
  }
  const adds = ops.flatMap((op) => (op.op === 'add' ? [op] : []));
  const subjects = [
    ...adds.map((op) => ({ target: op.ref, content: op.t })),
    ...[...changes].map(([taskKey, list]) => ({ target: taskKey, content: { before: current.get(taskKey)?.content, changes: list } })),
  ];
  if (subjects.length === 0) return { ops: [...ops], taskJudgements: [] as { taskKey: string; judgedRules: unknown }[], disagreements: [] as Disagreement[] };
  const verdicts = await run.both('분할 규칙 판단', (a) => a.judgeRules({ jobId: run.job.id, rules: SPLIT_RULES, subjects }));
  const { records, disagreements } = agreeJudgements(subjects.map((s) => s.target), SPLIT_RULES, verdicts, { judgedAt: run.iso(), sourceRef: run.job.id });
  const empty = { schemaVersion: 1 as const, items: [] };
  const judged = ops.map((op) => (op.op === 'add' ? { ...op, t: { ...op.t, judgedRules: records.get(op.ref) ?? empty } } : op));
  const taskJudgements = [...changes.keys()].map((taskKey) => ({ taskKey, judgedRules: records.get(taskKey) ?? empty }));
  return { ops: judged, taskJudgements, disagreements };
}
