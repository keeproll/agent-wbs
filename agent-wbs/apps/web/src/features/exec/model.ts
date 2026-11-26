/**
 * 작업 실행 화면(UI-06)의 순수 계산 — 화면 그리기와 분리해 단위 시험한다.
 *
 * 원본의 계산(P Sel.flow L4348, flowSteps L5942, exVM L6019, capReason L6097)을 옮기되,
 * 값은 서버가 보고한 것(시도·검증·Runner 상태·알림)만 쓴다.
 * owner Q-04(contracts §3.5): 팀장은 첫 개발 시작만 누르고, 그 뒤 QA·재작업·재검증은 서버가 자동으로 만든다.
 * 그래서 원본의 「결과 등록 (Mock Runner 보고)」 같은 흉내 버튼은 없다(G§9.7-3).
 */
import type { ResponseOf } from '../../shared/api/contract.ts';
import { formatDateTime } from '../../shared/format.ts';

export type ExecAttempt = ResponseOf<'getTaskAttempts'>['items'][number];
export type ExecVerification = ResponseOf<'getTaskVerifications'>['items'][number];
export type ExecMessage = ResponseOf<'getTaskMessages'>['items'][number];
export type Stage = 'dev' | 'qa' | 'rework' | 'reverify' | 'gate' | 'done';
export type RunKind = 'dev' | 'qa' | 'rework' | 'reverify';

/** 화면에 필요한 Task 필드만(목록·상세 어느 쪽 응답이든 된다) */
export interface FlowTask {
  lifecycleStatus: string | number;
  assigneeAgent: string | number | null;
  verifierAgent: string | number | null;
  blocked: boolean;
}

export const KIND_LABEL: Record<string, string> = { dev: '개발', qa: 'QA', rework: '재작업', reverify: '재검증' };
export const STAGE_LABEL: Record<Stage, string> = { dev: '개발', qa: 'QA', rework: '재작업', reverify: '재검증', gate: 'Gate', done: '완료' };
/** 시도 상태 → 원본 LBL.att(L2930)의 문구·색 */
export const ATTEMPT_STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: '실행 중', cls: 's-run' },
  completed: { label: '완료', cls: 's-done' },
  failed: { label: '실패', cls: 's-fail' },
  interrupted: { label: '중단', cls: 's-rework' },
};
/** Task 상태 → 원본 LBL.status(L2912) */
export const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  planning: { label: '계획 중', cls: 's-plan' },
  approval: { label: '승인 대기', cls: 's-appr' },
  ready: { label: '실행 대기', cls: 's-ready' },
  running: { label: '실행 중', cls: 's-run' },
  qa: { label: 'QA 진행', cls: 's-qa' },
  rework: { label: '재작업 필요', cls: 's-rework' },
  verifying: { label: '검증 진행', cls: 's-verif' },
  gate: { label: 'Gate 대기', cls: 's-verif' },
  paused: { label: '중단 · 재개 대기', cls: 's-rework' },
  done: { label: '완료', cls: 's-done' },
  failed: { label: '실패', cls: 's-fail' },
  cancelled: { label: '취소됨', cls: 's-plan' },
};
export const statusOf = (status: string | number) => TASK_STATUS[String(status)] ?? { label: String(status), cls: 's-plan' };
/** 검증 결과 → 원본 VC(L4369) */
export const VERDICT_CLASS: Record<string, string> = { PASS: 'v-pass', FAIL: 'v-fail', BLOCKED: 'v-blk' };
/** Gate 조건 key → 원본 Sel.gate(L3689) 이름 */
export const GATE_LABEL: Record<string, string> = {
  checklist: '필수 Checklist 완료',
  outputs: '필수 산출물 존재',
  verification: '필요한 Verification 통과',
  defects: '미해결 차단 결함 없음',
  approval: '필요한 승인 완료',
};

/** 작업 실행 목록에 보이는 Task 상태(P exVM L6022). 완료는 시도 기록을 보기 위해 넣는다. */
export const EXEC_STATUSES = ['ready', 'running', 'paused', 'qa', 'rework', 'verifying', 'gate', 'failed', 'done'];

