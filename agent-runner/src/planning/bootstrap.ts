import type { ClaimedJob } from '../api/generated/client.ts';
import { SPLIT_RULES, type AgentName, type Analysis } from './agents.ts';
import { isAnalysis, isCross, isDisagreements } from './guards.ts';
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
  const { commit, instruction, resumeStep, runNo, inputName, techConstraints, decisions } = payload;
  const ws = ctx.workspace;
  // 재분석이거나 초안 단계부터라면 기술 결정은 이미 확정됐다(서버 confirmTech가 resumeStep=draft job을 만든다).
  const techDone = runNo > 1 || resumeStep === 'draft';
  let inputPath = '';
  // 기술 제약은 분석·교차 검토에 넘긴다. 조건부 선호의 판단을 constraintId로 답하게 하기 위해서다(서버 후속 4 계약).
  const base = () => ({ kind: 'bootstrap' as const, jobId: job.id, instruction, inputPath, commit, ...(techConstraints && { techConstraints }) });
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
        const response = await run.reporter.send('submitDraft', 'draft', async () => {
          // 확정 결정 스냅샷이 오면 함께 넘긴다. 교차 검토의 tech는 팀장이 정하기 전의 「제안」일 뿐이다(독립 리뷰 계약 3).
          const built = await buildDraft(run, { ...base(), cross: required(checkpoint.output('cross', isCross)), analyses: analyses(), ...(decisions !== undefined && { decisions }) });
          await checkpoint.saveOutput(`draft:${job.id}`, { disagreements: built.disagreements }, isDisagreements);
          return { params: { jobId: job.id }, body: { fence: job.fence, ...built.body } };
        });
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
    });
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
  const refs = content.tasks.map((t) => t.ref);
  const subjects = content.tasks.map((t) => ({ target: t.ref, content: t }));
  const estimates = await run.both('작업량 추정', (a) => a.estimate({ jobId: run.job.id, tasks: subjects.map((s) => ({ ref: s.target, content: s.content })) }));
  let agreed;
  try { agreed = new Map(agreeEstimates(refs, estimates).map((e) => [e.ref, e])); }
  catch (error) { throw new PlanningAgentFailed('Runner', '추정 합의', error instanceof Error ? error.message : String(error)); }
  const verdicts = await run.both('분할 규칙 판단', (a) => a.judgeRules({ jobId: run.job.id, rules: SPLIT_RULES, subjects }));
  const { records, disagreements } = agreeJudgements(refs, SPLIT_RULES, verdicts, { judgedAt: run.iso(), sourceRef: run.job.id });
  const tasks = content.tasks.map((task) => {
    const estimate = agreed.get(task.ref);
    if (!estimate) throw new Error(`${task.ref} 추정이 없습니다.`);
    const values = { estHours: estimate.estHours, loHours: estimate.loHours, hiHours: estimate.hiHours, confidence: estimate.confidence, basis: estimate.basis, agreedBy: estimate.agreedBy,
      ...(estimate.tokensK !== undefined && { tokensK: estimate.tokensK }) };
    return { ...task, estimate: values, judgedRules: records.get(task.ref) ?? { schemaVersion: 1 as const, items: [] } };
  });
  return { body: { ...content, tasks }, disagreements };
}
