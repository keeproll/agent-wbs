/**
 * 두 CLI의 출력을 같은 모양으로 옮긴 이벤트. 원문은 기록(transcript)에 그대로 남고, 이 이벤트는 관측용이다.
 *
 * 하위 Agent 단계(`phase`):
 * - `requested`: 생성 요청을 봄(Claude Agent 도구 호출). 아직 실행 여부는 모름
 * - `running`: 실행 중으로 보고됨
 * - `returned`: 부른 쪽에 도구 결과가 돌아옴. 배경 실행이면 끝난 것이 아니다
 * - `done`: 작업이 끝났다고 보고됨. **프로세스 종료가 아니다**(G §6.7 해석 주의)
 * - `unknown`: 모르는 상태 값. 추정하지 않는다
 */
export type SubagentPhase = 'requested' | 'running' | 'returned' | 'done' | 'unknown';

export type CliEvent =
  | { type: 'session'; sessionId: string; model?: string }
  /** 주 Agent의 글. 하위 Agent의 글은 섞지 않는다. */
  | { type: 'message'; text: string }
  | { type: 'subagent'; id: string; phase: SubagentPhase; parentId?: string | null; status?: string; background?: boolean }
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
