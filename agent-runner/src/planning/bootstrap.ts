import type { ClaimedJob } from '../api/generated/client.ts';
import { SPLIT_RULES, type AgentName, type Analysis } from './agents.ts';
import { isAnalysis, isCross, isDisagreements } from './guards.ts';
import { bindingProblem, bound, boundRef, judgedContentHash, withoutJudged } from './binding.ts';
import { judgedOfDraftTask } from './judged.ts';
import type { BootstrapPayload } from './payload.ts';
import { agreeEstimates, agreeJudgements, type Disagreement } from './consensus.ts';
import { runSteps, type Step } from './steps.ts';
import { JobRun, PlanningAgentFailed, type PlanningOutcome } from './run.ts';

/*
 * 초기 분석(PL-000) — G§4.2 ①, 원본 단계 P L4488-4489.
 *
 *   check  GitHub 접근 · 커밋 고정
 *   unzip  입력 자료 checkout(prototype/ 읽기 전용, 안의 스크립트·설치 명령은 실행하지 않음)
 *   repo   작업 준비(로컬 clone, 없는 src/·contracts/·.agentwbs/ 생성 커밋, 기준 커밋 기록)
 *   codex  Codex 독립 분석
 *   claude Claude 독립 분석(설계 문서 반영)
 *   cross  교차 검토 · 이견 조정 → 끝나면 기술 결정 제안(POST /planning/bootstrap/:jobId/tech)
 *   tech   기술 결정 확정 — 팀장 단계. Runner는 보고하지 않고 job을 끝낸다. 팀장이 확정하면 서버가 resumeStep=draft인 새 job을 만든다.
 *   draft  WBS 초안 작성 → POST /planning/bootstrap/:jobId/draft(서버가 draft 완료·approve 진행으로 바꾼다)
 *   approve 팀장 승인 — 팀장 단계
 *
 * 재분석(runNo ≥ 2)은 Codex 분석부터 다시 하되 확정된 기술 결정은 유지한다(G§4.2, P reBoot L4550). 그래서 tech를 다시 제안하지 않는다.
 */

type BootJob = Extract<ClaimedJob, { kind: 'bootstrap' }>;
export const LABELS: Record<string, string> = {
  check: 'GitHub 접근 · 커밋 고정', unzip: '입력 자료 checkout', repo: '작업 준비', codex: 'Codex 독립 분석', claude: 'Claude 독립 분석',
  cross: '교차 검토 · 이견 조정', draft: 'WBS 초안 작성', diff: '이전 버전과 비교', impact: '영향 분석', cp: '변경 제안 작성',
};

