import { isObject, num, str, type CliEvent, type Json, type SubagentPhase } from './events.ts';

/** 활동으로만 옮기는 항목 */
const ACTIVITY = new Set(['reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list']);
/** 하위 Agent 상태를 알려 주는 협업 도구 */
const COLLAB_TOOLS = new Set(['spawn_agent', 'send_input', 'wait', 'close_agent', 'resume_agent']);
const PHASE: Readonly<Record<string, SubagentPhase>> = {
  // pending_init으로 남은 채 실행 중이라는 보고가 있어(G §6.7) 실행 중으로 센다.
  pending_init: 'running',
  running: 'running',
  completed: 'done',
  errored: 'done',
  shutdown: 'done',
  interrupted: 'done',
};

/**
 * Codex `exec --json` 해석기. 형식 출처: 공식 `codex-rs/exec/src/exec_events.rs`·TypeScript SDK `ThreadEvent`.
 * 해석 주의(G §6.7): spawn_agent 완료 = 생성 호출 완료(작업 완료 아님), agents_states.completed = 작업 완료(프로세스 종료 아님),
 * turn.completed ≠ 자손 정리 완료.
 */
export function createCodexParser(): (event: Json) => CliEvent[] {
  const collab = (item: Json, out: CliEvent[]) => {
    const tool = str(item.tool) ?? '';
    if (!COLLAB_TOOLS.has(tool)) return out.push({ type: 'unknown', raw: item, path: 'item' });
    // 없으면 비워 둔다. 주 Agent를 뜻하는 null로 채우지 않는다(재리뷰 5).
    const sender = str(item.sender_thread_id);
    const receivers = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.filter((x): x is string => typeof x === 'string' && x !== '') : [];
    const states = isObject(item.agents_states) ? item.agents_states : {};
    if (tool === 'spawn_agent' && item.status === 'completed' && receivers.length === 0) {
      out.push({ type: 'subagent_unlinked', reason: 'spawn_agent 완료에 receiver_thread_ids 없음' });
    }
    // 생성된 ID도 상태 보고가 없으면 실행 중으로 채우지 않는다(재리뷰 5). 빠진 필드·모르는 값은 언제나 unknown이다.
    const ids = new Set([...(tool === 'spawn_agent' && item.status === 'completed' ? receivers : []), ...Object.keys(states)]);
    for (const id of ids) {
      const state = states[id];
      const status = isObject(state) ? str(state.status) : undefined;
      const phase: SubagentPhase = status === undefined ? 'unknown' : (PHASE[status] ?? 'unknown');
      const event: CliEvent = { type: 'subagent', id, phase, ...(status === undefined ? {} : { status }) };
      if (tool === 'spawn_agent' && sender !== undefined) event.parentId = sender;
      out.push(event);
    }
    return 0;
  };

  const item = (e: Json, out: CliEvent[]) => {
    const it = isObject(e.item) ? e.item : null;
    if (!it) return out.push({ type: 'unknown', raw: e });
    const kind = str(it.type) ?? '';
    if (kind === 'agent_message') {
      if (e.type === 'item.completed' && typeof it.text === 'string') out.push({ type: 'message', text: it.text });
      return 0;
    }
    if (kind === 'error') return out.push({ type: 'error', message: str(it.message) ?? '', fatal: false });
    if (kind === 'collab_tool_call') return collab(it, out);
    if (ACTIVITY.has(kind)) {
      const status = str(it.status);
      return out.push(status === undefined ? { type: 'activity', kind } : { type: 'activity', kind, status });
    }
    return out.push({ type: 'unknown', raw: it, path: 'item' });
  };

  return (e) => {
    const out: CliEvent[] = [];
    switch (e.type) {
      case 'thread.started': {
        const sessionId = str(e.thread_id);
        out.push(sessionId === undefined ? { type: 'unknown', raw: e } : { type: 'session', sessionId });
        break;
      }
      case 'turn.started': break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': item(e, out); break;
      case 'turn.completed': {
        // usage가 없으면 토큰 0을 지어내지 않는다(재리뷰 5).
        const u = isObject(e.usage) ? e.usage : null;
        if (u) out.push({ type: 'usage', inputTokens: num(u.input_tokens), cachedInputTokens: num(u.cached_input_tokens), outputTokens: num(u.output_tokens) });
        out.push({ type: 'result', ok: true, reason: 'completed' });
        break;
      }
      case 'turn.failed': {
        const message = isObject(e.error) ? str(e.error.message) : undefined;
        out.push(message === undefined ? { type: 'result', ok: false, reason: 'turn_failed' } : { type: 'result', ok: false, reason: 'turn_failed', text: message });
        break;
      }
      case 'error': out.push({ type: 'error', message: str(e.message) ?? '', fatal: true }); break;
      default: out.push({ type: 'unknown', raw: e });
    }
    return out;
  };
}