export const sortAttempts = (attempts: readonly ExecAttempt[]): ExecAttempt[] =>
  [...attempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptKey.localeCompare(b.attemptKey, undefined, { numeric: true }));

/**
 * 검증을 시각(at) 순으로 정렬한다. 같은 시각이면 id 순.
 * 왜: 서버 목록은 id(UUID) 순서라 시간 순서가 아니다(M3-06 리뷰 #7). 최신 FAIL을 잘못 고르면 지시가 옛 시도에 연결된다.
 */
export const sortVerifications = (verifications: readonly ExecVerification[]): ExecVerification[] =>
  [...verifications].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

export interface Flow {
  stage: Stage;
  running: ExecAttempt | null;
  last: ExecAttempt | null;
  lastV: ExecVerification | null;
  paused: boolean;
  hadRework: boolean;
  firstFail: boolean;
}

const verdictOf = (verifications: readonly ExecVerification[], attempt: ExecAttempt) =>
  sortVerifications(verifications.filter((v) => v.attemptId === attempt.id)).at(-1) ?? null;

/** 현재 단계(P Sel.flow L4348). 시도는 시작 시각 순으로 본다. */
export function flowOf(task: FlowTask, attemptsIn: readonly ExecAttempt[], verificationsIn: readonly ExecVerification[]): Flow {
  const attempts = sortAttempts(attemptsIn);
  const verifications = sortVerifications(verificationsIn);
  const running = attempts.filter((a) => a.status === 'running').at(-1) ?? null;
  const last = attempts.at(-1) ?? null;
  const kind = (a: ExecAttempt) => String(a.kind) as RunKind;
  let stage: Stage;
  if (task.lifecycleStatus === 'done') stage = 'done';
  else if (running) stage = kind(running);
  else if (!last) stage = 'dev';
  else if (last.status === 'interrupted' || last.status === 'failed') stage = kind(last);
  else if (last.kind === 'dev') stage = 'qa';
  else if (last.kind === 'rework') stage = 'reverify';
  else {
    const v = verdictOf(verifications, last);
    stage = !v || v.result === 'BLOCKED' ? kind(last) : v.result === 'PASS' ? 'gate' : 'rework';
  }
  return {
    stage, running, last, lastV: verifications.at(-1) ?? null,
    paused: !running && last?.status === 'interrupted' && task.lifecycleStatus !== 'done',
    hadRework: attempts.some((a) => a.kind === 'rework'),
    firstFail: verifications[0]?.result === 'FAIL',
  };
}

export interface FlowStep { n: number; label: string; cls: '' | 'cur' | 'done' | 'skip' | 'fail' }

/** 개발 → QA → 재작업 → 재검증 → Gate → 완료 6단계(P flowSteps L5942) */
export function flowSteps(task: Pick<FlowTask, 'assigneeAgent' | 'verifierAgent'>, flow: Flow): FlowStep[] {
  const dev = String(task.assigneeAgent ?? '개발 Agent');
  const qa = String(task.verifierAgent ?? '검증 Agent');
  const order: [Stage, string][] = [
    ['dev', `${dev} 개발`], ['qa', `${qa} QA`], ['rework', `${dev} 재작업`], ['reverify', `${qa} 재검증`], ['gate', 'Completion Gate'], ['done', 'Task 완료'],
  ];
  const idx = order.findIndex(([k]) => k === flow.stage);
  return order.map(([k, label], i) => {
    let cls: FlowStep['cls'] = '';
    if (i === idx) cls = k === 'done' ? 'done' : 'cur';
    else if (i < idx) cls = (k === 'rework' || k === 'reverify') && !flow.hadRework ? 'skip' : k === 'qa' && flow.firstFail ? 'fail' : 'done';
    return { n: i + 1, label, cls };
  });
}

export interface Counters { reworks: number; failKind: RunKind | null; consecutiveFails: number }

