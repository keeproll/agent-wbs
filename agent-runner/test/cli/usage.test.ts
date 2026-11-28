import { expect, test } from 'vitest';
import { createClaudeParser } from '../../src/cli/claude.ts';
import { SubagentUsage } from '../../src/cli/usage.ts';

const installed = [{ id: 'def-uuid-1', key: 'db-migrator', version: 2, hash: 'a'.repeat(64) }];
const toolUse = (id: string, input: unknown, name = 'Agent') => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name, id, input }] } });

function collect(lines: unknown[]) {
  const parse = createClaudeParser(), usage = new SubagentUsage();
  for (const line of lines) for (const e of parse(line as never)) usage.apply(e);
  return usage;
}

test('설치한 지정 정의 이름이면 그 정의의 id·버전·hash, 아니면 이름만(버전·hash null)', () => {
  const usage = collect([toolUse('c1', { subagent_type: 'db-migrator' }), toolUse('c2', { subagent_type: 'db-migrator' }), toolUse('c3', { subagent_type: 'Explore' })]);
  expect(usage.items(installed)).toEqual([
    { id: 'def-uuid-1', version: 2, hash: 'a'.repeat(64), count: 2 },
    { id: 'Explore', version: null, hash: null, count: 1 },
  ]);
});

test('옛 도구 이름 Task도 받고, 같은 호출 id는 한 번만 센다', () => {
  const usage = collect([toolUse('c1', { subagent_type: 'Explore' }, 'Task'), toolUse('c1', { subagent_type: 'Explore' }, 'Task')]);
  expect(usage.items([])).toEqual([{ id: 'Explore', version: null, hash: null, count: 1 }]);
});

test('이름을 모르는 호출(입력 없음·빈 이름·문자열 아님)과 하위 Agent가 아닌 도구는 세지 않는다(기본 이름으로 채우지 않음)', () => {
  const usage = collect([
    toolUse('c1', undefined), toolUse('c2', { subagent_type: '' }), toolUse('c3', { subagent_type: 7 }),
    toolUse('c4', { subagent_type: 'Explore' }, 'Bash'),
  ]);
  expect(usage.items(installed)).toEqual([]);
});

test('서버 Id 길이(128자)를 넘는 이름은 잘라 보내지 않고 뺀다', () => {
  const usage = collect([toolUse('c1', { subagent_type: 'x'.repeat(129) }), toolUse('c2', { subagent_type: 'y'.repeat(128) })]);
  expect(usage.items([])).toEqual([{ id: 'y'.repeat(128), version: null, hash: null, count: 1 }]);
});

test('리뷰 Codex 4: 공백만인 이름·NUL이 든 이름은 서버가 받지 않으므로 보고하지 않고 버린다(모름)', () => {
  const usage = collect([
    toolUse('c1', { subagent_type: '   ' }), toolUse('c2', { subagent_type: '\t' }), toolUse('c3', { subagent_type: 'a\u0000b' }),
    toolUse('c4', { subagent_type: ' Explore ' }),
  ]);
  // 앞뒤 공백이 있어도 글자가 있으면 원문 그대로 보낸다(이름을 고쳐 다른 Agent로 만들지 않음).
  expect(usage.items([])).toEqual([{ id: ' Explore ', version: null, hash: null, count: 1 }]);
});
