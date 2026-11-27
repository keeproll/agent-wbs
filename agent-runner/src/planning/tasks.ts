import { isDeepStrictEqual } from 'node:util';
import type { ClaimedJob, JudgedContent } from '../api/generated/client.ts';
import { ANALYSIS_ORDER, CP_RULES, SPLIT_RULES, type AgentName, type Analysis, type ProposalOp, type SplitProposalOp, type SplitRule } from './agents.ts';
type AnyOp = ProposalOp | SplitProposalOp;
import { isAnalysis, isAnalysisPair, isCross, isDisagreements, isEstimates } from './guards.ts';
import { planningMode, splitWbs } from './payload.ts';
import { agreeEstimates, agreeJudgements, agreeSplitJudgements } from './consensus.ts';
import { judgeChanges, plainOps, proposalBind, sendProposal, splitContext } from './input-diff.ts';
import { splitTasksOf } from './judged.ts';
import { bindingProblem, bound, boundRef, fingerprint, judgedContentHash } from './binding.ts';
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
const WORK_TYPES: readonly string[] = ['Analysis', 'Design', 'Implementation', 'Configuration', 'Test', 'Verification', 'Documentation', 'Integration'];
const unsupported = (message: string): PlanningOutcome => ({ status: 'failed', error: { code: 'UNSUPPORTED_PAYLOAD', message } });

export async function runPlanning(run: JobRun<Job<'planning'>>): Promise<PlanningOutcome> {
  // 계약 5: CP 판단(proposal) · Planning 세션(planning) · 기존 Task 재판단(tasks) 중 하나다.
  const mode = planningMode(run.job);
  if (!mode) return unsupported('판단할 CP·Planning 세션·Task가 모두 없는 planning 작업입니다.');
  if (mode.mode === 'proposal') return judgeProposal(run, mode.proposal);
  if (mode.mode === 'session') return runSession(run, mode.session);
  return rejudgeTasks(run);
}

/**
 * 기존 Task 재판단(planning:null, proposal:null, tasks ≥ 1). Task마다 작성자가 등급·하위 Agent·충돌 묶음을 정하고,
 * 규칙 5·7·9는 두 Agent가 각자 판단해 합의한 것만 보낸다(POST /planning/tasks/:taskKey/plan).
 * 판단 대상은 작성자가 고른 충돌 묶음을 반영한 변경 후 내용이고, subjectHash와 sourceRef 모두 그 지문이다(srv4 fix3 계약 3).
 */
async function rejudgeTasks(run: JobRun<Job<'planning'>>): Promise<PlanningOutcome> {
  const { tasks, policy } = run.job.payload;
  const rules = enabledRules(policy);
  let disagreements: unknown[] = [];
  for (const task of tasks) {
    // 판단 대상 = 이 보고가 실제로 남길 내용: payload 내용 + 보고에 담는 충돌 묶음(D-33에서 충돌 묶음도 판단 대상).
    const shownFor = (group: { name: string } | null) => ({ ...task.content, conflictGroup: group?.name ?? null });
    const bind = (request: unknown) => {
      const body = (request as { body?: { conflictGroup?: { name: string } | null; judgedRules?: unknown } }).body;
      if (!body || body.judgedRules === undefined) return null;
      return bindingProblem(body.judgedRules, judgedContentHash(shownFor(body.conflictGroup ?? null)), task.taskKey);
    };
    await run.reporter.send('submitTaskPlan', `plan:${task.taskKey}`, () => bound(async () => {
      const plan = await run.ask('Task 재판단', (a) => a.planTask({ jobId: run.job.id, taskKey: task.taskKey, content: task.content, roles: ['dev', 'qa'], policy }));
      // 충돌 묶음을 먼저 확정하고, 그 묶음을 반영한 내용을 두 Agent에게 보여 준다(4차 리뷰 P1).
      const currentGroup = task.content.conflictGroup;
      const conflictGroup = plan.conflictGroup !== undefined ? plan.conflictGroup : currentGroup ? { name: currentGroup, reason: '기존 충돌 묶음 유지' } : null;
      const shown = shownFor(conflictGroup);
      const verdicts = rules.length ? await run.both('분할 규칙 판단', (a) => a.judgeRules({ jobId: run.job.id, rules, subjects: [{ target: task.taskKey, content: shown }] })) : { Claude: [], Codex: [] };
      // 서버 계약(srv4 fix3): subjectHash와 sourceRef 지문 모두 「변경 후 내용」(새 충돌 묶음 반영)의 서버 계산값이어야 한다.
      const shownHash = judgedContentHash(shown);
      const judged = agreeJudgements([task.taskKey], rules, verdicts, { judgedAt: run.iso(), sourceRef: run.job.id, subjectHash: () => shownHash,
        sourceRefFor: () => boundRef(shownHash) });
      disagreements = [...disagreements, ...judged.disagreements];
      return { params: { taskKey: task.taskKey }, body: { jobId: run.job.id, fence: run.job.fence, grades: plan.grades, subagents: plan.subagents, conflictGroup,
        judgedRules: judged.records.get(task.taskKey) as never } };
    }, bind, (problem) => new PlanningAgentFailed('Runner', 'Task 재판단', problem)), { bind, to: { params: { taskKey: task.taskKey } } });
  }
  return { status: 'done', result: { tasks: tasks.length, disagreements } };
}

