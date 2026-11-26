import type { ClaimedJob } from '../api/generated/client.ts';
import { ANALYSIS_ORDER, CP_RULES, SPLIT_RULES, type AgentName, type Analysis, type SplitRule } from './agents.ts';
import { isAnalysis, isAnalysisPair, isCross, isDisagreements, isEstimates } from './guards.ts';
import { sessionOf } from './payload.ts';
import { agreeEstimates, agreeJudgements, agreeSplitJudgements } from './consensus.ts';
import { judgeAdds, sendProposal } from './input-diff.ts';
import { PlanningCheckpointError } from './checkpoint.ts';
import { JobRun, PlanningAgentFailed, type PlanningOutcome } from './run.ts';

/*
 * Task 단위 Planning job(contracts §3.2 job 종류, §3.3 Planning API).
 * - planning + proposal: 저장된 CP의 판단(POST /planning/proposals/:id/judgements)
 * - planning + payload.planning: Planning 세션의 두 분석·교차 검토(G§4.5)
 * - estimate: 추정·재추정(POST /planning/estimates), 등급 재판단이면 Task 판단(POST /planning/tasks/:taskKey/plan) 먼저
 * - split: 분할 제안 CP(POST /planning/proposals, source.kind=split)
 */

type Job<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
const unsupported = (message: string): PlanningOutcome => ({ status: 'failed', error: { code: 'UNSUPPORTED_PAYLOAD', message } });

export async function runPlanning(run: JobRun<Job<'planning'>>): Promise<PlanningOutcome> {
  const { payload } = run.job;
  if (payload.proposal) return judgeProposal(run, payload.proposal);
  const session = sessionOf(run.job);
  if (session) return runSession(run, session);
  return unsupported('판단할 CP도 Planning 세션도 없는 planning 작업입니다.');
}

/** 켜진 규칙만 판단한다. 서버가 policy.judgedRules로 알려 준다(없으면 세 규칙 모두). */
function enabledRules(policy: Record<string, unknown>): SplitRule[] {
  const listed = policy.judgedRules;
  if (!Array.isArray(listed)) return [...SPLIT_RULES];
  return SPLIT_RULES.filter((rule) => listed.includes(rule));
}

async function judgeProposal(run: JobRun<Job<'planning'>>, proposal: NonNullable<Job<'planning'>['payload']['proposal']>): Promise<PlanningOutcome> {
  // 이 job에서 이미 보낸 판단이 있으면 Agent에게 다시 묻지 않고 같은 본문을 다시 보낸다(결과도 그때 저장한 것).
  const stored = run.checkpoint.output(`judgements:${run.job.id}`, isDisagreements);
  if (stored && run.checkpoint.sent(run.job.id, 'judgements')) {
    await run.reporter.send('submitProposalJudgements', 'judgements', run.checkpoint.sent(run.job.id, 'judgements')?.request as never);
    return { status: 'done', result: { disagreements: stored.disagreements } };
  }
  const rules = enabledRules(run.job.payload.policy);
  const targets = proposal.targets;
  const hashOf = new Map(targets.map((t) => [t.target, t.subjectHash]));
  const meta = { judgedAt: run.iso(), sourceRef: run.job.id };
  // 판단 대상은 「변경 후」 내용이다. hash도 작업 payload의 값을 그대로 돌려보낸다(서버가 지금 내용과 대조).
  const subjects = targets.map((t) => ({ target: t.target, content: t.after }));
  const verdicts = rules.length && subjects.length
    ? await run.both('분할 규칙 판단', (a) => a.judgeRules({ jobId: run.job.id, rules, subjects }))
    : { Claude: [], Codex: [] };
  const judged = agreeJudgements(subjects.map((s) => s.target), rules, verdicts, { ...meta, subjectHash: (target) => hashOf.get(target) ?? '' });
  let split: ReturnType<typeof agreeSplitJudgements> | undefined;
  if (proposal.splitTasks) {
    const splitTasks = proposal.splitTasks;
    const hash = proposal.splitSubjectHash;
    const answers = await run.both('분할 판단', (a) => a.judgeSplit({ jobId: run.job.id, rules: CP_RULES, ops: proposal.ops, splitTasks }));
    split = agreeSplitJudgements(CP_RULES, answers, { ...meta, subjectHash: () => hash });
  }
  const disagreements = [...judged.disagreements, ...(split?.disagreements ?? [])];
  await run.checkpoint.saveOutput(`judgements:${run.job.id}`, { disagreements }, isDisagreements);
  await run.reporter.send('submitProposalJudgements', 'judgements', {
    params: { id: proposal.id },
    body: {
      jobId: run.job.id, fence: run.job.fence,
      judgements: subjects.map((s) => ({ target: s.target, judgedRules: judged.records.get(s.target) as never })),
      ...(split && { splitJudgements: split.record as never }),
    },
  });
  return { status: 'done', result: { disagreements } };
}