/**
 * 자동 진행 카운터(contracts §3.5)를 서버 기록으로 다시 센다.
 * - 재작업: QA·재검증 FAIL 수(Task당 자동 3회). 통합 실패 재작업은 M7 기록이라 여기엔 없다.
 * - 실행 실패: 마지막 종류의 연속 실패 수. 중단은 세지도 끊지도 않는다.
 * 계약에 카운터 필드가 없어 화면이 센다(보고서 M3-06 「계약 공백」).
 */
export function attemptCounters(attemptsIn: readonly ExecAttempt[], verifications: readonly ExecVerification[]): Counters {
  const attempts = sortAttempts(attemptsIn).filter((a) => a.status !== 'interrupted');
  const reworks = verifications.filter((v) => v.result === 'FAIL').length;
  const last = attempts.at(-1);
  if (last?.status !== 'failed') return { reworks, failKind: null, consecutiveFails: 0 };
  let n = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (!a || a.kind !== last.kind || a.status !== 'failed') break;
    n++;
  }
  return { reworks, failKind: String(last.kind) as RunKind, consecutiveFails: n };
}

/** runner-state 중 사유 판정에 쓰는 부분(계약 RunnerState의 부분 모양) */
export interface RunnerSlice {
  connection: { online: boolean };
  readiness: { items: readonly { key: string | number; status: string | number; detail: string; fix: string | null }[] } | null;
  usage: readonly { agent: string | number; remainPct: number; resetAt: string | null }[];
  sessions: readonly { taskKey: string; state: string | number }[];
  unconfirmedHolds: readonly { taskKey: string | null }[];
  concurrency: {
    limit: number | null;
    used: { total: number } & Record<string, number>;
    conflictWaits: readonly { taskKey: string; conflictGroup: string; by: string }[];
  };
}

/** 실행할 수 없는 이유(P capReason L6097). 보고된 값만 보고 첫 사유 하나를 돌려준다. 없으면 ''. */
export function runnerReason(runner: RunnerSlice, agent: string, taskKey: string): string {
  if (!runner.connection.online) return 'Runner 연결 끊김 — 재연결 후 실행합니다.';
  const ready = runner.readiness?.items.find((x) => x.key === agent.toLowerCase());
  if (ready?.status === 'fail') return `${agent} 실행 준비 안 됨 — ${ready.detail}.${ready.fix ? ` ${ready.fix}` : ''}`;
  const usage = runner.usage.find((u) => u.agent === agent);
  if (usage && usage.remainPct <= 0) return `${agent} 사용량 한도 — ${usage.resetAt ? formatDateTime(usage.resetAt) : '리셋 시각 미보고'} 리셋 후 실행합니다.`;
  if (runner.unconfirmedHolds.some((h) => h.taskKey === taskKey)) {
    return 'Runner 연결이 끊겨 이전 실행의 프로세스 종료를 확인하지 못했습니다 — 종료가 확인될 때까지 새 실행 · 재개를 보류합니다.';
  }
  const unconf = runner.sessions.filter((s) => s.state === 'unconfirmed');
  if (unconf.length > 0) {
    return `하위 Agent 관측 미확인 세션 ${unconf.map((s) => s.taskKey).join(', ')} — 출력이 끊겨 실제 수를 알 수 없어 보유로 계산 중입니다. 새 실행은 관측이 복구되거나 프로세스 그룹 종료가 확인될 때까지 보류합니다.`;
  }
  const { limit, used, conflictWaits } = runner.concurrency;
  if (limit !== null && used.total >= limit) return `동시 실행 한도 ${String(limit)}개(하위 Agent 포함) 모두 사용 중 — 자리가 나면 실행합니다.`;
  const wait = conflictWaits.find((w) => w.taskKey === taskKey);
  if (wait) return `충돌 묶음 「${wait.conflictGroup}」을(를) ${wait.by}가 실행 중 — 같은 모듈을 동시에 수정하지 않도록 끝난 뒤 실행합니다.`;
  return '';
}

