/**
 * 두 CLI의 출력을 같은 모양으로 옮긴 이벤트. 원문은 기록(transcript)에 그대로 남고, 이 이벤트는 관측용이다.
 * 해석기는 **상태가 없다**. 한 줄을 이벤트로 옮기기만 하고, 이벤트를 서로 연결하는 일(어느 run인지, 같은 Agent인지)은
 * 모두 `reduce.ts`의 순수 reducer 하나가 한다. 왜: 연결 규칙이 두 곳에 나뉘어 있으면 한쪽에서 막은 늦은 메시지가
 * 다른 쪽 경로로 들어와 현재 상태를 덮는다(재리뷰 1·2에서 세 번 반복된 부류).
 *
 * Codex 하위 Agent 단계(`phase`):
 * - `running`: 실행 중으로 보고됨
 * - `done`: 작업이 끝났다고 보고됨. **프로세스 종료가 아니다**(G §6.7 해석 주의)
 * - `unknown`: 모르는 상태 값. 추정하지 않는다
 */
export type SubagentPhase = 'running' | 'done' | 'unknown';

/** Claude task 메시지 종류(`system` 메시지의 task_started·task_updated·task_notification) */
export type TaskOp = 'started' | 'updated' | 'notification';

export type CliEvent =
  | { type: 'session'; sessionId: string; model?: string }
  /** 주 Agent의 글. 하위 Agent의 글은 섞지 않는다. */
  | { type: 'message'; text: string }
  /** Codex 하위 Agent 상태 보고(thread ID 단위) */
  | { type: 'subagent'; id: string; phase: SubagentPhase; parentId?: string | null; status?: string }
  /** Claude 하위 Agent 도구 호출(Agent·Task). 이 실행(launch)에서 모델이 낸 호출이라는 사실이다. */
  | { type: 'agent_call'; id: string; parentId: string | null }
  /** Claude 도구 결과. 어느 도구 호출의 결과인지만 담는다. 하위 Agent 호출인지는 reducer가 본다. */
  | { type: 'tool_result'; toolUseId: string }
  /** Claude task 메시지. 값은 원문 그대로이며, 어느 run에 속하는지는 reducer가 판정한다. */
  | { type: 'task'; op: TaskOp; taskId: string; taskType?: string; toolUseId?: string; runId?: string; background?: boolean; status?: string }
  /** 하위 Agent가 생겼는데 ID를 알 수 없음 → 집계 근거 부족 */
  | { type: 'subagent_unlinked'; reason: string }
  /** 명령 실행·파일 변경 같은 활동. 살아 있음을 아는 데 쓴다. */
  | { type: 'activity'; kind: string; status?: string }
  | { type: 'usage'; inputTokens: number; cachedInputTokens: number; outputTokens: number }
  | { type: 'result'; ok: boolean; reason: string; text?: string }
  | { type: 'error'; message: string; fatal: boolean }
  /** 모르는 이벤트(또는 이벤트 안의 모르는 조각). 원문 그대로 보존하고 아무것도 추정하지 않는다. `path`는 이벤트 안 위치. */
  | { type: 'unknown'; raw: Record<string, unknown>; path?: string }
  /** JSON 객체로 읽지 못한 줄(`StreamRecord` unparsed 그대로) */
  | { type: 'unparsed'; line: number; raw: string; reason: 'invalid_json' | 'not_object' | 'too_long' | 'truncated'; bytes: number };

export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export type TaskEvent = Extract<CliEvent, { type: 'task' }>;
type Loose<T> = { [K in keyof T]: T[K] | undefined };

/** undefined인 선택 필드를 빼고 task 이벤트를 만든다(exactOptionalPropertyTypes). */
export function taskEvent(fields: Loose<TaskEvent>): TaskEvent {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as TaskEvent;
}
