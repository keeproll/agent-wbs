import { isObject, num, str, type CliEvent, type Json } from './events.ts';

/** 하위 Agent를 띄우는 도구 이름. 예전 이름 `Task`도 받는다. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** 알고 있지만 관측 이벤트로 옮길 것이 없는 system subtype */
const QUIET_SYSTEM = new Set(['task_progress', 'compact_boundary', 'informational', 'api_retry', 'status']);
const KNOWN_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image', 'server_tool_use', 'web_search_tool_result']);

/**
 * Claude Code `-p --output-format stream-json --verbose` 해석기. 한 스트림에 하나를 쓴다(도구 호출 ID를 기억한다).
 * 형식 출처: 공식 Agent SDK 메시지 형식(SDKMessage). 실제 기록으로 검증한 형식이 아니다 — 관측 등급 「미검증」.
 */
export function createClaudeParser(): (event: Json) => CliEvent[] {
  const agentCalls = new Set<string>();
  const taskTool = new Map<string, string>();

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
      if (b.type === 'tool_use' && typeof b.id === 'string' && AGENT_TOOLS.has(str(b.name) ?? '')) {
        agentCalls.add(b.id);
        out.push({ type: 'subagent', id: b.id, phase: 'requested', parentId: parent });
      }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && agentCalls.has(b.tool_use_id)) {
        out.push({ type: 'subagent', id: b.tool_use_id, phase: 'returned' });
      }
    });
  };

  const system = (e: Json, out: CliEvent[]) => {
    const subtype = str(e.subtype);
    if (subtype === 'init') {
      const sessionId = str(e.session_id);
      if (sessionId === undefined) return out.push({ type: 'unknown', raw: e });
      const model = str(e.model);
      return out.push(model === undefined ? { type: 'session', sessionId } : { type: 'session', sessionId, model });
    }
    if (subtype === 'task_started') {
      if (e.task_type !== 'local_agent') return 0;
      const taskId = str(e.task_id);
      const id = str(e.tool_use_id) ?? (taskId ? `task:${taskId}` : undefined);
      if (id === undefined) return out.push({ type: 'subagent_unlinked', reason: 'task_started에 task_id·tool_use_id 없음' });
      if (taskId) taskTool.set(taskId, id);
      agentCalls.add(id);
      return out.push({ type: 'subagent', id, phase: 'running', background: e.is_backgrounded === true });
    }
    if (subtype === 'task_notification') {
      const taskId = str(e.task_id);
      const id = str(e.tool_use_id) ?? (taskId ? taskTool.get(taskId) : undefined);
      // 하위 Agent가 아닌 배경 작업(명령 등)의 알림이면 무시한다.
      if (id === undefined || !agentCalls.has(id)) return 0;
      const status = str(e.status) ?? '';
      return out.push({ type: 'subagent', id, phase: ['completed', 'failed', 'stopped'].includes(status) ? 'done' : 'unknown', status });
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