async function runSession(run: JobRun<Job<'planning'>>, session: { id: string; title: string; scope: string }): Promise<PlanningOutcome> {
  const request = { kind: 'planning' as const, jobId: run.job.id, instruction: '', inputPath: null, commit: null, scope: { title: session.title, scope: session.scope } };
  const analyses = await sessionAnalyses(run, request);
  for (const agent of ['Codex', 'Claude'] as const) {
    await run.reporter.send('submitPlanningAnalysis', `analysis:${agent}`, {
      params: { id: session.id }, body: { jobId: run.job.id, fence: run.job.fence, agent, summary: analyses[agent].summary, items: analyses[agent].items },
    });
  }
  // 교차 검토도 먼저 저장한다. 재시작 때 다시 물으면 이미 보낸 검토와 다른 결과가 나올 수 있다.
  let cross = run.checkpoint.output('session:cross', isCross);
  if (!cross) {
    cross = await run.ask('교차 검토', (a) => a.crossReview({ ...request, analyses }));
    await run.checkpoint.saveOutput('session:cross', cross, isCross);
  }
  if (cross.reviews.length) {
    await run.reporter.send('submitPlanningReviews', 'reviews', { params: { id: session.id }, body: { jobId: run.job.id, fence: run.job.fence, reviews: cross.reviews } });
  }
  return { status: 'done', result: { planningId: session.id, reviews: cross.reviews.length } };
}

/**
 * 세션의 두 분석. 서버에 보고한 분석과 교차 검토가 본 분석이 반드시 같아야 한다(독립 리뷰 3).
 * 1. 저장된 분석이 있으면 그대로 쓴다.
 * 2. 없지만 이미 보낸 분석 보고가 있으면(이전 버전 기록) 보낸 본문에서 되살린다.
 * 3. 그래도 없는 Agent만 새로 묻고, **보고하기 전에** 저장한다.
 */
async function sessionAnalyses(run: JobRun<Job<'planning'>>, request: Parameters<import('./agents.ts').PlanningAgent['analyze']>[0]): Promise<Record<AgentName, Analysis>> {
  const saved = run.checkpoint.output('session:analyses', isAnalysisPair);
  if (saved) return saved;
  const pair = {} as Record<AgentName, Analysis>;
  for (const agent of ANALYSIS_ORDER) {
    const body = (run.checkpoint.sent(run.job.id, `analysis:${agent}`)?.request as { body?: unknown } | undefined)?.body;
    const restored = body && typeof body === 'object' ? { summary: (body as Analysis).summary, items: (body as Analysis).items } : undefined;
    pair[agent] = isAnalysis(restored) ? restored : await run.call(run.ctx.agents[agent], 'Planning 독립 분석', (a) => a.analyze(request));
  }
  await run.checkpoint.saveOutput('session:analyses', pair, isAnalysisPair);
  return pair;
}

