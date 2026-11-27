import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, ApiTransportError, type ApiClient, type OperationId } from '../../src/api/client.ts';
import type { ClaimedJob } from '../../src/api/generated/client.ts';
import type {
  AgentName, Analysis, AnalysisRequest, CrossReview, CrossReviewRequest, DraftContent, DraftRequest, EstimateRequest, EstimateVerdict,
  PlanningAgent, ProposalContent, ProposalRequest, SplitContent, RuleVerdict, RulesRequest, SplitRequest, SplitRulesRequest, SplitVerdict, TaskPlan, TaskPlanRequest,
} from '../../src/planning/agents.ts';
import { PlanningCheckpoints } from '../../src/planning/checkpoint.ts';
import type { PlanningContext, PlanningWorkspace } from '../../src/planning/index.ts';
import { bodyErrors } from './schema.ts';

export const SHA = 'a'.repeat(40);
export const PREV = 'b'.repeat(40);
export const HASH = 'c'.repeat(64);
export const NOW = '2026-11-27T01:02:03.000Z';

export interface Call { op: OperationId; request: { params?: Record<string, string>; body?: Record<string, unknown>; idempotencyKey?: string; epoch: number } }
type Reply = { status: number; body?: unknown } | Error;
export type Handler = (call: Call, index: number) => Reply | undefined;

const defaults: Partial<Record<OperationId, { status: number; body?: unknown }>> = {
  submitDraft: { status: 201, body: { revision: 1 } },
  submitPlanningProposal: { status: 201, body: { id: '00000000-0000-4000-8000-00000000c0de', cpKey: 'CP-0001', status: 'review' } },
  submitTechProposals: { status: 201 },
  submitPlanningAnalysis: { status: 201 },
  submitPlanningReviews: { status: 201 },
  submitEstimates: { status: 200, body: {} },
};

/** 요청 본문을 계약 스키마로 검사하고 기록하는 가짜 API. 계약에 어긋난 본문은 시험을 곧바로 실패시킨다. */
export function fakeApi(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const schemaErrors: string[] = [];
  const api = (async (op: OperationId, request: Call['request']) => {
    const call = { op, request: structuredClone(request) };
    calls.push(call);
    if (request.body) {
      const errors = bodyErrors(op, request.body);
      if (errors.length) schemaErrors.push(`${op}: ${errors.join('; ')}`);
    }
    const reply = handler(call, calls.length - 1) ?? defaults[op] ?? { status: 204 };
    if (reply instanceof Error) throw reply;
    return { status: reply.status, body: reply.body, headers: new Headers() };
  }) as unknown as ApiClient;
  return { api, calls, schemaErrors, ops: () => calls.map((c) => c.op) };
}

export const apiError = (op: OperationId, status: number, code: string) =>
  new ApiError(op, status, { code, message: `${code} 시험`, fix: '', details: {} } as never, null);
export const transportError = (op: OperationId) => new ApiTransportError(op);

/** 손으로 쓴 가짜 Planning Agent. 실제 Claude·Codex를 부르지 않는다. */
export class FakeAgent implements PlanningAgent {
  readonly calls: { method: string; request: unknown }[] = [];
  /** 메서드 이름 → 던질 오류 */
  fail: Partial<Record<keyof PlanningAgent, Error>> = {};
  /** 규칙 판단 결과 덮어쓰기: `${target}:${rule}` → 결과(없으면 met) */
  verdicts: Record<string, 'met' | 'not_met' | 'skip'> = {};
  estimates: Record<string, Omit<EstimateVerdict, 'ref'>> = {};
  ops: ProposalContent['ops'] | undefined;
  readonly name: AgentName;
  constructor(name: AgentName) { this.name = name; }

  private record(method: keyof PlanningAgent, request: unknown): void {
    this.calls.push({ method, request: structuredClone(request) });
    const error = this.fail[method];
    if (error) throw error;
  }
  called(method: keyof PlanningAgent): number { return this.calls.filter((c) => c.method === method).length; }

