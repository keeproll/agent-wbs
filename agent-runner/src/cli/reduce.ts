import type { CliEvent } from './events.ts';

/**
 * 하위 Agent 관측 reducer. **순수 함수 하나**가 모든 이벤트를 상태에 적용한다: `reduceObservation(state, input) → state`.
 * 입력을 바꾸지 않고 새 상태를 돌려준다. 같은 입력열이면 언제나 같은 결과다.
 *
 * ## 무엇을 「현재」로 보나 — 증명된 사실만
 * 이벤트 안의 값(run_id 문자열 순서, 처음 본 run 등)으로 현재·다음 run을 추측하지 않는다(재리뷰 2 지시).
 * 현재를 정하는 사실은 두 가지뿐이다.
 * 1. **launch 기록**: Runner가 이 CLI 프로세스를 직접 시작했다는 사실. 한 스트림의 이벤트는 그 launch에 속한다.
 *    Runner가 같은 관측을 이어 가며 프로세스를 다시 시작하면 `{type:'launch'}`를 넣는다.
 * 2. **도구 호출 순서**: 이 launch에서 모델이 낸 Agent 도구 호출. 모델 출력은 한 스트림 안에서 순서가 바뀌지 않는다.
 *    run은 자기 도구 호출(task_started의 `tool_use_id`)에 묶일 때만 생기고, 한 호출에는 run 하나만 묶인다.
 *    한 task의 현재 run = 이 launch에서 **가장 나중에 낸 호출**에 묶인 run이다.
 *
 * ## 이벤트 분류(메시지 종류와 관계없이 같은 규칙)
 * - 현재 run의 이벤트 → 적용
 * - 지나간 run(묶였지만 현재가 아닌 run, 또는 이미 다른 run이 차지한 호출을 주장한 run)의 이벤트 → **버린다**(`dropped`). 현재 상태를 바꾸지 않는다.
 * - 연결을 증명할 수 없는 이벤트(run_id 없음, 시작을 못 본 run, 모르는 호출·task, 이전 launch의 호출) → 상태를 바꾸지 않고 **미확인**만 남긴다.
 * - 이미 run이 묶인 호출(또는 이미 아는 run)을 다른 시작이 또 주장하면, 어느 쪽이 현재인지 증명할 수 없다.
 *   run_id 문자열 순서로 고르지 않는다(owner 결정 B). 그 task를 「모호」로 표시하고 이후 수를 줄이는 변경은 하지 않는다 → 미확인.
 * - 도구 결과는 그 Agent의 현재 run에 묶인 호출 ID일 때만 적용한다. 재개로 합쳐진 이전 호출 ID의 늦은 결과는 버린다.
 * 버리거나 미확인으로 남긴 이벤트는 실행 수를 줄일 수 없다. 그래서 늦은·중복·누락 메시지는 많아야 「더 많이 셈」이 된다(fail-closed).
 *
 * ## 한 원칙(재리뷰 3): 줄이거나 끝내는 전이는 「현재 launch에서 시작이 증명된 대상」에게만
 * 수를 줄이는 전이(도구 결과·완료 알림·완료 patch·Codex 완료 상태)는 모두 `settle` 하나를 지난다.
 * - 대상의 시작이 **현재 launch에서** 증명됐을 때만(`proven === launch`) 적용한다.
 *   - Claude: 이 launch의 도구 호출에 `task_started`가 묶임. 도구 호출만 보고 센 것은 시작이 증명되지 않았다.
 *   - Codex: 이 launch의 스트림에서 실행 중(`running`·`pending_init`)으로 보고됨.
 * - 그 밖에는 수를 그대로 두고 미확인으로만 남긴다. 예: 시작 보고 없는 호출의 도구 결과, 이전 launch에서 시작한 task의 완료.
 * - launch마다 run 범위 상태(`ended`)를 처음으로 되돌린다. 이전 launch의 미확인·보유 수는 이어받는다.
 */

interface CallRec {
  /** 이 launch 안에서의 호출 순서 */
  seq: number;
  launch: number;
  /** 이 호출을 세는 Agent 키. 재개로 합쳐지면 task의 Agent 키로 바뀐다(별칭). */
  agent: string;
  /** 묶인 task·run. 아직 시작 보고를 못 봤으면 없음 */
  task?: string;
  run?: string;
}

