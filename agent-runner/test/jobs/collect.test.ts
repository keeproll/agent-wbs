// 결과 수집기(contracts §5): 스키마 검사·1회 수정 요청·git diff 변경 파일·Evidence 업로드·QA 근거 고정·청결 재확인.
import { execFileSync } from 'node:child_process';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ApiClient, ApiRequest } from '../../src/api/client.ts';
import type { Runner } from '../../src/api/runner.ts';
import type { AttemptJob, AttemptOutput, Execution } from '../../src/exec/session.ts';
import { bindCollect, CollectError, FORMAT_FAILURE, followUpFailure } from '../../src/jobs/collect.ts';
import { createWorkspace } from '../../src/jobs/workspace.ts';
import { State } from '../../src/state/state.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { readdir, readFile } from 'node:fs/promises';
import { commit, file, fixture, git } from '../ci/int-fixture.ts';

const BRANCH = 'agent/TASK-0001-h1';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async () => {
  for (const name of await f.repo.inputIds().catch(() => [])) await f.repo.removeInput(name).catch(() => undefined);
  await f.close();
});

const job = (kind: AttemptJob['payload']['kind'], baseCommit: string): AttemptJob => ({
  id: 'job-1', fence: 7, leaseUntil: '2026-11-28T00:00:00Z', kind: 'attempt',
  payload: { taskKey: 'TASK-0001', kind, agent: 'Claude', branch: BRANCH, baseCommit, inputVersion: 1,
    instructions: { revision: 4, checklist: [{ itemKey: 'CL-1', content: '결과 파일' }] } },
});
const dev = { summary: '결과 파일을 만들었습니다', selfCheck: ['확인'], followups: ['문서 보강'], designItems: [] };
const qa = (verdict = 'PASS') => ({ verdict, criteria: [{ acId: 'CL-1', result: verdict, cmd: 'cat src/result.ts', expected: '있음', actual: '있음', evidence: ['log.txt'] }],
  defects: verdict === 'FAIL' ? [{ text: '부족', blocking: true }] : [] });

async function setup(followUps: string[] = []) {
  f = await fixture(BRANCH);
  git(f.remote, 'update-ref', '-d', `refs/heads/${BRANCH}`);
  const base = f.ref('main');
  const workspace = createWorkspace({ repo: async () => f.repo });
  const calls: { operation: string; request: { body?: Record<string, unknown> } }[] = [];
  const api = (async (operation: string, request: { body?: Record<string, unknown> }) => {
    calls.push({ operation, request });
    return { status: 201, body: { id: `ev-${String(calls.length)}` } };
  }) as unknown as ApiClient;
  const runner = { outbox: { enqueue: async () => ({ request: { idempotencyKey: 'att:a:k' } }) } } as unknown as Runner;
  const asked: string[] = [];
  const execution = { followUp: async (_job: AttemptJob, _epoch: number, _output: AttemptOutput, prompt: string) => {
    asked.push(prompt);
    const text = followUps.shift();
    return text === undefined ? { ok: false, code: 1, text: '' } : { ok: true, code: 0, text };
  } } as unknown as Execution;
  const collect = bindCollect({ api, runner, execution, workspace, repo: async () => f.repo });
  /** 개발 시도를 흉내 낸다: 폴더 준비 → Agent 커밋 → ①처럼 결과를 가져온다. */
  const develop = async () => {
    const work = await workspace.prepare(job('dev', base));
    await file(join(work.cwd, 'src/result.ts'), 'export const result = true;\n');
    commit(work.cwd);
    const ids = workspace.worktree(job('dev', base));
    return { work, head: await f.repo.importWorktree(ids.id, ids.branch) };
  };
  const context = (kind: AttemptJob['payload']['kind'], text: string, cwd: string, headSha: string) => ({
    job: job(kind, base), epoch: 1, signal: new AbortController().signal, messages: [] as Parameters<typeof collect>[0]['messages'],
    output: { attemptId: 'a', cwd, headSha, text, sessionId: 's', grade: { model: 'm', effort: 'high' } } as unknown as AttemptOutput,
  });
  return { base, workspace, collect, calls, asked, develop, context };
}