  analyze(request: AnalysisRequest): Promise<Analysis> {
    this.record('analyze', request);
    return Promise.resolve({ summary: `${this.name} 분석 요약`, items: [`${this.name} 후보 1`] });
  }
  crossReview(request: CrossReviewRequest): Promise<CrossReview> {
    this.record('crossReview', request);
    return Promise.resolve({
      summary: '일치 2 · 이견 0 — 합의안 작성',
      reviews: [{ topic: '화면 분할', kind: 'agree', codex: '동의', claude: '동의' }],
      tech: { decisions: [{ area: '데이터', title: '저장소', choice: 'PostgreSQL 16', reason: '문서 확정', alternatives: 'MySQL' }], conditionJudgements: [] },
    });
  }
  draft(request: DraftRequest): Promise<DraftContent> {
    this.record('draft', request);
    return Promise.resolve(draftContent());
  }
  proposeChanges(request: ProposalRequest): Promise<ProposalContent> {
    this.record('proposeChanges', request);
    return Promise.resolve({ title: '입력 v2 반영', reason: '화면 추가', ops: this.ops ?? [addOp('NEW-1')] });
  }
  proposeSplit(request: SplitRequest): Promise<SplitContent> {
    this.record('proposeSplit', request);
    return Promise.resolve({ title: '분할', reason: '크기 상한 초과', ops: (this.ops as SplitContent['ops'] | undefined) ?? [
      { ...addOp('NEW-1'), t: { ...addOp('NEW-1').t, splitBasis: '계약 먼저' } },
      { ...addOp('NEW-2'), t: { ...addOp('NEW-2').t, splitBasis: '구현' } },
      { op: 'remove', task: 'TASK-0001' },
    ] });
  }
  planTask(request: TaskPlanRequest): Promise<TaskPlan> {
    this.record('planTask', request);
    return Promise.resolve({ grades: grades(), subagents: { dev: [], qa: [], basis: '기본 Agent' } });
  }
  estimate(request: EstimateRequest): Promise<EstimateVerdict[]> {
    this.record('estimate', request);
    return Promise.resolve(request.tasks.map((t) => ({ ref: t.ref, estHours: 2, loHours: 1, hiHours: 3, confidence: '중' as const, basis: `${this.name} 근거`, ...this.estimates[t.ref] })));
  }
  judgeRules(request: RulesRequest): Promise<RuleVerdict[]> {
    this.record('judgeRules', request);
    return Promise.resolve(request.subjects.flatMap((s) => request.rules.flatMap((rule) => {
      const v = this.verdicts[`${s.target}:${rule}`] ?? 'met';
      return v === 'skip' ? [] : [{ target: s.target, rule, result: v, basis: `${this.name}: ${rule} 근거` }];
    })));
  }
  judgeSplit(request: SplitRulesRequest): Promise<SplitVerdict[]> {
    this.record('judgeSplit', request);
    return Promise.resolve(request.rules.flatMap((rule) => {
      const v = this.verdicts[`split:${rule}`] ?? 'met';
      return v === 'skip' ? [] : [{ rule, result: v, basis: `${this.name}: ${rule} 근거` }];
    }));
  }
}

export const grades = () => ({ dev: { modelId: 'claude-sonnet', effort: 'high', reason: '구현' }, qa: { modelId: 'gpt-5', effort: 'medium', reason: '검증' } });

export function addOp(ref: string) {
  return {
    op: 'add' as const, ref, preds: [],
    t: { title: `새 Task ${ref}`, type: 'Implementation' as const, domain: 'API' as const, wp: 'WP-01', priority: 1, assignee: 'Claude' as const, verifier: 'Codex' as const,
      purpose: '목적', doneCond: '테스트 통과', ac: [{ given: '주어진', when: '하면', then: '된다' }] },
  };
}

export function draftContent(): DraftContent {
  const task = (ref: string) => ({
    ref, wpRef: 'wp1', title: `Task ${ref}`, workType: 'Implementation' as const, primaryDomain: 'API' as const, relatedDomains: [], priority: 1,
    assigneeAgent: 'Claude' as const, verifierAgent: 'Codex' as const,
    estimate: { estHours: 1, loHours: 1, hiHours: 1, confidence: '하' as const, basis: '작성자 초안', agreedBy: ['Claude' as const] },
    overview: { purpose: '목적', background: '', scope: ['범위'], out: [], precond: '', doneCond: '테스트 통과' },
    ac: [{ given: '주어진', when: '하면', then: '된다', method: '자동 테스트' }],
    outputs: [], checklist: [{ content: '테스트 작성', required: true }],
    grades: grades(), subagents: { dev: [], qa: [], basis: '기본 Agent' }, splitBasis: '계약 먼저', conflictGroup: null, designItems: [],
  });
  return {
    phases: [{ ref: 'ph1', title: '설계' }],
    wps: [{ ref: 'wp1', phaseRef: 'ph1', title: '계약' }],
    tasks: [task('T1'), task('T2')],
    deps: [{ predRef: 'T1', succRef: 'T2', depType: 'FS' }],
  };
}

