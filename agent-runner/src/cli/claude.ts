import { isObject, num, str, type CliEvent, type Json, type TaskOp, taskEvent } from './events.ts';

/** 하위 Agent를 띄우는 도구 이름. 예전 이름 `Task`도 받는다. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** 알고 있지만 관측 이벤트로 옮길 것이 없는 system subtype */
const QUIET_SYSTEM = new Set(['task_progress', 'compact_boundary', 'informational', 'api_retry', 'status']);
const KNOWN_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image', 'server_tool_use', 'web_search_tool_result']);

/**
 * Claude Code `-p --output-format stream-json --verbose` 해석기. **상태가 없다** — 한 줄을 이벤트로 옮기기만 한다.
 * run·Agent 연결은 `reduce.ts`가 한다. 형식 출처: 공식 Agent SDK 메시지 형식(SDKMessage). 실제 기록으로 검증한 형식이 아니다 — 관측 등급 「미검증」.
 * 이 줄 하나만 보고도 알 수 있는 형식 결함(id 없는 Agent 호출, task_id·task_type 없는 task 메시지)은 여기서 `subagent_unlinked`로 낸다.
 */
export function createClaudeParser(): (event: Json) => CliEvent[] {
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
        if (id === undefined || id === '') unlinked(out, 'Agent 도구 호출에 id 없음');
        else out.push({ type: 'agent_call', id, parentId: parent });
      }
      const toolUseId = b.type === 'tool_result' ? str(b.tool_use_id) : undefined;
      if (toolUseId) out.push({ type: 'tool_result', toolUseId });
    });
  };

  const task = (e: Json, out: CliEvent[], op: TaskOp) => {
    const taskId = str(e.task_id);
    if (taskId === undefined || taskId === '') return void unlinked(out, `task 메시지(${op})에 task_id 없음`);
    if (op === 'started') {
      const taskType = str(e.task_type);
      // 하위 Agent인지 알 수 없다. 추측하지 않는다(리뷰 3 A).
      if (taskType === undefined) return void unlinked(out, 'task_started에 task_type 없음');
      out.push(taskEvent({ type: 'task', op, taskId, taskType, toolUseId: str(e.tool_use_id), runId: str(e.run_id), background: e.is_backgrounded === true }));
      return;
    }
    if (op === 'updated') {
      const patch = isObject(e.patch) ? e.patch : {};
      const background = typeof patch.is_backgrounded === 'boolean' ? patch.is_backgrounded : undefined;
      out.push(taskEvent({ type: 'task', op, taskId, runId: str(e.run_id), background, status: str(patch.status) }));
      return;
    }
    out.push(taskEvent({ type: 'task', op, taskId, toolUseId: str(e.tool_use_id), runId: str(e.run_id), status: str(e.status) ?? '' }));
  };

  const system = (e: Json, out: CliEvent[]) => {
    const subtype = str(e.subtype);
    if (subtype === 'init') {
      const sessionId = str(e.session_id);
      if (sessionId === undefined) return out.push({ type: 'unknown', raw: e });
      const model = str(e.model);
      return out.push(model === undefined ? { type: 'session', sessionId } : { type: 'session', sessionId, model });
    }
    if (subtype === 'task_started') return task(e, out, 'started');
    if (subtype === 'task_updated') return task(e, out, 'updated');
    if (subtype === 'task_notification') return task(e, out, 'notification');
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
