// contracts §5 Agent 종료 메시지 계약: 스키마 검사 + 의미 검사(전달한 메시지·체크리스트 키·판정 일관성).
import { expect, test } from 'vitest';
import type { AttemptJob } from '../../src/exec/session.ts';
import { checklistOf, fixPrompt, outputGuide, parseOutput, specRevisionOf } from '../../src/jobs/output.ts';

const job = (kind: AttemptJob['payload']['kind'], instructions: Record<string, unknown> = {}): AttemptJob => ({
  id: 'j', fence: 1, leaseUntil: '2026-11-28T00:00:00Z', kind: 'attempt',
  payload: { taskKey: 'TASK-0001', kind, agent: 'Claude', branch: 'agent/TASK-0001-h1', baseCommit: 'a'.repeat(40), inputVersion: 1, instructions },
});
const dev = { summary: '결과 파일을 만들었습니다', selfCheck: ['확인'], followups: [], designItems: [] };
const qaJob = job('qa', { revision: 3, checklist: [{ itemKey: 'CL-1', content: '수용 기준' }, { itemKey: 'CL-2', content: '오류 문구' }] });
const criterion = (acId: string, result = 'PASS') => ({ acId, result, cmd: 'pnpm test', expected: '통과', actual: '통과', evidence: [] });

test('개발: 전체가 JSON이거나 마지막 ```json 블록이면 읽는다', () => {
  expect(parseOutput(job('dev'), JSON.stringify(dev), [])).toEqual({ ok: true, value: dev });
  expect(parseOutput(job('rework'), `설명입니다.\n\`\`\`json\n${JSON.stringify(dev)}\n\`\`\``, [])).toMatchObject({ ok: true });
});

test('개발: JSON이 아니거나 필드가 틀리면 형식 오류이고, 변경 파일 자기보고(changedFiles)는 받지 않는다', () => {
  expect(parseOutput(job('dev'), '작업을 마쳤습니다.', [])).toMatchObject({ ok: false });
  expect(parseOutput(job('dev'), JSON.stringify({ ...dev, summary: ' ' }), [])).toMatchObject({ ok: false });
  const extra = parseOutput(job('dev'), JSON.stringify({ ...dev, changedFiles: ['a.ts'] }), []);
  expect(extra.ok).toBe(false);
  expect(!extra.ok && extra.problems.join()).toContain('additional properties');
});

test('업무 응답은 이번에 전달한 메시지에만, 한 번씩만 쓸 수 있다', () => {
  const answer = (messageId: string) => ({ messageId, text: '반영했습니다', workState: '완료' });
  expect(parseOutput(job('dev'), JSON.stringify({ ...dev, responses: [answer('m1')] }), ['m1'])).toMatchObject({ ok: true });
  expect(parseOutput(job('dev'), JSON.stringify({ ...dev, responses: [answer('m2')] }), ['m1'])).toMatchObject({ ok: false });
  expect(parseOutput(job('dev'), JSON.stringify({ ...dev, responses: [answer('m1'), answer('m1')] }), ['m1'])).toMatchObject({ ok: false });
});

test('QA: 체크리스트 항목을 모두 한 번씩, 서버가 준 키로만 보고해야 한다', () => {
  const ok = { verdict: 'PASS', criteria: [criterion('CL-1'), criterion('CL-2')], defects: [] };
  expect(parseOutput(qaJob, JSON.stringify(ok), [])).toMatchObject({ ok: true });
  for (const criteria of [[criterion('CL-1')], [criterion('CL-1'), criterion('CL-2'), criterion('CL-9')], [criterion('CL-1'), criterion('CL-1'), criterion('CL-2')]]) {
    expect(parseOutput(qaJob, JSON.stringify({ ...ok, criteria }), [])).toMatchObject({ ok: false });
  }
});

test('QA: PASS인데 실패 항목이 있거나 FAIL인데 결함이 없으면 형식 오류다', () => {
  expect(parseOutput(qaJob, JSON.stringify({ verdict: 'PASS', criteria: [criterion('CL-1'), criterion('CL-2', 'FAIL')], defects: [] }), [])).toMatchObject({ ok: false });
  expect(parseOutput(qaJob, JSON.stringify({ verdict: 'FAIL', criteria: [criterion('CL-1'), criterion('CL-2', 'FAIL')], defects: [] }), [])).toMatchObject({ ok: false });
  expect(parseOutput(qaJob, JSON.stringify({ verdict: 'FAIL', criteria: [criterion('CL-1'), criterion('CL-2', 'FAIL')], defects: [{ text: '문구 누락', blocking: true }] }), [])).toMatchObject({ ok: true });
});

test('256 KiB를 넘는 종료 메시지는 읽지 않는다', () => {
  expect(parseOutput(job('dev'), 'x'.repeat(256 * 1024 + 1), [])).toEqual({ ok: false, problems: [expect.stringContaining('바이트')] });
});

test('지시문 값: 체크리스트는 서버가 준 것만, 명세 버전이 없으면 QA 근거를 고정할 수 없다', () => {
  expect(checklistOf(qaJob).map(i => i.itemKey)).toEqual(['CL-1', 'CL-2']);
  expect(checklistOf(job('qa', { checklist: [{ content: '키 없음' }, 'x'] }))).toEqual([]);
  expect(specRevisionOf(qaJob)).toBe(3);
  expect(() => specRevisionOf(job('qa'))).toThrow('명세 버전');
});

test('안내문: 입력 사본 위치·형식·체크리스트를 알리고, 수정 요청은 한 번뿐임을 밝힌다', () => {
  expect(outputGuide(qaJob, '/srv/agentwbs/inputs/r/in-v1')).toMatch(/읽기 전용 사본: \/srv\/agentwbs\/inputs\/r\/in-v1[\s\S]*CL-1=수용 기준 \/ CL-2=오류 문구/);
  expect(outputGuide(job('dev'), null)).not.toContain('읽기 전용 사본');
  expect(fixPrompt(job('dev'), ['/summary must match'])).toContain('한 번뿐인 수정 요청');
});