/** 켜진 규칙만 판단한다. 서버가 policy.judgedRules로 알려 준다(없으면 세 규칙 모두). */
function enabledRules(policy: Record<string, unknown>): SplitRule[] {
  const listed = policy.judgedRules;
  if (!Array.isArray(listed)) return [...SPLIT_RULES];
  return SPLIT_RULES.filter((rule) => listed.includes(rule));
}

async function judgeProposal(run: JobRun<Job<'planning'>>, proposal: NonNullable<Job<'planning'>['payload']['proposal']>): Promise<PlanningOutcome> {
  // 이 job에서 이미 보낸 판단이 있으면 Agent에게 다시 묻지 않고 같은 본문을 다시 보낸다(결과도 그때 저장한 것).
  // 보여 주는 입력: 대상마다 「변경 후」 내용(payload의 after), 분할 판단은 ops + 원래 Task 내용. 전송 직전에 같은 투영으로 다시 대조한다.
  const afterOf = new Map(proposal.targets.map((t) => [t.target, t.after]));
  const splitShown = proposal.splitTasks ? { ops: proposal.ops, splitTasks: proposal.splitTasks } : null;
  const bind = (request: unknown) => {
    const body = (request as { body?: { judgements?: { target: string; judgedRules: unknown }[]; splitJudgements?: unknown } }).body;
    for (const j of body?.judgements ?? []) {
      const after = afterOf.get(j.target);
      if (!after) return `${j.target}는 이 CP의 판단 대상이 아닙니다`;
      const problem = bindingProblem(j.judgedRules, judgedContentHash(after), j.target);
      if (problem) return problem;
    }
    if (body?.splitJudgements === undefined) return null;
    return splitShown ? bindingProblem(body.splitJudgements, fingerprint(splitShown), '분할') : '분할 CP가 아닌데 분할 판단이 있습니다';
  };
  const stored = run.checkpoint.output(`judgements:${run.job.id}`, isDisagreements);
  if (stored && run.checkpoint.sent(run.sendScope, 'judgements')) {
    await run.reporter.send('submitProposalJudgements', 'judgements', run.checkpoint.sent(run.sendScope, 'judgements')?.request as never, { bind, to: { params: { id: proposal.id } } });
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
  const judged = agreeJudgements(subjects.map((s) => s.target), rules, verdicts, { ...meta, subjectHash: (target) => hashOf.get(target) ?? '',
    sourceRefFor: (target) => boundRef(judgedContentHash(afterOf.get(target) as JudgedContent)) });
  let split: ReturnType<typeof agreeSplitJudgements> | undefined;
  if (proposal.splitTasks) {
    const splitTasks = proposal.splitTasks;
    const hash = proposal.splitSubjectHash;
    const answers = await run.both('분할 판단', (a) => a.judgeSplit({ jobId: run.job.id, rules: CP_RULES, ops: proposal.ops, splitTasks }));
    split = agreeSplitJudgements(CP_RULES, answers, { ...meta, subjectHash: () => hash, sourceRefFor: () => boundRef(fingerprint(splitShown)) });
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
  }, { bind, to: { params: { id: proposal.id } } });
  return { status: 'done', result: { disagreements } };
}

async function runSession(run: JobRun<Job<'planning'>>, session: { id: string; title: string; scope: string }): Promise<PlanningOutcome> {
  const request = { kind: 'planning' as const, jobId: run.job.id, instruction: '', inputPath: null, commit: null, scope: { title: session.title, scope: session.scope } };
  const analyses = await sessionAnalyses(run, request);
  for (const agent of ['Codex', 'Claude'] as const) {
    await run.reporter.send('submitPlanningAnalysis', `analysis:${agent}`, {
      params: { id: session.id }, body: { jobId: run.job.id, fence: run.job.fence, agent, summary: analyses[agent].summary, items: analyses[agent].items },
    }, { to: { params: { id: session.id } } });
  }
  // 교차 검토도 먼저 저장한다. 재시작 때 다시 물으면 이미 보낸 검토와 다른 결과가 나올 수 있다.
  let cross = run.checkpoint.output('session:cross', isCross);
  if (!cross) {
    cross = await run.ask('교차 검토', (a) => a.crossReview({ ...request, analyses }));
    await run.checkpoint.saveOutput('session:cross', cross, isCross);
  }
  if (cross.reviews.length) {
    await run.reporter.send('submitPlanningReviews', 'reviews', { params: { id: session.id }, body: { jobId: run.job.id, fence: run.job.fence, reviews: cross.reviews } }, { to: { params: { id: session.id } } });
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
    // 이번 임대의 기록, 없으면 이전 버전(범위 없는 키)의 기록에서 보낸 본문을 찾는다.
    const sent = run.checkpoint.sent(run.sendScope, `analysis:${agent}`) ?? run.checkpoint.sent(run.job.id, `analysis:${agent}`);
    const body = (sent?.request as { body?: unknown } | undefined)?.body;
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
  // 어떤 보고도 보내기 전에 대조한다. 보내는 본문은 매번 검증된 합의(estimates:agreed)에서 만든다. 저장된 보낸 본문이 이것과 다르면 손상이다(3차 리뷰).
  // 고친 값으로 같은 멱등 키에 덮어쓰지 않는다: 서버가 처리한 본문과 다른 본문이 같은 키로 가게 된다.
  const body = { jobId: run.job.id, fence: run.job.fence, items: agreed.map(({ ref, ...values }) => ({ taskKey: ref, ...values })) };
  const stored = run.checkpoint.sent(run.sendScope, 'estimates');
  if (stored && !isDeepStrictEqual((stored.request as { body?: unknown }).body, body)) {
    throw new PlanningCheckpointError('보낸 추정 본문이 저장된 합의 추정과 다릅니다.');
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
    }, { to: { params: { taskKey: task.taskKey } } });
  }
  await run.reporter.send('submitEstimates', 'estimates', { body }, { to: { params: null } });
  return { status: 'done', result: { tasks: agreed.length } };
}