test('개발: 변경 파일은 자기보고가 아니라 Runner bare의 git diff이고, 검증한 종료 메시지를 Evidence로 먼저 올린다', async () => {
  const t = await setup();
  const { work, head } = await t.develop();
  const result = await t.collect(t.context('dev', JSON.stringify(dev), work.cwd, work.headSha));
  expect(result).toEqual({ report: { summary: dev.summary, changedFiles: ['src/result.ts'], evidence: ['ev-1'] }, responses: [] });
  expect(t.asked).toEqual([]);
  const upload = t.calls[0];
  expect(upload?.operation).toBe('uploadEvidence');
  expect(upload?.request.body).toMatchObject({ kind: 'dev-report', fence: 7 });
  const sent = JSON.parse(await (upload?.request.body?.file as Blob).text()) as Record<string, unknown>;
  expect(sent).toMatchObject({ headSha: head, changedFiles: ['src/result.ts'], followups: ['문서 보강'] });
});

test('Agent의 summary·응답·selfCheck·followups는 보고·증거·outbox 파일에 비밀을 남기지 않는다', async () => {
  const t = await setup();
  const { work } = await t.develop();
  const secret = `github_pat_${'reviewcanary'.repeat(4)}`;
  const output = { ...dev, summary: `완료 ${secret}`, selfCheck: [`확인 ${secret}`], followups: [`후속 ${secret}`],
    responses: [{ messageId: 'message-1', text: `응답 ${secret}`, workState: `진행 ${secret}` }] };
  const context = t.context('dev', JSON.stringify(output), work.cwd, work.headSha);
  context.messages = [{ id: 'message-1' }] as typeof context.messages;
  const result = await t.collect(context);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.report.summary).toContain('완료');
  const state = await State.open(join(f.root, 'outbox-home'));
  try {
    await state.update(s => { s.epoch = 1; });
    const outbox = new Outbox(state, (async () => { throw new Error('전송하지 않는다'); }) as ApiClient);
    await outbox.enqueue('reportAttemptResult', { epoch: 1, params: { attemptId: 'attempt-1' }, body: { ...result.report, fence: 7 } });
    for (const call of t.calls) {
      const blob = call.request.body?.file as Blob;
      expect(await blob.text()).not.toContain(secret);
      await outbox.enqueue('uploadEvidence', { epoch: 1, params: { attemptId: 'attempt-1' },
        body: call.request.body as ApiRequest<'uploadEvidence'>['body'] });
    }
    for (const relative of await readdir(join(f.root, 'outbox-home'), { recursive: true })) {
      const bytes = await readFile(join(f.root, 'outbox-home', relative)).catch(e => { if (e.code === 'EISDIR') return Buffer.alloc(0); throw e; });
      expect(bytes.toString()).not.toContain(secret);
    }
  } finally { await state.close(); }
});

test('Git에서 관측한 파일 경로에 비밀이 있으면 다른 경로로 가려 보고하지 않는다', async () => {
  const t = await setup();
  const { work } = await t.develop();
  const secret = `github_pat_${'pathcanary'.repeat(5)}`;
  await file(join(work.cwd, `${secret}.txt`), '결과');
  commit(work.cwd);
  const ids = t.workspace.worktree(job('dev', t.base));
  await f.repo.importWorktree(ids.id, ids.branch);
  await expect(t.collect(t.context('dev', JSON.stringify(dev), work.cwd, work.headSha))).rejects.toBeInstanceOf(CollectError);
  expect(t.calls).toEqual([]);
});

test('QA 증거 파일 이름에 비밀이 있으면 업로드 전에 거부한다', async () => {
  const t = await setup();
  await t.develop();
  const work = await t.workspace.prepare(job('qa', t.base));
  const name = `github_pat_${'evidencepath'.repeat(4)}.txt`;
  await writeFile(join(work.cwd, '.awbs-evidence', name), '증거');
  const output = { ...qa(), criteria: [{ ...qa().criteria[0], evidence: [name] }] };
  await expect(t.collect(t.context('qa', JSON.stringify(output), work.cwd, work.headSha))).rejects.toBeInstanceOf(CollectError);
  expect(t.calls).toEqual([]);
});

