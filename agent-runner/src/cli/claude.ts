import { isObject, num, str, type CliEvent, type Json } from './events.ts';

/** 하위 Agent를 띄우는 도구 이름. 예전 이름 `Task`도 받는다. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** 알고 있지만 관측 이벤트로 옮길 것이 없는 system subtype */
const QUIET_SYSTEM = new Set(['task_progress', 'compact_boundary', 'informational', 'api_retry', 'status']);
/** 작업이 끝났다는 상태 값(task_notification·task_updated) */
const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const KNOWN_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image', 'server_tool_use', 'web_search_tool_result']);

/**
 * Claude Code `-p --output-format stream-json --verbose` 해석기. 한 스트림에 하나를 쓴다(도구 호출 ID를 기억한다).
 * 형식 출처: 공식 Agent SDK 메시지 형식(SDKMessage). 실제 기록으로 검증한 형식이 아니다 — 관측 등급 「미검증」.
 */
interface AgentTask {
  kind: 'agent';
  /** 관측 ID(처음 연결된 도구 호출 ID) */
  id: string;
  /** 현재 run. CLI가 run_id를 주지 않으면 undefined */
  runId: string | undefined;
  /** 이 task에서 본 run 전부. 지나간 run을 알아보는 데 쓴다. */
  runs: Set<string>;
}

/**
 * **한 규칙**: task_* 메시지는 현재 run 것만 적용한다(재리뷰 1).
 * Claude는 같은 task를 재개하면 새 run_id를 주고, 이전 run의 메시지가 늦게 올 수 있다. 메시지 종류(시작·변경·알림)에 관계없이
 * - `current`: 현재 run(또는 CLI가 run_id를 전혀 쓰지 않음) → 적용
 * - `next`: 처음 보는 run의 **시작** → 재개로 보고 현재 run을 바꾼다
 * - `stale`: 이미 지나간 run → 버린다. 현재 상태를 덮지 않는다
 * - `unlinked`: 어느 run인지 알 수 없음(run을 쓰는 task인데 run_id 없음, 시작을 못 본 run의 변경·알림) → 적용하지 않고 미확인
 */
export function runGate(task: AgentTask, runId: string | undefined, isStart: boolean): 'current' | 'next' | 'stale' | 'unlinked' {
  if (runId === undefined) return task.runs.size === 0 || isStart ? 'current' : 'unlinked';
  if (runId === task.runId) return 'current';
  if (task.runs.has(runId)) return 'stale';
  return isStart ? 'next' : 'unlinked';
}