export async function runSplit(run: JobRun<Job<'split'>>): Promise<PlanningOutcome> {
  const { tasks, policy } = run.job.payload;
  const [task] = tasks;
  if (!task || tasks.length !== 1) return unsupported('분할 작업은 Task 하나를 대상으로 합니다.');
  // 원 Task의 작업 묶음과 선행·후행 그래프가 든 WBS 스냅샷(계약 6). 새 Task의 wp와 순서 보장(D-34)을 이 위에서 설계한다.
  const wbs = splitWbs(run.job);
  // 원 Task: 상속 전제(충돌 묶음·작업 유형)를 만든다(judged.ts effectiveGroup).
  if (!WORK_TYPES.includes(task.workType)) return unsupported(`분할할 Task ${task.taskKey}의 작업 유형(workType)이 없습니다. 옛 job은 서버가 다시 발급해야 합니다.`);
  const original = { taskKey: task.taskKey, content: task.content, workType: task.workType };
  // 분할 판단(D-34)에 보여 주는 입력: 판단 기록을 뺀 ops + 대상 Task들의 지금 내용(서버 splitSubjectHash와 같은 구성).
  const splitShown = (ops: AnyOp[]) => ({ ops, splitTasks: splitTasksOf(ops, task.taskKey, wbs) });
  const response = await sendProposal(run, async () => {
    const content = await run.ask('분할 제안', (a) => a.proposeSplit({ jobId: run.job.id, task, policy, wbs }));
    const adds = content.ops.flatMap((op) => (op.op === 'add' ? [op] : []));
    if (adds.length === 0) throw new PlanningAgentFailed(run.author.name, '분할 제안', '나눈 새 Task가 없습니다.');
    // 분할 CP의 새 Task는 분할 근거가 필수다(contracts §2.1). 비었으면 문구를 지어 넣지 않고 실패한다(data-model §2.3 basis).
    const blank = adds.find((op) => !op.t.splitBasis.trim());
    if (blank) throw new PlanningAgentFailed(run.author.name, '분할 제안', `${blank.ref}의 분할 근거가 비었습니다.`);
    const { ops, taskJudgements, disagreements } = await judgeChanges(run, content.ops, wbs, splitContext(plainOps(content.ops), original));
    const shownOps = plainOps(content.ops);
    const answers = await run.both('분할 판단', (a) => a.judgeSplit({ jobId: run.job.id, rules: CP_RULES, ops: shownOps as never, splitTasks: splitShown(shownOps).splitTasks }));
    const split = agreeSplitJudgements(CP_RULES, answers, { judgedAt: run.iso(), sourceRef: run.job.id, sourceRefFor: () => boundRef(fingerprint(splitShown(shownOps))) });
    await run.checkpoint.saveOutput(`split:${run.job.id}`, { disagreements: [...disagreements, ...split.disagreements] }, isDisagreements);
    return {
      body: { jobId: run.job.id, fence: run.job.fence, title: content.title, reason: content.reason, source: { kind: 'split' as const, id: task.taskKey },
        ops: ops as never, splitJudgements: split.record, ...(taskJudgements.length && { taskJudgements: taskJudgements as never }) },
    };
  }, proposalBind(wbs, { original, shown: splitShown }), { kind: 'split', id: task.taskKey });
  if (!response) return unsupported('분할 제안을 만들지 못했습니다.');
  const saved = run.checkpoint.output(`split:${run.job.id}`, isDisagreements);
  return { status: 'done', result: { proposalId: response.body.id, cpKey: response.body.cpKey, disagreements: saved?.disagreements ?? [] } };
}