export async function runBootstrap(run: JobRun<BootJob>, payload: BootstrapPayload): Promise<PlanningOutcome> {
  const { job, ctx, checkpoint } = run;
  const { commit, instruction, resumeStep, runNo, inputName, techConstraints, techDecisions, decisionSnapshot, subagentDefs } = payload;
  const ws = ctx.workspace;
  // 기술 결정이 이미 확정됐는가: 초안 단계부터(confirmTech가 만든 job)·재분석(runNo ≥ 2)·확정 결정 목록이 있고 대기 결정이 없음.
  // 확정 뒤에는 기술 결정을 다시 제안하지 않는다(서버도 tech 단계가 wait일 때만 받는다).
  const techDone = runNo > 1 || resumeStep === 'draft' || (techDecisions.length > 0 && !techDecisions.some((d) => d.status === 'pending'));
  let inputPath = '';
  // 기술 제약은 분석·교차 검토에 넘긴다. 조건부 선호의 판단을 서버가 발급한 constraintId로 답하게 하기 위해서다(서버 후속 4 계약 2).
  const base = () => ({ kind: 'bootstrap' as const, jobId: job.id, instruction, inputPath, commit, techConstraints });
  const analyses = () => {
    const pair = { Codex: checkpoint.output('analysis:Codex', isAnalysis), Claude: checkpoint.output('analysis:Claude', isAnalysis) };
    if (!pair.Codex || !pair.Claude) throw new Error('독립 분석 결과가 없습니다.');
    return pair as Record<AgentName, Analysis>;
  };
  const analysisStep = (key: 'codex' | 'claude', agent: AgentName): Step => ({
    key, label: LABELS[key] ?? key, kind: 'agent', saved: () => checkpoint.output(`analysis:${agent}`, isAnalysis) !== undefined,
    run: async () => {
      // 독립 분석: 상대 Agent의 분석을 넘기지 않는다.
      const analysis = await run.call(ctx.agents[agent], LABELS[key] ?? key, (a) => a.analyze(base()));
      await checkpoint.saveOutput(`analysis:${agent}`, analysis, isAnalysis);
      return analysis.summary;
    },
  });
  let result: { revision: number; disagreements: Disagreement[] } | undefined;

  const steps: Step[] = [
    { key: 'check', label: LABELS.check ?? '', kind: 'workspace', run: async () => (await ws.fixCommit(commit)).note, ensure: async () => { await ws.fixCommit(commit); } },
    {
      key: 'unzip', label: LABELS.unzip ?? '', kind: 'workspace',
      run: async () => { const out = await ws.checkoutInput(inputName, commit); inputPath = out.path; return out.note; },
      ensure: async () => { inputPath = (await ws.checkoutInput(inputName, commit)).path; },
    },
    // 원격 쓰기가 있는 단계라 재개 때 다시 하지 않는다(ensure 없음).
    { key: 'repo', label: LABELS.repo ?? '', kind: 'workspace', run: async () => (await ws.prepareWork(commit)).note },
    analysisStep('codex', 'Codex'),
    analysisStep('claude', 'Claude'),
    {
      key: 'cross', label: LABELS.cross ?? '', kind: 'agent', saved: () => checkpoint.output('cross', isCross) !== undefined,
      run: async () => {
        const cross = await run.ask(LABELS.cross ?? '', (a) => a.crossReview({ ...base(), analyses: analyses() }));
        await checkpoint.saveOutput('cross', cross, isCross);
        return cross.summary;
      },
    },
    {
      key: 'draft', label: LABELS.draft ?? '', kind: 'agent', saved: () => false,
      run: async () => {
        // 전송 직전 대조: 초안 Task마다 판단이 그 Task(판단 기록 제외)를 본 판단인지 본다.
        const bind = (request: unknown) => {
          for (const t of ((request as { body?: { tasks?: Record<string, unknown>[] } }).body?.tasks ?? [])) {
            const problem = bindingProblem(t.judgedRules, judgedContentHash(judgedOfDraftTask(withoutJudged(t) as never)), String(t.ref));
            if (problem) return problem;
          }
          return null;
        };
        const response = await run.reporter.send('submitDraft', 'draft', () => bound(async () => {
          // 확정 결정 스냅샷(계약 3)과 허용된 하위 Agent 정의(계약 4)를 넘긴다. 교차 검토의 tech는 팀장이 정하기 전의 「제안」일 뿐이다.
          const built = await buildDraft(run, { ...base(), cross: required(checkpoint.output('cross', isCross)), analyses: analyses(), decisions: decisionSnapshot, subagentDefs });
          await checkpoint.saveOutput(`draft:${job.id}`, { disagreements: built.disagreements }, isDisagreements);
          return { params: { jobId: job.id }, body: { fence: job.fence, ...built.body } };
        }, bind, (problem) => new PlanningAgentFailed('Runner', LABELS.draft ?? '', problem)), { bind, to: { params: { jobId: job.id } } });
        const saved = checkpoint.output(`draft:${job.id}`, isDisagreements);
        result = { revision: response.body.revision, disagreements: saved?.disagreements ?? [] };
        // 초안 단계 완료는 서버가 초안 등록 때 기록한다(진행 보고로 끝내면 400).
        return null;
      },
    },
  ];

  const submitTech = async () => {
    const tech = required(checkpoint.output('cross', isCross)).tech;
    await run.reporter.send('submitTechProposals', 'tech', {
      params: { jobId: job.id },
      body: { fence: job.fence, decisions: tech?.decisions ?? [], conditionJudgements: tech?.conditionJudgements ?? [] },
    }, { to: { params: { jobId: job.id } } });
  };
  const failed = await runSteps(run, steps, techDone ? {} : { after: { cross: submitTech }, stopAfter: 'cross' });
  if (failed) return failed;
  if (!techDone) return { status: 'done', result: { waiting: 'tech' } };
  return { status: 'done', result: { ...required(result) } };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('앞 단계 결과가 없습니다.');
  return value;
}

