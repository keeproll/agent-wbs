import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, relative } from 'node:path';
import type { ApiResponse } from '../api/client.ts';
import type { Agent } from '../api/generated/client.ts';
import { APPROVED_EFFORTS } from '../cli/args.ts';
import type { AgentFiles } from '../git/agent-git.ts';
import { atomicWrite } from '../state/files.ts';

export type Definitions = ApiResponse<'getTaskSubagents'>['body'];
export class SubagentInstallError extends Error {
  readonly code = 'SUBAGENT_INSTALL_FAILED';
  constructor() { super('하위 Agent 정의·버전·hash·설치 경로를 확인하세요. 시도는 시작하지 않았습니다.'); }
}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** worktree 밖으로 나가는 심볼릭 링크는 따라가지 않는다. */
async function directory(path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of relative(current, path).split('/').filter(Boolean)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
    if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) throw new SubagentInstallError();
  }
}

/**
 * 같은 계정 배치(전용 계정 없음, 개발·시험)의 파일 접근. Agent도 Runner 계정이라 넘는 경계가 없다.
 * 전용 계정 배치에서는 쓰지 않는다: Execution이 래퍼 `agent-file`(Agent 계정, `wrapperAgentFiles`)을 받는다(fix2 추가).
 */
export const localAgentFiles: AgentFiles = {
  kind: 'same-account',
  async read(cwd, rel) {
    try { return await readFile(join(cwd, rel), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  },
  async write(cwd, rel, text) {
    const dir = join(cwd, rel, '..');
    await directory(dir);
    await atomicWrite(dir, rel.slice(rel.lastIndexOf('/') + 1), text);
  },
  async remove(cwd, rel) { await rm(join(cwd, rel), { force: true }); },
};

/**
 * file은 지시문 본문이다. hash는 등급을 채우기 전 UTF-8 바이트의 SHA-256(hex)이다(owner M5-02).
 * 파일 읽기·쓰기·지우기는 모두 `files`를 거친다. 전용 계정 배치에서는 Agent 계정이 한다(Runner는 Agent 폴더에 쓰지 않는다).
 */
export async function installSubagents(cwd: string, agent: Agent, defs: Definitions, grade: { model: string; effort: string }, files: AgentFiles = localAgentFiles): Promise<{ id: string; version: number; hash: string }[]> {
  try {
    if (!isAbsolute(cwd) || !grade.model || !APPROVED_EFFORTS.some(e => e === grade.effort)) throw new SubagentInstallError();
    const items = defs.enabled ? defs.items : [];
    if (new Set(items.map(d => d.key)).size !== items.length || new Set(items.map(d => d.id)).size !== items.length) throw new SubagentInstallError();
    for (const d of items) {
      if (d.agent !== agent || !/^[a-z][a-z0-9-]{0,63}$/.test(d.key) || !Number.isSafeInteger(d.version) || d.version < 1 || !/^[a-f0-9]{64}$/.test(d.hash) || hash(d.file) !== d.hash) throw new SubagentInstallError();
    }
    const dir = agent === 'Claude' ? '.claude/agents' : '.codex/agents';
    const at = (name: string) => `${dir}/${name}`;
    // 설치 목록은 Runner가 쓴 파일만 정리하는 데 쓴다. 저장소가 가진 다른 정의는 건드리지 않는다.
    const listed = await files.read(cwd, at('.awbs-installed.json'));
    const previous = (listed === undefined ? {} : JSON.parse(listed)) as Record<string, string[]>;
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new SubagentInstallError();
    for (const [name, digests] of Object.entries(previous)) {
      if (!/^[a-z][a-z0-9-]{0,63}\.(md|toml)$/.test(name) || !Array.isArray(digests) || !digests.length || !digests.every(d => /^[a-f0-9]{64}$/.test(d))) throw new SubagentInstallError();
    }
    const next: Record<string, string[]> = {}, texts: Record<string, string> = {}, pending = { ...previous };
    for (const d of items) {
      const name = `${d.key}.${agent === 'Claude' ? 'md' : 'toml'}`;
      const instructions = `${d.file}\n\n권한 지침: ${d.sandbox}`;
      const text = agent === 'Claude'
        ? `---\nname: ${JSON.stringify(d.key)}\ndescription: ${JSON.stringify(d.key)}\nmodel: ${JSON.stringify(grade.model)}\neffort: ${JSON.stringify(grade.effort)}\n---\n${instructions}\n`
        : `name = ${JSON.stringify(d.key)}\ndescription = ${JSON.stringify(d.key)}\nmodel = ${JSON.stringify(grade.model)}\nmodel_reasoning_effort = ${JSON.stringify(grade.effort)}\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`;
      // 기존 파일이 사용자 또는 Agent에 의해 바뀌었으면 덮어쓰지 않는다.
      const existing = await files.read(cwd, at(name));
      const current = existing === undefined ? undefined : hash(existing);
      if (current !== undefined && !previous[name]?.includes(current)) throw new SubagentInstallError();
      next[name] = [hash(text)];
      pending[name] = [...new Set([...(current ? [current] : []), hash(text)])];
      texts[name] = text;
    }
    // 파일 교체 전에 구·신 hash를 저장한다. 설치 중 꺼져도 자기 파일임을 확인하고 다시 설치할 수 있다.
    await files.write(cwd, at('.awbs-installed.json'), JSON.stringify(pending));
    for (const [name, text] of Object.entries(texts)) await files.write(cwd, at(name), text);
    for (const [name, digests] of Object.entries(previous)) {
      if (!(name in next)) {
        const existing = await files.read(cwd, at(name));
        if (existing === undefined) continue;
        if (!digests.includes(hash(existing))) throw new SubagentInstallError();
        await files.remove(cwd, at(name));
      }
    }
    if (Object.keys(next).length) await files.write(cwd, at('.awbs-installed.json'), JSON.stringify(next));
    else await files.remove(cwd, at('.awbs-installed.json'));
    return items.map(({ id, version, hash }) => ({ id, version, hash }));
  } catch { throw new SubagentInstallError(); }
}
