import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, relative } from 'node:path';
import type { ApiResponse } from '../api/client.ts';
import type { Agent } from '../api/generated/client.ts';
import { APPROVED_EFFORTS } from '../cli/args.ts';
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

/** file은 지시문 본문이다. hash는 등급을 채우기 전 UTF-8 바이트의 SHA-256(hex)이다(owner M5-02). */
export async function installSubagents(cwd: string, agent: Agent, defs: Definitions, grade: { model: string; effort: string }): Promise<{ id: string; version: number; hash: string }[]> {
  try {
    if (!isAbsolute(cwd) || !grade.model || !APPROVED_EFFORTS.some(e => e === grade.effort)) throw new SubagentInstallError();
    const items = defs.enabled ? defs.items : [];
    if (new Set(items.map(d => d.key)).size !== items.length || new Set(items.map(d => d.id)).size !== items.length) throw new SubagentInstallError();
    for (const d of items) {
      if (d.agent !== agent || !/^[a-z][a-z0-9-]{0,63}$/.test(d.key) || !Number.isSafeInteger(d.version) || d.version < 1 || !/^[a-f0-9]{64}$/.test(d.hash) || hash(d.file) !== d.hash) throw new SubagentInstallError();
    }
    const dir = join(cwd, agent === 'Claude' ? '.claude/agents' : '.codex/agents');
    await directory(dir);
    // 설치 목록은 Runner가 쓴 파일만 정리하는 데 쓴다. 저장소가 가진 다른 정의는 건드리지 않는다.
    let previous: Record<string, string[]> = {};
    try { previous = JSON.parse(await readFile(join(dir, '.awbs-installed.json'), 'utf8')) as Record<string, string[]>; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (const [name, digests] of Object.entries(previous)) {
      if (!/^[a-z][a-z0-9-]{0,63}\.(md|toml)$/.test(name) || !Array.isArray(digests) || !digests.length || !digests.every(d => /^[a-f0-9]{64}$/.test(d))) throw new SubagentInstallError();
    }
    const next: Record<string, string[]> = {}, files: Record<string, string> = {}, pending = { ...previous };
    for (const d of items) {
      const name = `${d.key}.${agent === 'Claude' ? 'md' : 'toml'}`;
      const instructions = `${d.file}\n\n권한 지침: ${d.sandbox}`;
      const text = agent === 'Claude'
        ? `---\nname: ${JSON.stringify(d.key)}\ndescription: ${JSON.stringify(d.key)}\nmodel: ${JSON.stringify(grade.model)}\neffort: ${JSON.stringify(grade.effort)}\n---\n${instructions}\n`
        : `name = ${JSON.stringify(d.key)}\ndescription = ${JSON.stringify(d.key)}\nmodel = ${JSON.stringify(grade.model)}\nmodel_reasoning_effort = ${JSON.stringify(grade.effort)}\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`;
      // 기존 파일이 사용자 또는 Agent에 의해 바뀌었으면 덮어쓰지 않는다.
      let current: string | undefined;
      try { current = hash(await readFile(join(dir, name), 'utf8')); if (!previous[name]?.includes(current)) throw new SubagentInstallError(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      next[name] = [hash(text)];
      pending[name] = [...new Set([...(current ? [current] : []), hash(text)])];
      files[name] = text;
    }
    // 파일 교체 전에 구·신 hash를 저장한다. 설치 중 꺼져도 자기 파일임을 확인하고 다시 설치할 수 있다.
    await atomicWrite(dir, '.awbs-installed.json', JSON.stringify(pending));
    for (const [name, text] of Object.entries(files)) await atomicWrite(dir, name, text);
    for (const [name, digests] of Object.entries(previous)) {
      if (!(name in next)) {
        try {
          if (!digests.includes(hash(await readFile(join(dir, name), 'utf8')))) throw new SubagentInstallError();
          await rm(join(dir, name));
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
    }
    await atomicWrite(dir, '.awbs-installed.json', JSON.stringify(next));
    return items.map(({ id, version, hash }) => ({ id, version, hash }));
  } catch { throw new SubagentInstallError(); }
}
