import { AGENTS, agreedEstimateProblem } from './consensus.ts';

/*
 * 전송 직전 관문(wire gate) — Planning 보고가 서버로 나가기 전 마지막 검사.
 *
 * 규칙: **디스크의 어떤 값도 이 관문을 거치지 않고 서버로 가지 않는다**(3차 리뷰).
 * - `PlanningReporter.send()`가 첫 전송·재전송 모두 API 호출 바로 앞에서 부른다. API를 부르는 곳은 그 한 곳뿐이다.
 * - 진행 기록에 요청을 기록할 때(recordSent)와 읽을 때(load)도 같은 함수를 쓴다(checkpoint.ts sentProblem).
 * - 왜: 같은 추정이 「단계 결과(outputs)」와 「보낸 요청(sent)」 두 곳에 저장된다. 한쪽만 검사하면 다른 사본의 손상이 그대로 나간다.
 *
 * 검사하는 것(형식으로 구별할 수 있는 손상):
 * - 보고 종류별 필수 필드와 경로 인자
 * - 추정: 시간 범위·유한한 수·신뢰도·근거·합의 주체 Claude·Codex 둘(consensus.ts agreedEstimateProblem, 새 합의와 같은 함수)
 * - 판단 기록(judgedRules·splitJudgements·taskJudgements): 결론·근거·시각·출처와 합의 주체 둘. 저장된 대상 재판단은 subjectHash도
 * 정상 형식 안에서 값을 바꾼 변조까지 모두 찾지는 않는다. 그런 값의 일관성은 단계 결과와 대조해 따로 본다(예: 추정 본문 ↔ estimates:agreed).
 */

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const nonEmpty = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0;
const HASH = /^[0-9a-f]{64}$/;
const CONFIDENCE = ['하', '중', '상'];

/** 보고별 경로 인자와 본문 필수 필드 검사 */
const REPORTS: Record<string, { params: readonly string[]; body: (b: Rec) => string | null }> = {
  reportBootstrapProgress: { params: ['jobId'], body: (b) =>
    !isText(b.stepKey) ? 'stepKey가 없습니다' : !['wait', 'run', 'done', 'fail'].includes(String(b.status)) ? 'status가 올바르지 않습니다' : !isText(b.at) ? 'at이 없습니다' : null },
  submitTechProposals: { params: ['jobId'], body: (b) => (Array.isArray(b.decisions) ? null : 'decisions 목록이 없습니다') },
  submitDraft: { params: ['jobId'], body: (b) => {
    for (const name of ['phases', 'wps', 'tasks'] as const) if (!nonEmpty(b[name])) return `${name} 목록이 없습니다`;
    if (!Array.isArray(b.deps)) return 'deps 목록이 없습니다';
    for (const [i, task] of (b.tasks as unknown[]).entries()) {
      if (!isRecord(task) || !isText(task.ref)) return `tasks[${String(i)}].ref가 없습니다`;
      const problem = agreedEstimateProblem({ ...(isRecord(task.estimate) ? task.estimate : {}), ref: task.ref });
      if (problem) return `tasks[${String(i)}].estimate: ${problem}`;
      if (task.judgedRules !== undefined) {
        const judged = recordProblem(task.judgedRules, false);
        if (judged) return `tasks[${String(i)}].judgedRules: ${judged}`;
      }
    }
    return null;
  } },
  submitPlanningAnalysis: { params: ['id'], body: (b) =>
    !isText(b.jobId) ? 'jobId가 없습니다' : !AGENTS.includes(b.agent as never) ? 'agent가 올바르지 않습니다'
      : typeof b.summary !== 'string' ? 'summary가 없습니다' : !(Array.isArray(b.items) && b.items.every((s) => typeof s === 'string')) ? 'items 목록이 없습니다' : null },
  submitPlanningReviews: { params: ['id'], body: (b) => (!isText(b.jobId) ? 'jobId가 없습니다' : !nonEmpty(b.reviews) ? 'reviews 목록이 없습니다' : null) },
  submitPlanningProposal: { params: [], body: (b) =>
    !isText(b.jobId) ? 'jobId가 없습니다' : !isText(b.title) ? 'title이 없습니다' : !isText(b.reason) ? 'reason이 없습니다'
      : !(isRecord(b.source) && isText(b.source.kind)) ? 'source가 없습니다' : !nonEmpty(b.ops) ? 'ops 목록이 없습니다'
        : opsProblem(b.ops) ?? (b.taskJudgements === undefined ? null : taskJudgementsProblem(b.taskJudgements))
          ?? (b.splitJudgements === undefined ? null : recordProblem(b.splitJudgements, false)) },
  submitProposalJudgements: { params: ['id'], body: (b) => {
    if (!isText(b.jobId)) return 'jobId가 없습니다';
    if (!Array.isArray(b.judgements)) return 'judgements 목록이 없습니다';
    for (const [i, j] of b.judgements.entries()) {
      if (!isRecord(j) || !isText(j.target) || !isRecord(j.judgedRules)) return `judgements[${String(i)}] 형식이 다릅니다`;
      const problem = recordProblem(j.judgedRules, true);
      if (problem) return `judgements[${String(i)}]: ${problem}`;
    }
    return b.splitJudgements === undefined ? null : recordProblem(b.splitJudgements, true);
  } },
  submitTaskPlan: { params: ['taskKey'], body: (b) =>
    !isText(b.jobId) ? 'jobId가 없습니다' : !(isRecord(b.grades) && isRecord(b.grades.dev) && isRecord(b.grades.qa)) ? 'grades(dev·qa)가 없습니다'
      : !(isRecord(b.subagents) && Array.isArray(b.subagents.dev) && Array.isArray(b.subagents.qa)) ? 'subagents가 없습니다'
        : !('conflictGroup' in b) || !(b.conflictGroup === null || isRecord(b.conflictGroup)) ? 'conflictGroup이 없습니다'
          // 기존 Task 재판단의 subjectHash는 변경 후 내용의 지문이다(여기서는 형식만 보고, 값은 bind와 서버가 대조한다).
          : b.judgedRules === undefined ? null : recordProblem(b.judgedRules, true) },
  submitEstimates: { params: [], body: (b) => {
    if (!isText(b.jobId)) return 'jobId가 없습니다';
    if (!nonEmpty(b.items)) return 'items 목록이 없습니다';
    for (const [i, item] of b.items.entries()) {
      if (!isRecord(item) || !isText(item.taskKey)) return `items[${String(i)}].taskKey가 없습니다`;
      const problem = agreedEstimateProblem({ ...item, ref: item.taskKey });
      if (problem) return `items[${String(i)}]: ${problem}`;
    }
    return null;
  } },
};

