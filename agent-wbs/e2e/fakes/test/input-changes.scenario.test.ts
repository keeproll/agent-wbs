import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { InputChangeReporter } from '../../../../agent-runner/src/git/inputs.ts';
import { GitRepository } from '../../../../agent-runner/src/git/repository.ts';
import { scenario, type Scenario } from './scenario.ts';

/*
 * M2 통합: Runner의 입력 변경 보고(M2-03 새 계약)를 실제 git 저장소·실제 서버 원장으로 확인한다.
 * Runner 쪽은 agent-runner의 GitRepository.inputObservation과 InputChangeReporter를 그대로 쓴다.
 * - 트리 차이(이름 변경·실행 권한·추가)와 전후 모드가 서버 검사(상태와 blob·모드 짝, 이전 blob 대조)를 통과한다.
 * - 재시작한 Runner(서버 head를 모름)는 409의 head로 다시 계산해 보낸다.
 * - 실행 권한만 바뀐 보고는 head만 옮긴다(팀장 확인 항목 없음).
 * - 이력 재작성은 서버가 받지 않고 경고를 남기며, Runner는 같은 base로 다시 보내지 않는다.
 */
let h: Scenario;
let root: string;
let source: string;
let repo: GitRepository;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=입력 작성자', '-c', 'user.email=input@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
  }).trim();
}
async function put(path: string, text: string) { await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), text); }
function push(message: string) { git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', message); git(source, 'push', '-q', '-f', 'origin', 'main'); return git(source, 'rev-parse', 'HEAD'); }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'input-scenario-'));
  source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  await put('prototype/docs/guide.md', '안내\n');
  await put('prototype/run.sh', 'echo 시험\n');
  await put('src/app.ts', 'export {};\n');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(source, 'remote', 'add', 'origin', remote);
  const registered = push('등록 기준');
  // 서버 입력 v1(등록 커밋)을 이 저장소의 첫 커밋으로 둔다.
  h = await scenario({ inputCommit: registered });
  repo = await GitRepository.clone(join(root, 'runner'), 'project', remote);
});
afterEach(async () => { await h?.close(); await rm(root, { recursive: true, force: true }); });

const gitSource = () => ({ fetch: () => repo.fetch({ allowRewrite: true }), inputObservation: (base: string, head: string) => repo.inputObservation(base, head) });

test('입력 변경 보고: 트리 차이·모드, 재시작 뒤 409 재계산, 실행 권한만 바뀐 보고, 이력 재작성 중단', async () => {
  const warnings: string[] = [];
  const reporter = new InputChangeReporter({ api: h.runner.api, epoch: () => 1, warn: (m) => warnings.push(m) });
  const registered = await repo.fetch();
  // 1) 변화 없음: head 자신을 base로 물어 서버 head와 같으므로 그대로 받는다.
  expect(await reporter.report(gitSource())).toEqual({ head: registered, recorded: false, historyRewritten: false });

  // 2) 이름 변경 + 새 파일: 팀장 확인 항목이 생긴다.
  git(source, 'mv', 'prototype/docs/guide.md', 'prototype/docs/manual.md');
  await put('prototype/docs/new.md', '새 문서\n');
  await put('src/app.ts', 'export const x = 1;\n');
  const changed = push('입력 수정');
  expect(await reporter.report(gitSource())).toEqual({ head: changed, recorded: true, historyRewritten: false });
  const [stored] = await h.rows(`select files->'changes' as changes,state from input_change_commits where sha='${changed}'`) as { changes: { status: string; path: string; from?: string }[]; state: string }[];
  expect(stored?.state).toBe('pending');
  expect(stored?.changes.map((c) => [c.status, c.path, c.from ?? null])).toEqual([['R', 'prototype/docs/manual.md', 'prototype/docs/guide.md'], ['A', 'prototype/docs/new.md', null]]);

  // 3) 재시작한 Runner(서버 head를 모름): 새 head로 물으면 409, 응답 head로 다시 계산해 보낸다.
  await chmod(join(source, 'prototype/run.sh'), 0o755);
  const modeOnly = push('실행 권한');
  const restarted = new InputChangeReporter({ api: h.runner.api, epoch: () => 1, warn: (m) => warnings.push(m) });
  expect(await restarted.report(gitSource())).toEqual({ head: modeOnly, recorded: false, historyRewritten: false });
  const [mode] = await h.rows(`select files->'changes' as changes,state from input_change_commits where sha='${modeOnly}'`) as { changes: { status: string; oldMode: string; newMode: string }[]; state: string }[];
  // 실행 권한만 바뀐 보고: head·트리만 옮기고 팀장 확인 항목은 만들지 않는다(analyzed).
  expect(mode).toEqual({ state: 'analyzed', changes: [expect.objectContaining({ status: 'M', oldMode: '100644', newMode: '100755' })] });

  // 4) 이력 재작성: 서버는 받지 않고 경고, Runner는 같은 base로 다시 보내지 않는다.
  git(source, 'reset', '-q', '--hard', registered);
  await put('prototype/docs/other.md', '다른 이력\n');
  const rewritten = push('재작성');
  expect(await restarted.report(gitSource())).toEqual({ head: modeOnly, recorded: false, historyRewritten: true });
  expect(await h.rows("select key,severity from alerts where key='input_history_rewritten'")).toEqual([{ key: 'input_history_rewritten', severity: 'error' }]);
  expect(await restarted.report(gitSource())).toEqual({ skipped: 'history_rewritten' });
  expect(warnings.some((m) => m.includes('이력 재작성'))).toBe(true);
  expect(rewritten).not.toBe(modeOnly);
});
