#!/usr/bin/env node
// 시도 흐름 시험용 가짜 Agent CLI(유료 호출·네트워크 없음). 실제 CLI처럼 작업 폴더에서 파일을 바꾸고 커밋하고,
// Claude(stream-json)·Codex(exec --json) 출력 모양으로 종료 메시지를 낸다.
// 사용: node agent-cli.mjs <시나리오 JSON 경로> [CLI 인자...]   지시문은 표준 입력으로 받는다.
// 시나리오: { agent: 'claude'|'codex', devInvalidFirst?, fixInvalid?, qaDirty?, qaVerdict?: 'PASS'|'FAIL', calls?: <기록 파일 경로> }
// - devInvalidFirst: 개발 첫 종료 메시지를 JSON이 아닌 글로 낸다. fixInvalid: 수정 요청에도 형식이 틀린 JSON을 낸다.
// - qaDirty: QA가 작업 폴더에 추적 안 된 파일을 남긴다(청결 재확인 시험).
// 같은 계정 시험과 전용 계정(host) 시험이 함께 쓴다. host에서는 Agent 계정으로 돌므로 기록 파일을 쓰지 않는다.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [scenarioPath, ...argv] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const prompt = readFileSync(0, 'utf8');
const cwd = process.cwd();
if (scenario.calls) appendFileSync(scenario.calls, `${JSON.stringify({ argv, cwd, stdin: prompt })}\n`);

const fixing = prompt.includes('한 번뿐인 수정 요청');
const verify = fixing ? prompt.includes('"verdict"') : prompt.includes('검사한 커밋 그대로입니다');
// 시도 흐름이 지시문에 넣는 두 줄(이전 시도에서 받은 지시·전달할 메시지)의 메시지 ID만 읽는다.
const ids = [...prompt.matchAll(/^(?:이전 시도에서 받은 지시|전달할 메시지): (\[.*\])$/gm)].flatMap(m => JSON.parse(m[1]).map(message => message.id));
const responses = [...new Set(ids)].map(messageId => ({ messageId, text: '지시를 반영했습니다.', workState: '완료' }));
// safe.directory: 실제 Claude·Codex 세션(래퍼 run)은 Agent 계정 전역 설정(safe.directory '*')을 쓴다. 이 fake는 래퍼 ci-run(새 HOME)으로
// 뜨므로 그 설정이 없어, 같은 효과를 이 폴더 하나에만 명령줄로 준다(Runner 쪽 설정이 아니라 Agent 세션 흉내다).
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${cwd}`, '-c', 'user.name=fake-agent', '-c', 'user.email=fake@example.invalid', '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: cwd } }).trim();

let report;
if (fixing && scenario.fixInvalid) {
  report = { summary: '', selfCheck: '목록이 아님' };
} else if (verify) {
  if (scenario.qaDirty) writeFileSync(join(cwd, 'qa-note.txt'), 'QA가 남긴 파일\n');
  const line = /체크리스트\(acId로 쓰세요\): (.*)/.exec(prompt)?.[1] ?? '없음';
  const keys = line === '없음' ? [] : line.split(' / ').map(item => item.split('=')[0]);
  const verdict = scenario.qaVerdict ?? 'PASS';
  // 증거 파일은 작업 폴더의 .awbs-evidence/ 안에 두고 이름만 적는다(Runner가 Agent 계정으로 읽어 올린다).
  writeFileSync(join(cwd, '.awbs-evidence', 'check.log'), `검사 결과 ${verdict}\n`);
  report = { verdict, criteria: keys.map(acId => ({ acId, result: verdict, cmd: 'cat src/result.ts', expected: '결과 파일이 있음', actual: verdict === 'PASS' ? '있음' : '내용 부족', evidence: ['check.log'] })),
    defects: verdict === 'FAIL' ? [{ text: '수용 기준 미충족', blocking: true }] : [], ...(responses.length && { responses }) };
} else if (fixing) {
  report = { summary: '형식을 고쳐 다시 냅니다', selfCheck: ['결과 파일 확인'], followups: [], designItems: [], ...(responses.length && { responses }) };
} else {
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const previous = (() => { try { return readFileSync(join(cwd, 'src/result.ts'), 'utf8'); } catch { return ''; } })();
  writeFileSync(join(cwd, 'src/result.ts'), `${previous}export const result${String(previous.split('\n').length)} = true;\n`);
  git('add', '-A');
  git('commit', '-q', '-m', '가짜 Agent 변경');
  report = scenario.devInvalidFirst ? null
    : { summary: '결과 파일을 만들었습니다', selfCheck: ['결과 파일 확인'], followups: [], designItems: [], ...(responses.length && { responses }) };
}
const text = report ? JSON.stringify(report) : '작업을 마쳤습니다. (JSON 없음)';
const session = 'fake-session-0001';
const lines = scenario.agent === 'codex'
  ? [{ type: 'thread.started', thread_id: session }, { type: 'item.completed', item: { type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }]
  : [{ type: 'system', subtype: 'init', session_id: session, model: 'fake-model', tools: [] },
    { type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: session, result: text, usage: { input_tokens: 0, output_tokens: 0 } }];
for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
