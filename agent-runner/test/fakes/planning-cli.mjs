#!/usr/bin/env node
// 시험 전용 CLI. 유료 서비스·전역 Agent CLI·네트워크를 호출하지 않는다.
import { basename } from 'node:path';
import assert from 'node:assert/strict';
import { FakeAgent } from '../planning/harness.ts';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const name = basename(process.argv[1]).includes('codex') ? 'Codex' : 'Claude';
const method = /Planning 질문: (\w+)/.exec(prompt)?.[1];
if (name === 'Codex') {
  assert(process.argv.some(arg => /^model_reasoning_effort="(?:low|medium|high)"$/.test(arg)));
  assert(process.argv.includes('features.multi_agent=false'));
  if (method) assert(process.argv.includes('sandbox_mode="read-only"'));
} else {
  assert(['low', 'medium', 'high'].includes(process.argv[process.argv.indexOf('--effort') + 1]));
  assert(process.argv.includes('Agent,Task'));
  if (method) assert(process.argv.includes('Read,Glob,Grep'));
}
if (!method && prompt.startsWith('설계 계약의 ')) {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '가짜 계약 반영 완료' }));
  process.exit(0);
}
if (!method) throw new Error('가짜 CLI가 모르는 질문입니다.');
const request = JSON.parse(prompt.slice(prompt.lastIndexOf('\n요청: ') + 5));
const fake = new FakeAgent(name);
const result = await fake[method](request);
if (method === 'draft') for (const task of result.tasks) delete task.estimate;
if (name === 'Codex') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
} else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result) }));
