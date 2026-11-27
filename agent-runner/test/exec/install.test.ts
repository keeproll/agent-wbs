import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { installSubagents } from '../../src/exec/install.ts';

const roots: string[] = [];
const temp = async () => {
  const path = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'install-'));
  roots.push(path);
  return path;
};
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const file = '코드를 검토합니다.\n';
const def = { id: '00000000-0000-4000-8000-000000000001', key: 'code-reviewer', agent: 'Codex' as const, version: 2, file, sandbox: 'read-only', hash: createHash('sha256').update(file).digest('hex') };
const grade = { model: 'gpt-6.2-sol', effort: 'high' };

test('안정 키로 설치하고 서버 등급을 넣으며 원본 hash/버전을 보고한다', async () => {
  const cwd = await temp();
  expect(await installSubagents(cwd, 'Codex', { enabled: true, items: [def] }, grade)).toEqual([{ id: def.id, version: 2, hash: def.hash }]);
  const content = await readFile(join(cwd, '.codex/agents/code-reviewer.toml'), 'utf8');
  expect(content).toContain('name = "code-reviewer"');
  expect(content).toContain('model = "gpt-6.2-sol"');
  expect(content).toContain('model_reasoning_effort = "high"');
  expect(content).toContain('developer_instructions = "코드를 검토합니다.\\n');
});

test('Claude도 프로젝트 안에만 설치하고 등급을 채운다', async () => {
  const cwd = await temp();
  await installSubagents(cwd, 'Claude', { enabled: true, items: [{ ...def, agent: 'Claude' }] }, { model: 'claude-opus-5-5', effort: 'max' });
  expect(await readFile(join(cwd, '.claude/agents/code-reviewer.md'), 'utf8')).toContain('model: "claude-opus-5-5"\neffort: "max"');
});

test.each([{ hash: '0'.repeat(64) }, { version: 0 }, { key: '../../escape' }, { agent: 'Claude' }, { file: '바뀐 내용' }])('정의 불일치는 시작 전에 거부한다: %j', async change => {
  await expect(installSubagents(await temp(), 'Codex', { enabled: true, items: [{ ...def, ...change }] as typeof def[] }, grade)).rejects.toMatchObject({ code: 'SUBAGENT_INSTALL_FAILED' });
});

test('설치 경로 symlink를 따라 다른 폴더에 쓰지 않는다', async () => {
  const cwd = await temp(), outside = await temp();
  await mkdir(join(cwd, '.codex'));
  await symlink(outside, join(cwd, '.codex/agents'));
  await expect(installSubagents(cwd, 'Codex', { enabled: true, items: [def] }, grade)).rejects.toMatchObject({ code: 'SUBAGENT_INSTALL_FAILED' });
});

test('두 번째 정의가 기존 파일과 충돌해도 첫 번째 파일을 부분 설치하지 않는다', async () => {
  const cwd = await temp(), dir = join(cwd, '.codex/agents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'existing.toml'), '사용자 파일');
  await expect(installSubagents(cwd, 'Codex', { enabled: true, items: [def, { ...def, id: 'another', key: 'existing' }] }, grade)).rejects.toMatchObject({ code: 'SUBAGENT_INSTALL_FAILED' });
  await expect(readFile(join(dir, 'code-reviewer.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(dir, 'existing.toml'), 'utf8')).toBe('사용자 파일');
});

test('버전을 갱신하고 사용을 끄면 Runner가 설치한 파일만 지운다', async () => {
  const cwd = await temp(), dir = join(cwd, '.codex/agents');
  await installSubagents(cwd, 'Codex', { enabled: true, items: [def] }, grade);
  await writeFile(join(dir, 'user.toml'), '사용자 정의');
  await installSubagents(cwd, 'Codex', { enabled: true, items: [{ ...def, version: 3 }] }, { ...grade, effort: 'max' });
  expect(await readFile(join(dir, 'code-reviewer.toml'), 'utf8')).toContain('model_reasoning_effort = "max"');
  await installSubagents(cwd, 'Codex', { enabled: false, items: [] }, grade);
  await expect(readFile(join(dir, 'code-reviewer.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(dir, 'user.toml'), 'utf8')).toBe('사용자 정의');
  await expect(readFile(join(dir, '.awbs-installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('fix2 추가: Agent 계정 파일 접근(AgentFiles)을 주면 Runner는 작업 폴더에 직접 읽거나 쓰지 않는다', async () => {
  // 존재하지 않는 경로: Runner가 직접 접근하면 실패한다. 모든 접근이 files를 거쳐야 통과한다.
  const cwd = join(await temp(), 'no-such-worktree');
  const store = new Map<string, string>();
  const ops: string[] = [];
  const files = {
    kind: 'agent-account' as const,
    read: async (_cwd: string, rel: string) => { ops.push(`read ${rel}`); return store.get(rel); },
    write: async (_cwd: string, rel: string, text: string) => { ops.push(`write ${rel}`); store.set(rel, text); },
    remove: async (_cwd: string, rel: string) => { ops.push(`remove ${rel}`); store.delete(rel); },
  };
  await installSubagents(cwd, 'Codex', { enabled: true, items: [def] }, grade, files);
  expect(store.get('.codex/agents/code-reviewer.toml')).toContain('name = "code-reviewer"');
  // 실행을 마치면 같은 경로로 걷어 낸다(소유 hash 확인 뒤).
  await installSubagents(cwd, 'Codex', { enabled: false, items: [] }, grade, files);
  expect([...store.keys()]).toEqual([]);
  expect(ops).toEqual([
    'read .codex/agents/.awbs-installed.json', 'read .codex/agents/code-reviewer.toml',
    'write .codex/agents/.awbs-installed.json', 'write .codex/agents/code-reviewer.toml', 'write .codex/agents/.awbs-installed.json',
    'read .codex/agents/.awbs-installed.json', 'write .codex/agents/.awbs-installed.json',
    'read .codex/agents/code-reviewer.toml', 'remove .codex/agents/code-reviewer.toml', 'remove .codex/agents/.awbs-installed.json',
  ]);
  // Agent가 바꾼 정의는 덮어쓰거나 지우지 않는다(같은 소유 hash 규칙).
  store.set('.codex/agents/code-reviewer.toml', 'Agent가 바꿈');
  store.set('.codex/agents/.awbs-installed.json', JSON.stringify({ 'code-reviewer.toml': ['0'.repeat(64)] }));
  await expect(installSubagents(cwd, 'Codex', { enabled: true, items: [def] }, grade, files)).rejects.toMatchObject({ code: 'SUBAGENT_INSTALL_FAILED' });
});
