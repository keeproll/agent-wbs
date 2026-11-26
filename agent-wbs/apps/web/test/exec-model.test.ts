import { describe, expect, it } from 'vitest';
import {
  attemptCounters, deliveryView, flowOf, flowSteps, nextStep, pickAttempt, runnerReason, sortAttempts, type ExecAttempt, type ExecVerification,
} from '../src/features/exec/model.ts';

const at = (key: string, kind: ExecAttempt['kind'], status: ExecAttempt['status'], startedAt: string, extra: Partial<ExecAttempt> = {}): ExecAttempt => ({
  id: `id-${key}`, attemptKey: key, taskKey: 'TASK-0007', kind, agent: kind === 'qa' || kind === 'reverify' ? 'Codex' : 'Claude', status,
  startedAt, endedAt: status === 'running' ? null : startedAt, modelId: 'opus', effort: 'high', gradeAdjust: null, summary: null, failure: null,
  tokens: null, resumedFrom: null, baseSha: null, headSha: null, changedFiles: [], updatedAt: startedAt, ...extra,
});
const vf = (attempt: ExecAttempt, result: ExecVerification['result']): ExecVerification => ({
  id: `v-${attempt.attemptKey}`, taskKey: attempt.taskKey, attemptId: attempt.id, result, headSha: 'a'.repeat(40), specRevision: 1, cmd: 'pnpm test',
  expected: '', actual: '', defects: [], invalidated: false, at: attempt.startedAt,
});
const T = { lifecycleStatus: 'ready', assigneeAgent: 'Claude', verifierAgent: 'Codex', blocked: false } as const;