/** 작성자 초안에 두 Agent의 독립 추정·판단을 채운다. 작성자의 단독 추정·판단은 쓰지 않는다. */
async function buildDraft(run: JobRun<BootJob>, request: Parameters<import('./agents.ts').PlanningAgent['draft']>[0]) {
  const content = await run.ask(LABELS.draft ?? '', (a) => a.draft(request));
  // 하위 Agent는 허용된 정의 id만 쓴다. 다른 id는 서버가 거부하므로 보내기 전에 Agent 출력 오류로 멈춘다.
  const allowed = new Map(request.subagentDefs.map((d) => [d.id, d.role]));
  for (const task of content.tasks) {
    for (const role of ['dev', 'qa'] as const) {
      const unknown = task.subagents[role].find((id) => !allowed.has(id));
      if (unknown) throw new PlanningAgentFailed(run.author.name, LABELS.draft ?? '', `${task.ref}의 ${role} 하위 Agent ${unknown}는 허용된 정의가 아닙니다.`);
    }
  }
  const refs = content.tasks.map((t) => t.ref);
  const subjects = content.tasks.map((t) => ({ target: t.ref, content: t }));
  // 추정은 판단 기록이 아니므로 작성자 초안을 보여 준다.
  const estimates = await run.both('작업량 추정', (a) => a.estimate({ jobId: run.job.id, tasks: subjects.map((s) => ({ ref: s.target, content: s.content })) }));
  let agreed;
  try { agreed = new Map(agreeEstimates(refs, estimates).map((e) => [e.ref, e])); }
  catch (error) { throw new PlanningAgentFailed('Runner', '추정 합의', error instanceof Error ? error.message : String(error)); }
  // 보낼 Task(합의 추정 반영)를 먼저 만들고, 그 Task를 그대로 규칙 판단에 보여 준다(4차 리뷰 P1).
  const finals = content.tasks.map((task) => {
    const estimate = agreed.get(task.ref);
    if (!estimate) throw new Error(`${task.ref} 추정이 없습니다.`);
    const values = { estHours: estimate.estHours, loHours: estimate.loHours, hiHours: estimate.hiHours, confidence: estimate.confidence, basis: estimate.basis, agreedBy: estimate.agreedBy,
      ...(estimate.tokensK !== undefined && { tokensK: estimate.tokensK }) };
    return { ...task, estimate: values };
  });
  // 판단 대상은 초안 Task가 WBS가 됐을 때의 JudgedContent(서버 draftSource와 같은 정의)다.
  const verdicts = await run.both('분할 규칙 판단', (a) => a.judgeRules({ jobId: run.job.id, rules: SPLIT_RULES, subjects: finals.map((t) => ({ target: t.ref, content: judgedOfDraftTask(t) })) }));
  const fp = new Map(finals.map((t) => [t.ref, judgedContentHash(judgedOfDraftTask(t))]));
  const { records, disagreements } = agreeJudgements(refs, SPLIT_RULES, verdicts,
    { judgedAt: run.iso(), sourceRef: run.job.id, sourceRefFor: (ref) => boundRef(run.job.id, fp.get(ref) ?? '') });
  const tasks = finals.map((task) => ({ ...task, judgedRules: records.get(task.ref) ?? { schemaVersion: 1 as const, items: [] } }));
  return { body: { ...content, tasks }, disagreements };
}