export type NextAction =
  | { op: 'run'; kind: RunKind; label: string }
  | { op: 'stop'; attempt: ExecAttempt; label: string }
  | { op: 'resume'; attempt: ExecAttempt; label: string }
  | { op: 'rework'; label: string };

export interface NextStep { text: string; action: NextAction | null; reason: string; disabled: boolean }

export interface NextInput {
  task: FlowTask;
  flow: Flow;
  attempts: readonly ExecAttempt[];
  verifications: readonly ExecVerification[];
  /** 이 Task의 열린 알림(GET /api/alerts) */
  alerts: readonly { key: string }[];
  /** runnerReason 결과 */
  reason: string;
  /** 자동 재시도 총 횟수·자동 재작업 횟수(설정 exec-policy, 기본 3·3) */
  limits: { retry: number; rework: number };
}

const OFFLINE = 'Runner 연결 끊김';

/** 다음 작업 문구·버튼(P exVM L6029-6041을 자동 진행 규칙에 맞춤) */
export function nextStep({ task, flow, attempts, verifications, alerts, reason, limits }: NextInput): NextStep {
  const dev = String(task.assigneeAgent ?? '개발 Agent');
  const qa = String(task.verifierAgent ?? '검증 Agent');
  const agentFor = (kind: string) => (kind === 'dev' || kind === 'rework' ? dev : qa);
  const offline = reason.startsWith(OFFLINE);
  const out = (text: string, action: NextAction | null = null, why = '', blocked = false): NextStep =>
    ({ text, action, reason: action ? why : '', disabled: action !== null && (blocked || offline) });
  const { stage, running, last } = flow;

  if (stage === 'done') return out('완료된 Task입니다. 실행 · 검증 기록은 아래에서 확인합니다.');
  if (running) {
    return out(`${running.attemptKey} ${KIND_LABEL[running.kind] ?? ''} 실행 중 — Runner 결과 보고를 기다립니다.`, { op: 'stop', attempt: running, label: '실행 중단' });
  }
  if (flow.paused && last) {
    const kind = KIND_LABEL[last.kind] ?? '';
    return out(`${last.attemptKey} ${kind} 중단 — ${last.failure ?? '실행이 끊겼습니다'}. 같은 작업을 새 실행 시도로 이어서 진행합니다 (기존 시도 기록 보존).`,
      { op: 'resume', attempt: last, label: `${agentFor(String(last.kind))} ${kind} 재개 요청` }, reason);
  }
  if (last?.status === 'failed') {
    const kind = KIND_LABEL[last.kind] ?? '';
    const head = `${last.attemptKey} ${kind} 실패 — ${last.failure ?? '원인 미보고'}.`;
    if (task.lifecycleStatus === 'failed' || alerts.some((a) => a.key === `retry:${last.id}`)) {
      return out(`${head} 자동 재시도 한도(총 ${String(limits.retry)}회)를 넘었습니다. 원인을 확인한 뒤 한 번 더 요청할 수 있습니다.`,
        { op: 'run', kind: String(last.kind) as RunKind, label: `${kind} 재실행 요청` }, reason);
    }
    const c = attemptCounters(attempts, verifications);
    return out(`${head} 서버가 자동으로 다시 시도합니다 (연속 실패 ${String(c.consecutiveFails)}/${String(limits.retry)}회).`);
  }
  if (stage === 'dev') {
    const status = String(task.lifecycleStatus);
    let why = reason;
    if (task.blocked) why = '선행 Task 차단 — 선행 조건이 충족되어야 실행할 수 있습니다.';
    else if (['planning', 'approval', 'cancelled'].includes(status)) why = `${statusOf(status).label} 상태 — 승인 · 실행 대기 상태가 되어야 실행할 수 있습니다.`;
    const hard = why !== reason;
    return out(`${dev} 개발 실행을 Runner에 요청합니다. 첫 실행은 팀장이 시작하고, 이후 QA · 재작업 · 재검증은 서버가 자동으로 이어 갑니다.`,
      { op: 'run', kind: 'dev', label: `${dev} 개발 실행 요청` }, why, hard);
  }
  if (stage === 'qa' || stage === 'reverify') {
    const label = stage === 'qa' ? 'QA' : '재검증';
    const v = last ? verdictOf(verifications, last) : null;
    if (v?.result === 'BLOCKED') {
      return out(`${v.id} BLOCKED — 차단 원인을 해결한 뒤 ${qa} ${label}를 요청합니다. BLOCKED는 자동으로 반복하지 않습니다.`,
        { op: 'run', kind: stage, label: `${qa} ${label} 요청` }, reason);
    }
    return out(`${stage === 'qa' ? '개발' : '재작업'} 완료 — 서버가 ${qa} ${label}를 자동으로 요청합니다. Runner 실행을 기다립니다.`);
  }
  if (stage === 'rework') {
    const c = attemptCounters(attempts, verifications);
    const fail = flow.lastV ? `${flow.lastV.id} FAIL — ` : '';
    if (alerts.some((a) => a.key.startsWith('rework-limit:'))) {
      return out(`${fail}자동 재작업 한도(${String(limits.rework)}회)를 넘었습니다. 실패 항목을 ${dev}에게 지시하고 재작업을 1회 실행할 수 있습니다. 기존 검증 결과는 그대로 보존됩니다.`,
        { op: 'rework', label: '재작업 지시 작성' }, reason);
    }
    return out(`${fail}서버가 실패 항목을 ${dev}에게 전달하고 재작업을 새 시도로 자동 실행합니다 (자동 재작업 ${String(c.reworks)}/${String(limits.rework)}회). 기존 검증 결과는 그대로 보존됩니다.`);
  }
  return out('Verification PASS — Completion Gate 조건을 확인합니다. 조건이 모두 충족되면 서버가 통합 확인 · 병합 뒤 자동으로 완료합니다.');
}