export function createClaudeParser(): (event: Json) => CliEvent[] {
  /** 하위 Agent 도구 호출 ID → 관측 ID. 재개 run이 다른 도구 호출로 이어져도 같은 하위 Agent로 센다. */
  const calls = new Map<string, string>();
  /**
   * task_id별로 아는 것. `agent`만 하위 Agent다. `other`는 배경 명령 같은 다른 작업이라 무시한다.
   * `unlinked`는 하위 Agent일 수 있지만 연결 정보가 부족해 이미 미확인으로 알린 작업이다.
   */
  const tasks = new Map<string, AgentTask | { kind: 'other' | 'unlinked' }>();
  const unlinked = (out: CliEvent[], reason: string) => out.push({ type: 'subagent_unlinked', reason });

  const blocks = (e: Json, out: CliEvent[], kind: 'assistant' | 'user') => {
    const message = isObject(e.message) ? e.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const parent = str(e.parent_tool_use_id) ?? null;
    content.forEach((b: unknown, i) => {
      if (!isObject(b) || !KNOWN_BLOCKS.has(str(b.type) ?? '')) {
        out.push({ type: 'unknown', raw: isObject(b) ? b : { value: b }, path: `message.content[${String(i)}]` });
        return;
      }
      if (b.type === 'text' && kind === 'assistant' && parent === null && typeof b.text === 'string') out.push({ type: 'message', text: b.text });
      if (b.type === 'tool_use' && AGENT_TOOLS.has(str(b.name) ?? '')) {
        const id = str(b.id);
        if (id === undefined || id === '') return void unlinked(out, 'Agent 도구 호출에 id 없음');
        calls.set(id, id);
        out.push({ type: 'subagent', id, phase: 'requested', parentId: parent });
      }
      const resultOf = b.type === 'tool_result' ? calls.get(str(b.tool_use_id) ?? '') : undefined;
      if (resultOf !== undefined) out.push({ type: 'subagent', id: resultOf, phase: 'returned' });
    });
  };

  /**
   * 작업 시작. 연결이 확실할 때만 하위 Agent로 센다. 값을 추측해 채우지 않는다(리뷰 3).
   * - task_type이 없으면 하위 Agent인지 알 수 없다 → 미확인
   * - tool_use_id가 없으면 앞서 본 도구 호출과 같은 것인지 알 수 없다 → 새 ID로 세지 않고 미확인
   * - 같은 task_id가 다시 시작되면 재개 run이다. run_id를 바꿔 기억해 늦게 온 이전 run의 알림을 걸러낸다.
   */
  const taskStarted = (e: Json, out: CliEvent[]) => {
    const taskId = str(e.task_id);
    const type = str(e.task_type);
    if (type !== undefined && type !== 'local_agent') {
      if (taskId !== undefined) tasks.set(taskId, { kind: 'other' });
      return;
    }
    if (taskId === undefined) return void unlinked(out, 'task_started에 task_id 없음');
    if (type === undefined) {
      tasks.set(taskId, { kind: 'unlinked' });
      return void unlinked(out, 'task_started에 task_type 없음');
    }
    const known = tasks.get(taskId);
    const toolUseId = str(e.tool_use_id);
    const runId = str(e.run_id);
    if (known?.kind === 'agent') {
      const gate = runGate(known, runId, true);
      if (gate === 'stale') return;
      if (gate === 'next' && runId !== undefined) {
        known.runId = runId;
        known.runs.add(runId);
      }
      // 재개가 새 도구 호출(새 ID)로 왔으면, 그 ID로 따로 센 것을 기존 Agent로 합친다(재리뷰 2: 같은 Agent 중복 방지).
      if (toolUseId && toolUseId !== known.id) {
        if (calls.get(toolUseId) === toolUseId) out.push({ type: 'subagent', id: toolUseId, phase: 'merged', into: known.id });
        calls.set(toolUseId, known.id);
      }
      out.push({ type: 'subagent', id: known.id, phase: 'running', background: e.is_backgrounded === true });
      return;
    }
    if (toolUseId === undefined || toolUseId === '') {
      tasks.set(taskId, { kind: 'unlinked' });
      return void unlinked(out, 'task_started에 tool_use_id 없음');
    }
    const id = calls.get(toolUseId) ?? toolUseId;
    calls.set(toolUseId, id);
    tasks.set(taskId, { kind: 'agent', id, runId, runs: new Set(runId === undefined ? [] : [runId]) });
    out.push({ type: 'subagent', id, phase: 'running', background: e.is_backgrounded === true });
  };

  const system = (e: Json, out: CliEvent[]) => {
    const subtype = str(e.subtype);
    if (subtype === 'init') {
      const sessionId = str(e.session_id);
      if (sessionId === undefined) return out.push({ type: 'unknown', raw: e });
      const model = str(e.model);
      return out.push(model === undefined ? { type: 'session', sessionId } : { type: 'session', sessionId, model });
    }
    if (subtype === 'task_started') return taskStarted(e, out);
    if (subtype === 'task_updated') {
      // 전경 작업이 도중에 배경으로 바뀌는 신호(리뷰 1). 모르는 작업이면 연결할 수 없으므로 미확인.
      const task = tasks.get(str(e.task_id) ?? '');
      if (task === undefined) return unlinked(out, 'task_updated의 task_id를 모름');
      if (task.kind !== 'agent') return 0;
      const gate = runGate(task, str(e.run_id), false);
      if (gate === 'stale') return 0;
      if (gate === 'unlinked') return unlinked(out, 'task_updated의 run을 연결할 수 없음');
      const patch = isObject(e.patch) ? e.patch : {};
      if (patch.is_backgrounded === true) out.push({ type: 'subagent', id: task.id, phase: 'running', background: true });
      const status = str(patch.status);
      if (status !== undefined && TERMINAL.has(status)) out.push({ type: 'subagent', id: task.id, phase: 'done', status });
      return 0;
    }
    if (subtype === 'task_notification') {
      const task = tasks.get(str(e.task_id) ?? '');
      let id: string | undefined;
      if (task?.kind === 'agent') {
        // 재개 run이 시작된 뒤 늦게 온 이전 run의 알림이면 지금 run을 지우지 않는다.
        const gate = runGate(task, str(e.run_id), false);
        if (gate === 'stale') return 0;
        if (gate === 'unlinked') return unlinked(out, 'task_notification의 run을 연결할 수 없음');
        id = task.id;
      } else if (task === undefined) {
        id = calls.get(str(e.tool_use_id) ?? '');
      }
      // 하위 Agent가 아닌 배경 작업(명령 등)이나 이미 미확인으로 알린 작업의 알림이면 무시한다.
      if (id === undefined) return 0;
      const status = str(e.status) ?? '';
      return out.push({ type: 'subagent', id, phase: TERMINAL.has(status) ? 'done' : 'unknown', status });
    }
    if (QUIET_SYSTEM.has(subtype ?? '')) return 0;
    return out.push({ type: 'unknown', raw: e });
  };

  const result = (e: Json, out: CliEvent[]) => {
    const usage = isObject(e.usage) ? e.usage : null;
    if (usage) out.push({ type: 'usage', inputTokens: num(usage.input_tokens), cachedInputTokens: num(usage.cache_read_input_tokens), outputTokens: num(usage.output_tokens) });
    const subtype = str(e.subtype) ?? 'unknown';
    const ok = subtype === 'success' && e.is_error === false;
    const errors = Array.isArray(e.errors) ? e.errors.filter((x): x is string => typeof x === 'string') : [];
    const text = str(e.result) ?? (errors.length ? errors.join('\n') : undefined);
    // subtype이 success인데 is_error면 API 오류 등으로 끝난 것이다. 원인은 terminal_reason에 있다.
    const reason = subtype === 'success' && !ok ? (str(e.terminal_reason) ?? 'error') : subtype;
    out.push(text === undefined ? { type: 'result', ok, reason } : { type: 'result', ok, reason, text });
  };

  return (e) => {
    const out: CliEvent[] = [];
    switch (e.type) {
      case 'system': system(e, out); break;
      case 'assistant': blocks(e, out, 'assistant'); break;
      case 'user': blocks(e, out, 'user'); break;
      case 'result': result(e, out); break;
      default: out.push({ type: 'unknown', raw: e });
    }
    return out;
  };
}
