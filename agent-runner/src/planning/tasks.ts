import type { ClaimedJob } from '../api/generated/client.ts';
import { CP_RULES, SPLIT_RULES, type SplitRule } from './agents.ts';
import { agreeEstimates, agreeJudgements, agreeSplitJudgements } from './consensus.ts';
import { judgeAdds, sendProposal } from './input-diff.ts';
import { extra, JobRun, PlanningAgentFailed, type PlanningOutcome } from './run.ts';

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
  const session = extra(payload, 'planning') as { id?: unknown; title?: unknown; scope?: unknown } | undefined;
  if (session && typeof session.id === 'string') {
    return runSession(run, { id: session.id, title: String(session.title ?? ''), scope: String(session.scope ?? '') });
  }
  return unsupported('판단할 CP도 Planning 세션도 없는 planning 작업입니다.');
}

/** 켜진 규칙만 판단한다. 서버가 policy.judgedRules로 알려 준다(없으면 세 규칙 모두). */
function enabledRules(policy: Record<string, unknown>): SplitRule[] {
  const listed = policy.judgedRules;
  if (!Array.isArray(listed)) return [...SPLIT_RULES];
  return SPLIT_RULES.filter((rule) => listed.includes(rule));
}

async function judgeProposal(run: JobRun<Job<'planning'>>, proposal: NonNullable<Job<'planning'>['payload']['proposal']>): Promise<PlanningOutcome> {
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
  await run.reporter.send('submitProposalJudgements', 'judgements', {
    params: { id: proposal.id },
    body: {
      jobId: run.job.id, fence: run.job.fence,
      judgements: subjects.map((s) => ({ target: s.target, judgedRules: judged.records.get(s.target) as never })),
      ...(split && { splitJudgements: split.record as never }),
    },
  });
  return { status: 'done', result: { disagreements: [...judged.disagreements, ...(split?.disagreements ?? [])] } };
}

async function runSession(run: JobRun<Job<'planning'>>, session: { id: string; title: string; scope: string }): Promise<PlanningOutcome> {
  const request = { kind: 'planning' as const, jobId: run.job.id, instruction: '', inputPath: null, commit: null, scope: { title: session.title, scope: session.scope } };
  const analyses = await run.both('Planning 독립 분석', (a) => a.analyze(request));
  for (const agent of ['Codex', 'Claude'] as const) {
    await run.reporter.send('submitPlanningAnalysis', `analysis:${agent}`, {
      params: { id: session.id }, body: { jobId: run.job.id, fence: run.job.fence, agent, summary: analyses[agent].summary, items: analyses[agent].items },
    });
  }
  const cross = await run.ask('교차 검토', (a) => a.crossReview({ ...request, analyses }));
  if (cross.reviews.length) {
    await run.reporter.send('submitPlanningReviews', 'reviews', { params: { id: session.id }, body: { jobId: run.job.id, fence: run.job.fence, reviews: cross.reviews } });
  }
  return { status: 'done', result: { planningId: session.id, reviews: cross.reviews.length } };
}

export async function runEstimate(run: JobRun<Job<'estimate'>>): Promise<PlanningOutcome> {
  const { tasks, policy } = run.job.payload;
  const answers = await run.both('작업량 추정', (a) => a.estimate({ jobId: run.job.id, tasks: tasks.map((t) => ({ ref: t.taskKey, content: t.content })), policy }));
  let agreed;
  try { agreed = agreeEstimates(tasks.map((t) => t.taskKey), answers); }
  catch (error) { throw new PlanningAgentFailed('Runner', '추정 합의', error instanceof Error ? error.message : String(error)); }
  // 등급 재판단(G§7.2, D-29): 대상 역할의 등급을 먼저 보고한다. 서버가 허용·최저선을 검사해 저장하고, 이어지는 재추정이 일정을 다시 계산한다.
  for (const target of policy.rejudge?.targets ?? []) {
    const task = tasks.find((t) => t.taskKey === target.taskKey);
    if (!task) throw new PlanningAgentFailed('Runner', '등급 재판단', `${target.taskKey} 내용이 작업에 없습니다.`);
    const plan = await run.ask('등급 재판단', (a) => a.planTask({ jobId: run.job.id, taskKey: task.taskKey, content: task.content, roles: target.roles, policy }));
    // 작성자가 충돌 묶음을 말하지 않으면 지금 묶음을 유지한다. null을 보내면 묶음이 풀린다.
    const current = task.content.conflictGroup;
    const conflictGroup = plan.conflictGroup !== undefined ? plan.conflictGroup : current ? { name: current, reason: '기존 충돌 묶음 유지' } : null;
    await run.reporter.send('submitTaskPlan', `plan:${task.taskKey}`, {
      params: { taskKey: task.taskKey }, body: { jobId: run.job.id, fence: run.job.fence, grades: plan.grades, subagents: plan.subagents, conflictGroup },
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
    await run.checkpoint.saveOutput(`split:${run.job.id}`, { disagreements: [...disagreements, ...split.disagreements] });
    return {
      body: { jobId: run.job.id, fence: run.job.fence, title: content.title, reason: content.reason, source: { kind: 'split' as const, id: task.taskKey },
        ops: ops as never, splitJudgements: split.record },
    };
  });
  if (!response) return unsupported('분할 제안을 만들지 못했습니다.');
  const saved = run.checkpoint.output<{ disagreements: unknown[] }>(`split:${run.job.id}`);
  return { status: 'done', result: { proposalId: response.body.id, cpKey: response.body.cpKey, disagreements: saved?.disagreements ?? [] } };
}