describe('실행 단계 판정(P Sel.flow L4348 → 제품 데이터)', () => {
  it('시도가 없으면 개발 단계', () => {
    expect(flowOf(T, [], []).stage).toBe('dev');
  });
  it('실행 중 시도가 있으면 그 시도의 종류가 단계', () => {
    const f = flowOf({ ...T, lifecycleStatus: 'qa' }, [at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z'), at('A-2', 'qa', 'running', '2026-11-01T01:00:00Z')], []);
    expect(f.stage).toBe('qa');
    expect(f.running?.attemptKey).toBe('A-2');
  });
  it('개발 완료 뒤 검증 전이면 QA, QA FAIL이면 재작업, 재작업 완료면 재검증, PASS면 Gate', () => {
    const dev = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    const qa = at('A-2', 'qa', 'completed', '2026-11-01T01:00:00Z');
    const rw = at('A-3', 'rework', 'completed', '2026-11-01T02:00:00Z');
    const rv = at('A-4', 'reverify', 'completed', '2026-11-01T03:00:00Z');
    expect(flowOf(T, [dev], []).stage).toBe('qa');
    expect(flowOf(T, [dev, qa], [vf(qa, 'FAIL')]).stage).toBe('rework');
    expect(flowOf(T, [dev, qa], [vf(qa, 'BLOCKED')]).stage).toBe('qa');
    expect(flowOf(T, [dev, qa, rw], [vf(qa, 'FAIL')]).stage).toBe('reverify');
    const f = flowOf(T, [dev, qa, rw, rv], [vf(qa, 'FAIL'), vf(rv, 'PASS')]);
    expect(f.stage).toBe('gate');
    expect(f.hadRework).toBe(true);
    expect(f.firstFail).toBe(true);
  });
  it('마지막 시도가 중단이면 그 종류 단계의 재개 대기(paused)', () => {
    const f = flowOf({ ...T, lifecycleStatus: 'paused' }, [at('A-1', 'dev', 'interrupted', '2026-11-01T00:00:00Z')], []);
    expect(f).toMatchObject({ stage: 'dev', paused: true });
  });
  it('Task가 완료면 완료 단계', () => {
    expect(flowOf({ ...T, lifecycleStatus: 'done' }, [at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z')], []).stage).toBe('done');
  });
  it('시도는 시작 시각 순으로 정렬한다(서버 순서에 기대지 않음)', () => {
    const a = at('A-2', 'qa', 'completed', '2026-11-01T01:00:00Z');
    const b = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    expect(sortAttempts([a, b]).map((x) => x.attemptKey)).toEqual(['A-1', 'A-2']);
  });
});

describe('6단계 표시(P flowSteps L5942)', () => {
  it('현재 단계는 cur, 지난 단계는 done, 재작업이 없었으면 재작업·재검증은 skip', () => {
    const dev = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    const qa = at('A-2', 'qa', 'completed', '2026-11-01T01:00:00Z');
    const steps = flowSteps(T, flowOf(T, [dev, qa], [vf(qa, 'PASS')]));
    expect(steps.map((s) => s.label)).toEqual(['Claude 개발', 'Codex QA', 'Claude 재작업', 'Codex 재검증', 'Completion Gate', 'Task 완료']);
    expect(steps.map((s) => s.cls)).toEqual(['done', 'done', 'skip', 'skip', 'cur', '']);
  });
  it('첫 QA가 FAIL이면 QA 칸은 fail', () => {
    const dev = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    const qa = at('A-2', 'qa', 'completed', '2026-11-01T01:00:00Z');
    expect(flowSteps(T, flowOf(T, [dev, qa], [vf(qa, 'FAIL')])).map((s) => s.cls)).toEqual(['done', 'fail', 'cur', '', '', '']);
  });
  it('완료 단계는 마지막 칸이 done', () => {
    const f = flowOf({ ...T, lifecycleStatus: 'done' }, [], []);
    expect(flowSteps(T, f).at(-1)?.cls).toBe('done');
  });
});

describe('자동 진행 카운터(contracts §3.5)', () => {
  it('재작업 횟수는 QA·재검증 FAIL 수, 실행 실패는 같은 종류의 연속 실패만 센다(중단은 건너뜀)', () => {
    const dev1 = at('A-1', 'dev', 'failed', '2026-11-01T00:00:00Z');
    const dev2 = at('A-2', 'dev', 'interrupted', '2026-11-01T00:10:00Z');
    const dev3 = at('A-3', 'dev', 'failed', '2026-11-01T00:20:00Z');
    expect(attemptCounters([dev1, dev2, dev3], [])).toEqual({ reworks: 0, failKind: 'dev', consecutiveFails: 2 });
    const ok = at('A-4', 'dev', 'completed', '2026-11-01T00:30:00Z');
    const qa = at('A-5', 'qa', 'completed', '2026-11-01T01:00:00Z');
    expect(attemptCounters([dev1, dev3, ok, qa], [vf(qa, 'FAIL')])).toEqual({ reworks: 1, failKind: null, consecutiveFails: 0 });
  });
  it('무효가 된 검증 FAIL도 재작업 1회로 센다(이미 재작업을 했으므로)', () => {
    const qa = at('A-5', 'qa', 'completed', '2026-11-01T01:00:00Z');
    expect(attemptCounters([qa], [{ ...vf(qa, 'FAIL'), invalidated: true }]).reworks).toBe(1);
  });
});

type Runner = Parameters<typeof runnerReason>[0];
const runner = (patch: Partial<Runner> = {}): Runner => ({
  connection: { online: true }, readiness: null, usage: [], sessions: [], unconfirmedHolds: [],
  concurrency: { limit: 4, used: { total: 1, Claude: 1, Codex: 0 }, conflictWaits: [] }, ...patch,
});

describe('실행할 수 없는 이유(P capReason L6097, 보고값 기반)', () => {
  it('정상이면 빈 문자열', () => {
    expect(runnerReason(runner(), 'Claude', 'TASK-0006')).toBe('');
  });
  it('Runner 끊김이 가장 먼저', () => {
    expect(runnerReason(runner({ connection: { online: false } }), 'Claude', 'TASK-0006')).toBe('Runner 연결 끊김 — 재연결 후 실행합니다.');
  });
  it('Agent 준비 실패', () => {
    const r = runner({ readiness: { items: [{ key: 'codex', status: 'fail', detail: 'codex 로그인 필요', fix: 'codex login 실행' }] } });
    expect(runnerReason(r, 'Codex', 'T')).toBe('Codex 실행 준비 안 됨 — codex 로그인 필요. codex login 실행');
    expect(runnerReason(r, 'Claude', 'T')).toBe('');
  });
  it('사용량 0%', () => {
    expect(runnerReason(runner({ usage: [{ agent: 'Claude', remainPct: 0, resetAt: '2026-11-05T12:00:00.000Z' }] }), 'Claude', 'T'))
      .toBe('Claude 사용량 한도 — 2026-11-05 21:00 리셋 후 실행합니다.');
  });
  it('이 Task의 보유가 미확인이면 종료 확인 전까지 보류', () => {
    expect(runnerReason(runner({ unconfirmedHolds: [{ taskKey: 'T' }] }), 'Claude', 'T'))
      .toBe('Runner 연결이 끊겨 이전 실행의 프로세스 종료를 확인하지 못했습니다 — 종료가 확인될 때까지 새 실행 · 재개를 보류합니다.');
  });
  it('관측 미확인 세션', () => {
    expect(runnerReason(runner({ sessions: [{ taskKey: 'TASK-0004', state: 'unconfirmed' }] }), 'Claude', 'T'))
      .toContain('하위 Agent 관측 미확인 세션 TASK-0004');
  });
  it('동시 실행 한도', () => {
    expect(runnerReason(runner({ concurrency: { limit: 2, used: { total: 2, Claude: 1, Codex: 1 }, conflictWaits: [] } }), 'Claude', 'T'))
      .toBe('동시 실행 한도 2개(하위 Agent 포함) 모두 사용 중 — 자리가 나면 실행합니다.');
  });
  it('충돌 묶음 대기', () => {
    expect(runnerReason(runner({ concurrency: { limit: 4, used: { total: 1, Claude: 1, Codex: 0 }, conflictWaits: [{ taskKey: 'T', conflictGroup: 'wbs-ui', by: 'TASK-0005' }] } }), 'Claude', 'T'))
      .toBe('충돌 묶음 「wbs-ui」을(를) TASK-0005가 실행 중 — 같은 모듈을 동시에 수정하지 않도록 끝난 뒤 실행합니다.');
  });
});

describe('다음 작업(P exVM L6033 → owner Q-04 자동 진행)', () => {
  const base = { task: T, alerts: [], reason: '', limits: { retry: 3, rework: 3 } };
  it('시도가 없고 ready면 팀장 첫 시작 버튼', () => {
    const n = nextStep({ ...base, flow: flowOf(T, [], []), attempts: [], verifications: [] });
    expect(n.text).toContain('Claude 개발 실행을 Runner에 요청합니다');
    expect(n.action).toEqual({ op: 'run', kind: 'dev', label: 'Claude 개발 실행 요청' });
    expect(n.disabled).toBe(false);
  });
  it('선행 차단이면 버튼을 막고 사유', () => {
    const task = { ...T, blocked: true };
    const n = nextStep({ ...base, task, flow: flowOf(task, [], []), attempts: [], verifications: [] });
    expect(n.disabled).toBe(true);
    expect(n.reason).toBe('선행 Task 차단 — 선행 조건이 충족되어야 실행할 수 있습니다.');
  });
  it('계획 중이면 버튼을 막고 상태 사유', () => {
    const task = { ...T, lifecycleStatus: 'planning' } as const;
    const n = nextStep({ ...base, task, flow: flowOf(task, [], []), attempts: [], verifications: [] });
    expect(n.reason).toBe('계획 중 상태 — 승인 · 실행 대기 상태가 되어야 실행할 수 있습니다.');
  });
  it('Runner 끊김이면 버튼을 막는다', () => {
    const n = nextStep({ ...base, reason: 'Runner 연결 끊김 — 재연결 후 실행합니다.', flow: flowOf(T, [], []), attempts: [], verifications: [] });
    expect(n.disabled).toBe(true);
  });
  it('실행 중이면 결과 보고 대기와 중단 버튼', () => {
    const a = at('ATT-0005-1', 'dev', 'running', '2026-11-03T10:58:00Z');
    const task = { ...T, lifecycleStatus: 'running' } as const;
    const n = nextStep({ ...base, task, flow: flowOf(task, [a], []), attempts: [a], verifications: [] });
    expect(n.text).toBe('ATT-0005-1 개발 실행 중 — Runner 결과 보고를 기다립니다.');
    expect(n.action).toEqual({ op: 'stop', attempt: a, label: '실행 중단' });
  });
  it('중단(paused)이면 같은 단계 재개 버튼', () => {
    const a = at('ATT-0005-1', 'dev', 'interrupted', '2026-11-03T10:58:00Z', { failure: 'Runner 수동 중지' });
    const task = { ...T, lifecycleStatus: 'paused' } as const;
    const n = nextStep({ ...base, task, flow: flowOf(task, [a], []), attempts: [a], verifications: [] });
    expect(n.text).toBe('ATT-0005-1 개발 중단 — Runner 수동 중지. 같은 작업을 새 실행 시도로 이어서 진행합니다 (기존 시도 기록 보존).');
    expect(n.action).toEqual({ op: 'resume', attempt: a, label: 'Claude 개발 재개 요청' });
  });
  it('QA 대기는 서버 자동 — 버튼 없음', () => {
    const dev = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    const task = { ...T, lifecycleStatus: 'qa' } as const;
    const n = nextStep({ ...base, task, flow: flowOf(task, [dev], []), attempts: [dev], verifications: [] });
    expect(n.text).toBe('개발 완료 — 서버가 Codex QA를 자동으로 요청합니다. Runner 실행을 기다립니다.');
    expect(n.action).toBeNull();
  });
  it('BLOCKED는 자동 반복하지 않으므로 팀장 QA 요청 버튼', () => {
    const dev = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    const qa = at('A-2', 'qa', 'completed', '2026-11-01T01:00:00Z');
    const v = vf(qa, 'BLOCKED');
    const n = nextStep({ ...base, flow: flowOf(T, [dev, qa], [v]), attempts: [dev, qa], verifications: [v] });
    expect(n.text).toBe('v-A-2 BLOCKED — 차단 원인을 해결한 뒤 Codex QA를 요청합니다. BLOCKED는 자동으로 반복하지 않습니다.');
    expect(n.action).toEqual({ op: 'run', kind: 'qa', label: 'Codex QA 요청' });
  });
  it('QA FAIL 뒤 재작업은 자동(카운터 표시)', () => {
    const dev = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    const qa = at('A-2', 'qa', 'completed', '2026-11-01T01:00:00Z');
    const v = vf(qa, 'FAIL');
    const n = nextStep({ ...base, flow: flowOf(T, [dev, qa], [v]), attempts: [dev, qa], verifications: [v] });
    expect(n.text).toBe('v-A-2 FAIL — 서버가 실패 항목을 Claude에게 전달하고 재작업을 새 시도로 자동 실행합니다 (자동 재작업 1/3회). 기존 검증 결과는 그대로 보존됩니다.');
    expect(n.action).toBeNull();
  });
  it('재작업 한도 알림이 있으면 재작업 지시 작성 버튼(1회)', () => {
    const dev = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    const qa = at('A-2', 'qa', 'completed', '2026-11-01T01:00:00Z');
    const v = vf(qa, 'FAIL');
    const alerts = [{ key: 'rework-limit:uuid', text: '자동 재작업 한도를 넘었습니다.' }];
    const n = nextStep({ ...base, alerts, flow: flowOf(T, [dev, qa], [v]), attempts: [dev, qa], verifications: [v] });
    expect(n.action).toEqual({ op: 'rework', label: '재작업 지시 작성' });
    expect(n.text).toContain('자동 재작업 한도(3회)를 넘었습니다');
  });
  it('실행 실패: 자동 재시도 중에는 버튼 없음, Task failed(한도 초과)면 재실행 버튼', () => {
    const d1 = at('A-1', 'dev', 'failed', '2026-11-01T00:00:00Z', { failure: 'CLI 종료 코드 1' });
    const running = nextStep({ ...base, flow: flowOf(T, [d1], []), attempts: [d1], verifications: [] });
    expect(running.text).toBe('A-1 개발 실패 — CLI 종료 코드 1. 서버가 자동으로 다시 시도합니다 (연속 실패 1/3회).');
    expect(running.action).toBeNull();
    const task = { ...T, lifecycleStatus: 'failed' } as const;
    const n = nextStep({ ...base, task, flow: flowOf(task, [d1], []), attempts: [d1], verifications: [] });
    expect(n.text).toBe('A-1 개발 실패 — CLI 종료 코드 1. 자동 재시도 한도(총 3회)를 넘었습니다. 원인을 확인한 뒤 한 번 더 요청할 수 있습니다.');
    expect(n.action).toEqual({ op: 'run', kind: 'dev', label: '개발 재실행 요청' });
    const byAlert = nextStep({ ...base, alerts: [{ key: 'retry:id-A-1' }], flow: flowOf(T, [d1], []), attempts: [d1], verifications: [] });
    expect(byAlert.action).toEqual({ op: 'run', kind: 'dev', label: '개발 재실행 요청' });
  });
  it('Gate 단계는 서버 자동 완료 안내', () => {
    const dev = at('A-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
    const qa = at('A-2', 'qa', 'completed', '2026-11-01T01:00:00Z');
    const v = vf(qa, 'PASS');
    const n = nextStep({ ...base, flow: flowOf(T, [dev, qa], [v]), attempts: [dev, qa], verifications: [v] });
    expect(n.text).toBe('Verification PASS — Completion Gate 조건을 확인합니다. 조건이 모두 충족되면 서버가 통합 확인 · 병합 뒤 자동으로 완료합니다.');
    expect(n.action).toBeNull();
  });
});

describe('선택 시도(안정 키)', () => {
  const a1 = at('ATT-1', 'dev', 'completed', '2026-11-01T00:00:00Z');
  const a2 = at('ATT-2', 'qa', 'running', '2026-11-01T01:00:00Z');
  it('주소의 attemptKey가 있으면 그 시도, 없으면 실행 중 또는 마지막', () => {
    expect(pickAttempt([a1, a2], 'ATT-1')).toEqual({ attempt: a1, explicit: true });
    expect(pickAttempt([a1, a2], null)).toEqual({ attempt: a2, explicit: false });
  });
  it('존재하지 않는 시도는 선택하지 않는다(UAT-EMPTY-03)', () => {
    expect(pickAttempt([a1], 'ATT-9')).toEqual({ attempt: a1, explicit: false });
    expect(pickAttempt([], 'ATT-9')).toEqual({ attempt: null, explicit: false });
  });
});

describe('메시지 전달 표시(P LBL.dlv L2931, G§4.10)', () => {
  it('보낸 메시지는 전달 상태 + 한글, 받은 응답은 Runner 응답', () => {
    expect(deliveryView({ dir: 'out', delivery: 'Acknowledged' })).toEqual({ label: 'Acknowledged · 수신 확인', cls: 'd-a' });
    expect(deliveryView({ dir: 'out', delivery: 'Failed' })).toEqual({ label: 'Failed · 전달 실패', cls: 'd-f' });
    expect(deliveryView({ dir: 'in', delivery: null })).toEqual({ label: 'Runner 응답', cls: 'd-r' });
  });
});