export async function runEstimate(run: JobRun<Job<'estimate'>>): Promise<PlanningOutcome> {
  const { tasks, policy } = run.job.payload;
  // 합의한 추정은 보내기 전에 저장한다. 재시작 때 다시 물어 보낸 값과 다른 값을 결과로 쓰지 않는다.
  let agreed = run.checkpoint.output('estimates:agreed', isEstimates);
  // 저장된 합의가 이 작업의 Task와 하나씩 맞아야 한다. 다르면 다른 작업의 기록이거나 손상이다.
  const keys = tasks.map((t) => t.taskKey).sort();
  if (agreed && JSON.stringify(agreed.map((e) => e.ref).sort()) !== JSON.stringify(keys)) {
    throw new PlanningCheckpointError('저장된 합의 추정의 Task가 이 작업의 Task와 다릅니다.');
  }
  if (!agreed) {
    const answers = await run.both('작업량 추정', (a) => a.estimate({ jobId: run.job.id, tasks: tasks.map((t) => ({ ref: t.taskKey, content: t.content })), policy }));
    try { agreed = agreeEstimates(tasks.map((t) => t.taskKey), answers); }
    catch (error) { throw new PlanningAgentFailed('Runner', '추정 합의', error instanceof Error ? error.message : String(error)); }
    await run.checkpoint.saveOutput('estimates:agreed', agreed, isEstimates);
  }
  // 등급 재판단(G§7.2, D-29): 대상 역할의 등급을 먼저 보고한다. 서버가 허용·최저선을 검사해 저장하고, 이어지는 재추정이 일정을 다시 계산한다.
  for (const target of policy.rejudge?.targets ?? []) {
    const task = tasks.find((t) => t.taskKey === target.taskKey);
    if (!task) throw new PlanningAgentFailed('Runner', '등급 재판단', `${target.taskKey} 내용이 작업에 없습니다.`);
    await run.reporter.send('submitTaskPlan', `plan:${task.taskKey}`, async () => {
      const plan = await run.ask('등급 재판단', (a) => a.planTask({ jobId: run.job.id, taskKey: task.taskKey, content: task.content, roles: target.roles, policy }));
      // 작성자가 충돌 묶음을 말하지 않으면 지금 묶음을 유지한다. null을 보내면 묶음이 풀린다.
      const current = task.content.conflictGroup;
      const conflictGroup = plan.conflictGroup !== undefined ? plan.conflictGroup : current ? { name: current, reason: '기존 충돌 묶음 유지' } : null;
      return { params: { taskKey: task.taskKey }, body: { jobId: run.job.id, fence: run.job.fence, grades: plan.grades, subagents: plan.subagents, conflictGroup } };
    });
  }
  await run.reporter.send('submitEstimates', 'estimates', {
    body: { jobId: run.job.id, fence: run.job.fence, items: agreed.map(({ ref, ...values }) => ({ taskKey: ref, ...values })) },
  });
  return { status: 'done', result: { tasks: agreed.length } };
}

export async function runSplit(run: JobRun<Job<'split'>>): Promise<PlanningOutcome> {
  const { tasks, policy } = run.job.payload;
  const [task] = tasks;
  if (!task || tasks.length !== 1) return unsupported('분할 작업은 Task 하나를 대상으로 합니다.');
  const response = await sendProposal(run, async () => {
    const content = await run.ask('분할 제안', (a) => a.proposeSplit({ jobId: run.job.id, task, policy }));
    const adds = content.ops.flatMap((op) => (op.op === 'add' ? [op] : []));
    if (adds.length === 0) throw new PlanningAgentFailed(run.author.name, '분할 제안', '나눈 새 Task가 없습니다.');
    // 분할 CP의 새 Task는 분할 근거가 필수다(contracts §2.1). 비었으면 문구를 지어 넣지 않고 실패한다(data-model §2.3 basis).
    const blank = adds.find((op) => !op.t.splitBasis.trim());
    if (blank) throw new PlanningAgentFailed(run.author.name, '분할 제안', `${blank.ref}의 분할 근거가 비었습니다.`);
    const { ops, disagreements } = await judgeAdds(run, content.ops);
    const splitTasks = [{ taskKey: task.taskKey, content: task.content }];
    const answers = await run.both('분할 판단', (a) => a.judgeSplit({ jobId: run.job.id, rules: CP_RULES, ops: content.ops, splitTasks }));
    const split = agreeSplitJudgements(CP_RULES, answers, { judgedAt: run.iso(), sourceRef: run.job.id });
    await run.checkpoint.saveOutput(`split:${run.job.id}`, { disagreements: [...disagreements, ...split.disagreements] }, isDisagreements);
    return {
      body: { jobId: run.job.id, fence: run.job.fence, title: content.title, reason: content.reason, source: { kind: 'split' as const, id: task.taskKey },
        ops: ops as never, splitJudgements: split.record },
    };
  });
  if (!response) return unsupported('분할 제안을 만들지 못했습니다.');
  const saved = run.checkpoint.output(`split:${run.job.id}`, isDisagreements);
  return { status: 'done', result: { proposalId: response.body.id, cpKey: response.body.cpKey, disagreements: saved?.disagreements ?? [] } };
}