export const PLANNING_REPORT_KINDS = Object.keys(REPORTS);

/** 내용이 바뀌는 기존 Task의 판단(서버 후속 4로 input_diff·split에서 보냄). taskKey 중복 금지, hash는 서버가 붙인다. */
function taskJudgementsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'taskJudgements가 목록이 아닙니다';
  const seen = new Set<string>();
  for (const [i, entry] of value.entries()) {
    if (!isRecord(entry) || !isText(entry.taskKey) || !/^TASK-[0-9]{4,}$/.test(entry.taskKey)) return `taskJudgements[${String(i)}].taskKey가 올바르지 않습니다`;
    if (seen.has(entry.taskKey)) return `taskJudgements의 ${entry.taskKey}가 두 번 있습니다`;
    seen.add(entry.taskKey);
    const problem = recordProblem(entry.judgedRules, false);
    if (problem) return `taskJudgements[${String(i)}]: ${problem}`;
  }
  return null;
}

/** 판단 기록 하나(D-33·D-34). 합의 주체는 Claude·Codex 둘이어야 한다. */
function recordProblem(record: unknown, needsHash: boolean): string | null {
  if (!isRecord(record) || record.schemaVersion !== 1 || !Array.isArray(record.items)) return '판단 기록 형식이 다릅니다';
  for (const [i, item] of record.items.entries()) {
    if (!isRecord(item) || !isText(item.rule) || !['met', 'not_met'].includes(String(item.result)) || !isText(item.basis) || !isText(item.judgedAt) || !isText(item.sourceRef)) {
      return `판단 items[${String(i)}] 형식이 다릅니다`;
    }
    // 합의 주체는 판단 기록마다 필수이고 Claude·Codex 둘이어야 한다(D-33, 4차 리뷰 P3: 속성이 없어도 잡는다).
    const agreedBy = item.agreedBy;
    if (!(Array.isArray(agreedBy) && agreedBy.length === AGENTS.length && AGENTS.every((a) => agreedBy.includes(a)))) return `판단 items[${String(i)}]: 합의 주체가 Claude·Codex 둘이 아닙니다`;
    if (needsHash && !(typeof item.subjectHash === 'string' && HASH.test(item.subjectHash))) return `판단 items[${String(i)}]의 subjectHash가 없습니다`;
  }
  return null;
}

/**
 * CP 변경 목록의 계약 필드 검사: 새 Task(add)의 신뢰도(`t.conf`)와 판단 기록(`t.judgedRules`)만 본다.
 * 설계(`t.design[].content`)처럼 계약상 자유 JSON인 곳은 해석하지 않는다(4차 리뷰 P2).
 * 예: 제품 DB 설계 예제의 `{"confidence": 0.91}`은 Planning 추정의 신뢰도가 아니다.
 */
function opsProblem(ops: unknown[]): string | null {
  for (const [i, op] of ops.entries()) {
    if (!isRecord(op) || op.op !== 'add' || !isRecord(op.t)) continue;
    if (op.t.conf !== undefined && !CONFIDENCE.includes(op.t.conf as string)) return `ops[${String(i)}].t.conf: 신뢰도가 하·중·상이 아닙니다`;
    if (op.t.judgedRules !== undefined) {
      const problem = recordProblem(op.t.judgedRules, false);
      if (problem) return `ops[${String(i)}].t.judgedRules: ${problem}`;
    }
  }
  return null;
}

/** 서버로 보낼 요청 하나의 검사. 문제가 없으면 null, 있으면 이유. */
export function wireProblem(operation: string, request: unknown): string | null {
  const report = REPORTS[operation];
  if (!report) return `Planning이 보내지 않는 보고입니다: ${operation}`;
  if (!isRecord(request)) return '요청이 객체가 아닙니다';
  const { params, body } = request;
  if (params !== undefined && !isRecord(params)) return '경로 인자가 객체가 아닙니다';
  if (report.params.length && !(isRecord(params) && report.params.every((name) => isText(params[name])))) return `경로 인자(${report.params.join(',')})가 없습니다`;
  if (!isRecord(body) || typeof body.fence !== 'number') return '본문(fence 포함)이 없습니다';
  // 보고별 검사는 계약이 정한 필드(추정·판단 기록·신뢰도)만 본다. 본문 전체를 이름으로 훑지 않는다(4차 리뷰 P2).
  return report.body(body);
}