export function fakeWorkspace() {
  const calls: { method: string; args: unknown[] }[] = [];
  const fail: Partial<Record<keyof PlanningWorkspace, Error>> = {};
  const record = (method: keyof PlanningWorkspace, ...args: unknown[]) => {
    calls.push({ method, args });
    if (fail[method]) throw fail[method];
  };
  const workspace: PlanningWorkspace = {
    fixCommit: (commit) => { record('fixCommit', commit); return Promise.resolve({ note: `커밋 ${commit.slice(0, 7)} 고정` }); },
    checkoutInput: (name, commit) => { record('checkoutInput', name, commit); return Promise.resolve({ path: `/inputs/${name}`, note: 'prototype/ 읽기 전용' }); },
    prepareWork: (commit) => { record('prepareWork', commit); return Promise.resolve({ note: '작업 준비 완료' }); },
    diff: (from, to) => {
      record('diff', from, to);
      return Promise.resolve([{ status: 'M' as const, path: 'prototype/docs/a.md', oldBlob: 'd'.repeat(40), newBlob: 'e'.repeat(40), oldMode: '100644', newMode: '100644', added: 3, deleted: 1 }]);
    },
  };
  return { workspace, calls, fail, count: (m: string) => calls.filter((c) => c.method === m).length };
}

export async function tempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'awbs-planning-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

export async function context(home: string, api: ApiClient, extra: Partial<PlanningContext> = {}) {
  const claude = new FakeAgent('Claude');
  const codex = new FakeAgent('Codex');
  const ws = fakeWorkspace();
  const ctx: PlanningContext = {
    api, epoch: 3, runnerId: 'runner-1', checkpoints: await PlanningCheckpoints.open(home), workspace: ws.workspace,
    agents: { Claude: claude, Codex: codex }, now: () => Date.parse(NOW), sleep: () => Promise.resolve(), ...extra,
  };
  return { ctx, claude, codex, ws };
}

type Kind<K extends ClaimedJob['kind']> = Extract<ClaimedJob, { kind: K }>;
export function bootstrapJob(over: { id?: string; fence?: number; resumeStep?: string | null; runNo?: number; planningJobId?: string } = {}): Kind<'bootstrap'> {
  return {
    id: over.id ?? '11111111-1111-4111-8111-111111111111', leaseUntil: NOW, fence: over.fence ?? 1, kind: 'bootstrap',
    payload: { commit: SHA, instruction: '계약 먼저', resumeStep: over.resumeStep ?? null,
      planningJobId: over.planningJobId ?? '99999999-9999-4999-8999-999999999999', runNo: over.runNo ?? 1, version: 1, previousCommit: null,
      techConstraints: [], techDecisions: [], techDecisionVersion: 'f'.repeat(64), subagentDefs: [] },
  };
}
export function inputJob(over: { id?: string; fence?: number; resumeStep?: string | null } = {}): Kind<'input_diff'> {
  return {
    id: over.id ?? '22222222-2222-4222-8222-222222222222', leaseUntil: NOW, fence: over.fence ?? 1, kind: 'input_diff',
    payload: { commit: SHA, previousCommit: PREV, instruction: '', resumeStep: over.resumeStep ?? null,
      planningJobId: '88888888-8888-4888-8888-888888888888', runNo: 1, version: 2, wbs: wbsSnapshot() },
  };
}

/** 기존 Task 하나(TASK-0001, WP-01)가 있는 WBS 스냅샷(서버 후속 4 계약 6) */
export function wbsSnapshot() {
  return {
    phases: [{ id: 'PH-01', wps: [{ id: 'WP-01', tasks: ['TASK-0001'] }] }],
    tasks: [{ taskKey: 'TASK-0001', wp: 'WP-01', status: 'ready' as const, subjectHash: HASH, content: content() }],
    dependencies: [],
  };
}

export function content(title = '기존 Task') {
  return {
    title, scope: ['범위'], out: [], doneCond: '테스트 통과',
    spec: { req: [], work: [], steps: [], inputs: [], outputs: [], files: [], constraints: [], errors: [], docs: [], verify: [] },
    ac: [{ given: '주어진', when: '하면', then: '된다', method: '자동 테스트' }], outputs: [], designs: [], conflictGroup: null,
  };
}

/** progress 보고를 「단계:상태」 목록으로 */
export function progress(calls: Call[]): string[] {
  return calls.filter((c) => c.op === 'reportBootstrapProgress').map((c) => `${String(c.request.body?.stepKey)}:${String(c.request.body?.status)}`);
}
export function bodyOf(calls: Call[], op: OperationId, nth = 0): Record<string, unknown> {
  const found = calls.filter((c) => c.op === op)[nth];
  if (!found?.request.body) throw new Error(`${op} 호출이 없습니다.`);
  return found.request.body;
}