test('형식 오류면 같은 세션에 한 번만 수정 요청하고, 고친 결과를 쓴다', async () => {
  const t = await setup([JSON.stringify(dev)]);
  const { work } = await t.develop();
  const result = await t.collect(t.context('dev', '작업 끝', work.cwd, work.headSha));
  expect(t.asked).toHaveLength(1);
  expect(t.asked[0]).toContain('한 번뿐인 수정 요청');
  expect(result.report).toMatchObject({ summary: dev.summary, changedFiles: ['src/result.ts'] });
});

test('수정 요청 뒤에도 틀리면 개발 시도는 failure로 보고하고 더 묻지 않는다', async () => {
  const t = await setup(['{"summary":""}']);
  const { work } = await t.develop();
  const result = await t.collect(t.context('dev', '작업 끝', work.cwd, work.headSha));
  expect(t.asked).toHaveLength(1);
  expect(result.report).toMatchObject({ failure: FORMAT_FAILURE, changedFiles: ['src/result.ts'], evidence: ['ev-1'] });
  expect(t.calls[0]?.request.body).toMatchObject({ kind: 'agent-output-invalid' });
});

test('수정 요청 세션이 커밋을 바꾸면 검사하지 않은 코드이므로 결과를 만들지 않는다', async () => {
  const t = await setup();
  const { work } = await t.develop();
  const changing = bindCollect({ api: (async () => ({ status: 201, body: { id: 'e' } })) as unknown as ApiClient,
    runner: { outbox: { enqueue: async () => ({ request: { idempotencyKey: 'k' } }) } } as unknown as Runner,
    execution: { followUp: async () => { await file(join(work.cwd, 'src/more.ts'), 'x'); commit(work.cwd); return { ok: true, code: 0, text: JSON.stringify(dev) }; } } as unknown as Execution,
    workspace: t.workspace, repo: async () => f.repo });
  await expect(changing(t.context('dev', '작업 끝', work.cwd, work.headSha))).rejects.toBeInstanceOf(CollectError);
});

test('QA: headSha는 준비 때 고정한 커밋, specRevision은 지시문의 명세 버전이고 체크리스트는 서버 키로만 보고한다', async () => {
  const t = await setup();
  const { head } = await t.develop();
  const prepared = await t.workspace.prepare(job('qa', t.base));
  // QA가 증거 폴더에 로그를 남긴다. 청결 확인에서는 빠진다.
  await writeFile(join(prepared.cwd, '.awbs-evidence', 'log.txt'), '통과 로그\n');
  const result = await t.collect(t.context('qa', JSON.stringify(qa()), prepared.cwd, prepared.headSha));
  expect(prepared.headSha).toBe(head);
  expect(result.report).toMatchObject({ changedFiles: [], evidence: ['ev-1', 'ev-2'], verification: {
    headSha: head, specRevision: 4, result: 'PASS', defects: [],
    checklist: [{ itemKey: 'CL-1', done: true, evidence: 'ev-2', note: '증거 파일: log.txt' }] } });
  expect(t.calls[0]?.request.body).toMatchObject({ kind: 'qa-report' });
  expect(t.calls[1]?.request.body).toMatchObject({ kind: 'agent-evidence', size: Buffer.byteLength('통과 로그\n') });
  expect(await (t.calls[1]?.request.body?.file as Blob).text()).toBe('통과 로그\n');
  expect((t.calls[1]?.request.body?.file as Blob).type).toBe('text/plain');
});

test('QA의 검증 문장·결함·텍스트 증거도 보고와 업로드 전에 가린다', async () => {
  const t = await setup();
  await t.develop();
  const prepared = await t.workspace.prepare(job('qa', t.base));
  const secret = `github_pat_${'qacanary'.repeat(6)}`;
  await writeFile(join(prepared.cwd, '.awbs-evidence', 'log.txt'), `출력 ${secret}`);
  const output = { verdict: 'FAIL', criteria: [{ acId: 'CL-1', result: 'FAIL', cmd: `검사 ${secret}`, expected: secret, actual: secret, evidence: ['log.txt'] }],
    defects: [{ text: secret, blocking: true }] };
  const result = await t.collect(t.context('qa', JSON.stringify(output), prepared.cwd, prepared.headSha));
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(t.calls).toHaveLength(2);
  for (const call of t.calls) expect(await (call.request.body?.file as Blob).text()).not.toContain(secret);
});