interface AgentTaskRec {
  kind: 'agent';
  agent: string;
  /** 이 task가 run_id를 쓰는가. 쓰지 않는 구형 출력이면 run 키는 `''` 하나다. */
  usesRunIds: boolean;
  /** run 키 → 묶인 호출 ID. 다른 run이 이미 차지한 호출을 주장한 run은 `null`(지나간 run으로만 안다). */
  runs: Record<string, string | null>;
  current: string;
  /**
   * 현재 run을 증명할 수 없게 됨(같은 호출이나 같은 run을 두 번째로 주장하는 시작을 봄).
   * run_id 순서로 어느 쪽이 현재인지 추측하지 않는다(owner 결정 B). 이후 이 task는 수를 줄이는 변경을 하지 않고 미확인으로만 남긴다.
   */
  ambiguous: boolean;
}

interface AgentRec {
  active: boolean;
  /** true 배경, false 전경, null 모름(보고가 없음). 도구 결과로 줄이는 것은 명시적 전경(false)일 때만이다. */
  background: boolean | null;
  /**
   * 이 Agent의 시작이 증명된 launch 번호. 도구 호출만 보고 센 것(시작 보고 없음)이면 null.
   * 수를 줄이거나 끝내는 전이는 이 값이 현재 launch일 때만 적용한다(`settle`).
   */
  proven: number | null;
  /** 현재 run에 묶인 호출. 도구 결과는 이 호출 것만 적용한다. */
  call: string;
}

export interface ObservationState {
  launch: number;
  seq: number;
  calls: Record<string, CallRec>;
  tasks: Record<string, AgentTaskRec | { kind: 'other' }>;
  /** 삽입 순서가 곧 표시 순서다. */
  agents: Record<string, AgentRec>;
  peak: number;
  unconfirmed: boolean;
  ended: boolean;
  /** 지나간 run의 것이라 버린 이벤트 수 */
  dropped: number;
  /** 미확인이 된 이유(처음 몇 개). 운영 로그용 */
  reasons: string[];
}

/** reducer 입력: CLI 이벤트 + Runner가 아는 사실(launch, 출력 끝). */
export type ObservationInput = CliEvent | { type: 'launch' } | { type: 'end' };

const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const MAX_REASONS = 20;

/** 관측 시작 상태. 만드는 것 자체가 첫 launch 기록이다(관측기 하나 = Runner가 시작한 프로세스 하나). */
export function initialObservation(): ObservationState {
  return { launch: 1, seq: 0, calls: {}, tasks: {}, agents: {}, peak: 0, unconfirmed: false, ended: false, dropped: 0, reasons: [] };
}

export function reduceObservation(prev: ObservationState, input: ObservationInput): ObservationState {
  const s = structuredClone(prev);
  apply(s, input);
  s.peak = Math.max(s.peak, activeIds(s).length);
  return s;
}

export function activeIds(s: ObservationState): string[] {
  return Object.entries(s.agents).filter(([, a]) => a.active).map(([id]) => id);
}

function unconfirm(s: ObservationState, reason: string): void {
  s.unconfirmed = true;
  if (s.reasons.length < MAX_REASONS) s.reasons.push(reason);
}

/**
 * 시작 증명을 만드는 유일한 길(재리뷰 4). **그 정확한 대상의 시작 이벤트를 현재 launch에서 관측**했을 때만 부른다.
 * - Claude: 이 launch의 도구 호출에 묶인 `task_started`. 대상은 그 task의 Agent 키(첫 호출 ID, 재개 호출은 별칭)다.
 * - Codex: 이 launch 스트림에서 그 thread ID가 실행 중(`running`·`pending_init`)으로 보고됨.
 * 모르는 상태·추정·다른 ID의 증명에서 옮겨 오지 않는다. 이전 launch의 증명을 현재로 올리지도 않는다.
 */
function startObserved(s: ObservationState, key: string, background: boolean | null, call: string): void {
  s.agents[key] = { active: true, background, call, proven: s.launch };
}

/** 수를 줄이는 유일한 길. 현재 launch에서 시작이 증명된 대상만 끝낸다. 아니면 수를 두고 미확인. */
function settle(s: ObservationState, key: string, reason: string): void {
  const a = s.agents[key];
  if (a?.proven === s.launch) {
    a.active = false;
    return;
  }
  unconfirm(s, `${reason}: 현재 launch에서 시작이 증명되지 않은 대상이라 줄이지 않음`);
}