/** 시도 선택: 주소의 attemptKey(안정 키)가 이 Task에 있으면 그것, 아니면 실행 중 또는 마지막 시도. */
export function pickAttempt(attempts: readonly ExecAttempt[], key: string | null): { attempt: ExecAttempt | null; explicit: boolean; missing: string | null } {
  // 시도 키(attemptKey) 또는 시도 id로 찾는다. 대시보드·검증 화면은 id로 링크한다(공통 주소 shared/links.ts).
  const chosen = key ? attempts.find((a) => a.attemptKey === key || a.id === key) : undefined;
  if (chosen) return { attempt: chosen, explicit: true, missing: null };
  const sorted = sortAttempts(attempts);
  // 없는 시도 키는 고르지 않고, 그 사실을 화면이 알릴 수 있게 돌려준다(M3-06 리뷰 #4).
  return { attempt: sorted.filter((a) => a.status === 'running').at(-1) ?? sorted.at(-1) ?? null, explicit: false, missing: key };
}

const DELIVERY: Record<string, [string, string]> = {
  Draft: ['작성 중', 'd-c'], Queued: ['전달 대기', 'd-q'], Sent: ['전달 완료', 'd-s'],
  Acknowledged: ['수신 확인', 'd-a'], Failed: ['전달 실패', 'd-f'], Cancelled: ['전송 취소', 'd-c'],
};

/** 전달 상태 칩(P LBL.dlv L2931). 받은 응답은 전달 상태가 아니라 「Runner 응답」이다. */
export function deliveryView(m: { dir: string | number; delivery: string | number | null }): { label: string; cls: string } {
  if (m.dir === 'in' || m.delivery === null) return { label: 'Runner 응답', cls: 'd-r' };
  const [ko, cls] = DELIVERY[String(m.delivery)] ?? [String(m.delivery), 'd-c'];
  return { label: `${String(m.delivery)} · ${ko}`, cls };
}

export const agentClass = (agent: string) => (agent === 'Claude' ? 'ag-claude' : 'ag-codex');
export const agentInitial = (agent: string) => (agent === 'Claude' ? 'Cl' : 'Cx');
