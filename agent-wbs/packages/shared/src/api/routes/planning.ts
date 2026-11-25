import Type from 'typebox';
import * as c from '../common.ts';
import * as m from '../models.ts';
import { operation } from '../operation.ts';

const { Body, Opt, List, Text } = c;
const Job = c.JobContext;
const planning = { principal: 'runner' } as const;

const replanned = { 201: m.ReplanSummary, 202: m.ReplanSummary };

export const planningOperations = [
  operation({
    ...planning,
    id: 'submitEstimates',
    method: 'POST',
    path: '/api/planning/estimates',
    summary: 'Task별 추정 등록·재추정(완료 Task 거부)',
    body: Body({ ...Job, items: List(Body({ taskKey: c.TaskKey, ...m.Estimate }), { minItems: 1 }) }),
    responses: { 200: Type.Object({ replan: Opt(m.ReplanSummary) }) },
    errors: ['TASK_NOT_FOUND'],
  }),
  operation({
    ...planning,
    id: 'requestReplan',
    method: 'POST',
    path: '/api/planning/replans',
    summary: '일정 재조정. 서버가 다시 계산하며 정책이 꺼져 있으면 202',
    body: Body({
      ...Job,
      trigger: Text,
      // 참고값. 서버 계산에 쓰지 않는다.
      capacity: Body({
        rate: Type.Number({ minimum: 0, maximum: 1 }),
        concurrency: c.Count,
        subRatio: Type.Number({ minimum: 0 }),
      }),
    }),
    responses: replanned,
    errors: ['SCHEDULE_CYCLE'],
  }),
  operation({
    ...planning,
    id: 'submitDraft',
    method: 'POST',
    path: '/api/planning/bootstrap/:jobId/draft',
    summary: '초기 WBS 초안 등록(승인 전 WBS 미반영)',
    body: Body({
      fence: c.Fence,
      ...m.WbsDraft,
    }),
    responses: { 201: Type.Object({ revision: Type.Integer({ minimum: 1 }) }) },
  }),
  operation({
    ...planning,
    id: 'submitTechProposals',
    method: 'POST',
    path: '/api/planning/bootstrap/:jobId/tech',
    summary: '기술 결정 제안(근거·대안)',
    body: Body({ fence: c.Fence, decisions: List(Body(m.TechProposal)) }),
    responses: { 201: null },
  }),
  operation({
    ...planning,
    id: 'createPlanningSession',
    method: 'POST',
    path: '/api/planning/sessions',
    summary: 'Planning 세션 생성',
    body: Body({ ...Job, title: Text, scope: Text }),
    responses: { 201: Type.Object({ id: c.Id }) },
  }),
  operation({
    ...planning,
    id: 'submitPlanningAnalysis',
    method: 'POST',
    path: '/api/planning/sessions/:id/analyses',
    summary: 'Agent별 독립 분석',
    body: Body({ ...Job, agent: c.Agent, summary: Text, items: List(Text) }),
    responses: { 201: null },
  }),
  operation({
    ...planning,
    id: 'submitPlanningReviews',
    method: 'POST',
    path: '/api/planning/sessions/:id/reviews',
    summary: '교차 검토(일치·이견·조정)',
    body: Body({
      ...Job,
      reviews: List(
        Body({
          topic: Text,
          kind: Text,
          codex: Type.String(),
          claude: Type.String(),
          ops: Opt(List(m.PlanningProposalOp)),
          codexOps: Opt(List(m.PlanningProposalOp)),
          claudeOps: Opt(List(m.PlanningProposalOp)),
          memo: Opt(Type.String()),
        }),
        { minItems: 1 },
      ),
    }),
    responses: { 201: null },
  }),
  operation({
    ...planning,
    id: 'submitPlanningProposal',
    method: 'POST',
    path: '/api/planning/proposals',
    summary: 'Change Proposal 제출(정책에 따라 자동 반영/보류/검토)',
    body: Body({
      ...Job,
      title: Text,
      reason: Text,
      source: Body({ kind: m.ProposalSource, id: Opt(c.Id) }),
      ops: List(m.PlanningProposalOp, { minItems: 1 }),
      // 분할 CP의 AC 의미·계층 순서·테스트 포함 판단(D-34)
      splitJudgements: Opt(m.NewSplitJudgements),
    }),
    responses: { 201: Type.Object({ id: c.Id, cpKey: Type.String(), status: m.ProposalStatus }) },
  }),
  operation({
    ...planning,
    id: 'submitTaskPlan',
    method: 'POST',
    path: '/api/planning/tasks/:taskKey/plan',
    summary: '등급·하위 Agent·충돌 묶음·분할 판단과 근거. subjectHash 불일치는 VERSION_CONFLICT',
    errors: ['VERSION_CONFLICT'],
    body: Body({
      ...Job,
      grades: m.roleGrades,
      subagents: m.roleSubagents,
      conflictGroup: c.Nullable(Body({ name: Text, reason: Text })),
      judgedRules: Opt(m.JudgedRules),
    }),
    responses: { 204: null },
  }),
];