/** run 분류. 값의 순서·처음 봤는지로 현재를 정하지 않는다. */
function classify(t: AgentTaskRec, runId: string | undefined): 'current' | 'past' | 'unlinked' {
  if (runId === undefined) return t.usesRunIds ? 'unlinked' : 'current';
  if (!t.usesRunIds) return 'unlinked';
  if (runId === t.current) return 'current';
  return Object.hasOwn(t.runs, runId) ? 'past' : 'unlinked';
}

function apply(s: ObservationState, e: ObservationInput): void {
  switch (e.type) {
    case 'launch': {
      s.launch += 1;
      // run 범위 상태는 새 프로세스 기준으로 다시 센다. 이전 launch의 result가 이번 launch의 「결과 없는 종료」를 가리면 안 된다.
      s.ended = false;
      // 이전 프로세스의 하위 Agent는 새 스트림에서 끝을 볼 수 없다. 수는 그대로 두고 미확인.
      if (activeIds(s).length > 0) unconfirm(s, '새 launch: 이전 launch의 하위 Agent 종료를 관측할 수 없음');
      return;
    }
    case 'end':
      if (!s.ended) unconfirm(s, '결과 이벤트 없이 출력이 끝남');
      return;
    case 'agent_call': {
      if (Object.hasOwn(s.calls, e.id)) return; // 같은 호출의 중복
      s.seq += 1;
      s.calls[e.id] = { seq: s.seq, launch: s.launch, agent: e.id };
      // 호출을 본 순간부터 센다(실행 여부를 모르므로 보수적으로).
      s.agents[e.id] = { active: true, background: null, call: e.id, proven: null };
      return;
    }
    case 'tool_result': {
      const c = s.calls[e.toolUseId];
      const a = c ? s.agents[c.agent] : undefined;
      if (!c || !a) return; // 하위 Agent 호출이 아닌 도구의 결과
      if (a.call !== e.toolUseId || c.launch !== s.launch) {
        s.dropped += 1; // 재개로 합쳐진 이전 호출의 늦은 결과
        return;
      }
      // 시작 보고와 연결되지 않은 호출은 전경인지 모른다(배경 「시작됨」 결과일 수 있다). 따로 검사하지 않는다:
      // 그런 호출의 Agent는 proven이 없으므로 아래 settle이 수를 두고 미확인으로 남긴다(한 원칙).
      const t = c.task === undefined ? undefined : s.tasks[c.task];
      if (t?.kind === 'agent' && t.ambiguous) return unconfirm(s, `task ${c.task ?? ''}의 도구 결과: 현재 run이 모호해 적용하지 않음`);
      if (a.background === true) return;
      if (a.background === null) return unconfirm(s, `도구 결과 ${e.toolUseId}: 전경인지 모름(배경 보고 없음)`);
      return settle(s, c.agent, `도구 결과 ${e.toolUseId}`);
    }
    case 'task':
      return task(s, e);
    case 'subagent': {
      // Codex: 같은 thread ID로 재개하고 한 스트림에 순서대로 온다. run 구분이 없다.
      if (e.phase === 'done') return settle(s, e.id, `하위 Agent ${e.id}의 완료 상태`);
      if (e.phase === 'running') return startObserved(s, e.id, null, e.id);
      // 모르는 상태: 실행 중으로 세되(보수) 시작 증명은 만들지 않는다. 이전 증명은 그대로 둔다(현재 launch로 올리지 않음).
      s.agents[e.id] = { active: true, background: null, call: e.id, proven: s.agents[e.id]?.proven ?? null };
      return unconfirm(s, `하위 Agent ${e.id}의 모르는 상태 ${e.status ?? ''}`);
    }
    case 'subagent_unlinked':
      return unconfirm(s, e.reason);
    case 'unparsed':
      return unconfirm(s, `해석하지 못한 줄 ${String(e.line)}(${e.reason})`);
    case 'error':
      // 복구 불가능한 스트림 오류 뒤의 관측은 믿을 수 없다. 뒤에 실패 결과가 와도 되돌리지 않는다.
      if (e.fatal) unconfirm(s, `스트림 오류: ${e.message}`);
      return;
    case 'result':
      s.ended = true;
      return;
    default:
      return;
  }
}

