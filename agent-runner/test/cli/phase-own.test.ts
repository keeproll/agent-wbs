// M5·M7 통합 [M5 통합 때] M5-01 P3: PHASE 표가 constructor 같은 상속 속성을 상태로 읽지 않는다.
// 왜: 일반 객체 표는 'constructor'·'toString'·'__proto__' 키로 Object.prototype의 함수를 돌려준다.
// 그러면 phase가 문자열이 아닌 값이 되어, 모르는 상태를 unknown으로 다루는 규칙이 깨진다.
import { expect, test } from 'vitest';
import { createCodexParser } from '../../src/cli/codex.ts';

test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('모르는 상태 %s는 상속 속성이 아니라 unknown이다', (status) => {
  const events = createCodexParser()({ type: 'item.completed', item: { id: 'i-1', type: 'collab_tool_call', tool: 'wait',
    sender_thread_id: 'parent', receiver_thread_ids: ['th-a'], agents_states: { 'th-a': { status } }, status: 'completed' } });
  expect(events).toContainEqual({ type: 'subagent', id: 'th-a', phase: 'unknown', status });
});