test('QA: 적힌 증거 파일이 없으면 형식 오류로 세어 한 번 수정 요청하고, 링크로 바꾼 증거는 받지 않는다', async () => {
  const t = await setup([JSON.stringify({ ...qa(), criteria: [{ ...qa().criteria[0], evidence: [] }] })]);
  await t.develop();
  const prepared = await t.workspace.prepare(job('qa', t.base));
  const result = await t.collect(t.context('qa', JSON.stringify(qa()), prepared.cwd, prepared.headSha));
  expect(t.asked).toHaveLength(1);
  expect(t.asked[0]).toContain('증거 파일 log.txt');
  expect(result.report.evidence).toEqual(['ev-1']);
});

test('QA: 링크·일반 파일이 아닌 증거는 받지 않고 형식 문제로 세어 수정 요청한다(시도 중단 아님, 방어 점검 P3-3)', async () => {
  const fixedOutput = JSON.stringify({ ...qa(), criteria: [{ ...qa().criteria[0], evidence: [] }] });
  const t = await setup([fixedOutput, fixedOutput]);
  await t.develop();
  const prepared = await t.workspace.prepare(job('qa', t.base));
  const secret = join(f.root, 'runner-secret');
  await writeFile(secret, 'token');
  await symlink(secret, join(prepared.cwd, '.awbs-evidence', 'log.txt'));
  const linked = await t.collect(t.context('qa', JSON.stringify(qa()), prepared.cwd, prepared.headSha));
  expect(t.asked[0]).toContain('증거 파일 log.txt을 받을 수 없습니다(링크이거나 일반 파일이 아님)');
  expect(linked.report.evidence).toEqual(['ev-1']);
  await rm(join(prepared.cwd, '.awbs-evidence', 'log.txt'));
  execFileSync('mkfifo', [join(prepared.cwd, '.awbs-evidence', 'log.txt')]);
  await t.collect(t.context('qa', JSON.stringify(qa()), prepared.cwd, prepared.headSha));
  expect(t.asked[1]).toContain('증거 파일 log.txt을 받을 수 없습니다(일반 파일이 아님)');
  // Runner 파일 내용은 어디에도 올라가지 않았다.
  for (const call of t.calls) expect(await (call.request.body?.file as Blob).text()).not.toContain('token');
});

test('수정 요청 실행 자체가 실패하면 「형식 오류」가 아니라 「수정 요청 실행 실패」로 적는다(방어 점검 P3-1)', async () => {
  const t = await setup();
  const { work } = await t.develop();
  const result = await t.collect(t.context('dev', '작업 끝', work.cwd, work.headSha));
  expect(result.report).toMatchObject({ summary: '형식 수정 요청 실행 실패', failure: followUpFailure(1) });
  expect(result.report.failure).not.toBe(FORMAT_FAILURE);
  await t.workspace.prepare(job('qa', t.base));
  await expect(t.collect(t.context('qa', '판정 없음', work.cwd, work.headSha))).rejects.toThrow('형식 수정 요청 실행 실패');
});

test('QA: 끝난 폴더가 더럽거나, 형식이 끝내 틀리면 판정을 지어내지 않고 멈춘다', async () => {
  const t = await setup(['여전히 판정 없음']);
  await t.develop();
  const prepared = await t.workspace.prepare(job('qa', t.base));
  await writeFile(join(prepared.cwd, '.awbs-evidence', 'log.txt'), '로그');
  await writeFile(join(prepared.cwd, 'note.txt'), 'QA가 남긴 파일');
  await expect(t.collect(t.context('qa', JSON.stringify(qa()), prepared.cwd, prepared.headSha))).rejects.toThrow('커밋하지 않은 변경');
  await expect(t.collect(t.context('reverify', '판정 없음', prepared.cwd, prepared.headSha))).rejects.toThrow(FORMAT_FAILURE);
  expect(t.asked).toHaveLength(1);
  expect(t.calls).toEqual([]);
});