function task(s: ObservationState, e: Extract<CliEvent, { type: 'task' }>): void {
  const known = s.tasks[e.taskId];
  if (e.op === 'started') {
    if (e.taskType !== 'local_agent') {
      s.tasks[e.taskId] = known ?? { kind: 'other' };
      return;
    }
    if (known?.kind === 'other') return unconfirm(s, `task ${e.taskId}의 종류가 바뀜`);
    const c = e.toolUseId === undefined ? undefined : s.calls[e.toolUseId];
    if (!c || c.launch !== s.launch || e.toolUseId === undefined) return unconfirm(s, `task ${e.taskId} 시작을 이 launch의 도구 호출에 연결할 수 없음`);
    const usesRunIds = e.runId !== undefined;
    if (known && known.usesRunIds !== usesRunIds) return unconfirm(s, `task ${e.taskId} 시작의 run_id 유무가 다름`);
    const run = e.runId ?? '';
    // 같은 호출에 두 번째 run, 또는 이미 아는 run이 또 시작됨 → 현재 run을 증명할 수 없다.
    if (c.run !== undefined || (known && Object.hasOwn(known.runs, run))) {
      if (c.task === e.taskId && c.run === run) return; // 같은 시작의 중복
      if (known) {
        known.ambiguous = true;
        if (!Object.hasOwn(known.runs, run)) known.runs[run] = null;
      }
      return unconfirm(s, `task ${e.taskId}: 같은 호출·run을 두 번째로 주장하는 시작 — 현재 run을 증명할 수 없음`);
    }
    if (!known) {
      c.task = e.taskId;
      c.run = run;
      s.tasks[e.taskId] = { kind: 'agent', agent: c.agent, usesRunIds, runs: { [run]: e.toolUseId }, current: run, ambiguous: false };
      startObserved(s, c.agent, e.background ?? null, e.toolUseId);
      return;
    }
    // 같은 task의 새 호출로 시작 = 재개. 그 호출을 task의 Agent로 합친다(별칭).
    const currentCall = known.runs[known.current];
    const currentSeq = currentCall ? (s.calls[currentCall]?.seq ?? 0) : 0;
    c.task = e.taskId;
    c.run = run;
    known.runs[run] = e.toolUseId;
    if (c.agent !== known.agent) {
      Reflect.deleteProperty(s.agents, c.agent);
      c.agent = known.agent;
    }
    if (c.seq > currentSeq) {
      known.current = run;
      startObserved(s, known.agent, e.background ?? null, e.toolUseId);
    } else {
      s.dropped += 1; // 더 앞선 호출의 시작이 늦게 옴 = 지나간 run
    }
    return;
  }

  if (!known) return unconfirm(s, `시작을 보지 못한 task ${e.taskId}의 ${e.op}`);
  if (known.kind === 'other') return;
  if (known.ambiguous) return unconfirm(s, `task ${e.taskId}의 ${e.op}: 현재 run이 모호해 적용하지 않음`);
  const cls = classify(known, e.runId);
  if (cls === 'past') {
    s.dropped += 1;
    return;
  }
  if (cls === 'unlinked') return unconfirm(s, `task ${e.taskId}의 ${e.op}를 현재 run에 연결할 수 없음`);
  const a = s.agents[known.agent];
  if (!a) return unconfirm(s, `task ${e.taskId}의 Agent 기록 없음`);
  const what = `task ${e.taskId}의 ${e.op}`;
  if (e.op === 'updated') {
    // 배경으로 바꾸는 것은 수를 줄이지 않으므로 언제나 받는다. 전경으로 되돌리면 뒤에 도구 결과로 줄 수 있으니 증명된 대상만.
    if (e.background === true) a.background = true;
    if (e.background === false) {
      if (a.proven === s.launch) a.background = false;
      else unconfirm(s, `${what}: 현재 launch에서 시작이 증명되지 않은 대상의 전경 전환`);
    }
    if (e.status !== undefined && TERMINAL.has(e.status)) settle(s, known.agent, what);
    return;
  }
  if (e.status !== undefined && TERMINAL.has(e.status)) settle(s, known.agent, what);
  else unconfirm(s, `${what}: 모르는 알림 상태 ${e.status ?? ''}`);
}
