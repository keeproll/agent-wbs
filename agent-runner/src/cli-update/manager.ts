import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Agent } from '../api/generated/client.ts';
import { checkCliObservation, scheduleDaily, type ReadinessReport, type ReadinessItem } from '../readiness/checks.ts';
import { atomicWrite } from '../state/files.ts';

export interface Owner { hostId: string; bootId: string; runnerId: string }
export interface Activity extends Owner { children: number; held: number }
export interface CliRegistry {
  latest(agent: Agent): Promise<string>;
  install(agent: Agent, version: string, directory: string): Promise<void>;
  probe(agent: Agent, version: string, binary: string): Promise<void>;
}
interface Profile { agent: Agent; model: string; options: string }
export interface UpdateDeps {
  home: string;
  owner: Owner;
  registry: CliRegistry;
  activity(): Promise<readonly Activity[]>;
  profiles(): Profile[];
  verified(): (Profile & { version: string })[] | undefined;
  report(body: ReadinessReport): Promise<void>;
  /** obs 항목 뒤에 붙일 보조 설명(cgroup 노출). 준비 점검(M4-02)과 같은 문구를 쓰게 한다(M-1). 없으면 빈 문자열. */
  obsNote?: () => Promise<string>;
}

/**
 * Runner가 관리하는 전용 설치의 실행 파일 경로. 준비 점검(M4-02)·CLI 업데이트(M4-05)·세션 실행이 모두 이 경로 하나를 쓴다(M-1).
 * 왜: 전역 CLI의 정상 결과가 전용 설치의 실패를 덮어쓰면 새 실행을 잘못 허용한다.
 */
export function cliBinary(home: string, agent: Agent): string {
  const name = agent.toLowerCase();
  return join(home, 'cli', name, 'current', 'bin', name);
}

const AGENTS: Agent[] = ['Codex', 'Claude'];

/** latest의 안정판만 허용한다. 숫자를 문자로 비교하면 0.99 > 0.100이 되는 오류도 막는다. */
export function stableVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('안정판 버전 형식이 아닙니다.');
  }
}

function newer(a: string, b: string): boolean {
  const aa = a.split('.').map(BigInt);
  const bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i += 1) if (aa[i] !== bb[i]) return (aa[i] ?? 0n) > (bb[i] ?? 0n);
  return false;
}

/** State.open의 홈 잠금을 보유한 Runner가 하나씩 만든다. claim 등록부터 보유 저장까지 tryClaim의 해제를 늦춘다. */
export class CliUpdater {
  readonly #d: UpdateDeps;
  readonly #errors = new Map<Agent, string>();
  #updating = false;
  #claims = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(deps: UpdateDeps) {
    for (const id of [deps.owner.hostId, deps.owner.bootId, deps.owner.runnerId]) if (typeof id !== 'string' || !id.trim()) throw new Error('현재 PC·부팅·Runner 식별자가 필요합니다.');
    this.#d = deps;
  }

  /** 시작·매일 준비 점검. 세션 보유 해제 직후에는 실행 계층이 applyPending도 호출한다. */
  async start(onError: (error: unknown) => void): Promise<{ stop(): Promise<void> }> {
    await this.recover();
    return scheduleDaily(async () => { await this.check(); await this.applyPending(); }, { onError });
  }

  /** claim → 보유/프로세스 등록이 끝날 때까지 번호표를 보유한다. null이면 업데이트 뒤 다시 시도한다. */
  tryClaim(): (() => void) | null {
    if (this.#updating) return null;
    this.#claims += 1;
    let released = false;
    return () => { if (!released) { released = true; this.#claims -= 1; } };
  }

  check(): Promise<void> {
    return this.#queue(async () => {
      for (const agent of AGENTS) {
        try {
          await this.#ensureBase(agent);
          const latest = await this.#d.registry.latest(agent);
          stableVersion(latest);
          const current = await this.#current(agent);
          await this.#save(agent, !current || newer(latest, current) ? latest : null);
          this.#errors.delete(agent);
        } catch { this.#errors.set(agent, '최신 버전 확인 실패. 다음 확인 때 다시 시도합니다.'); }
      }
    });
  }

  applyPending(): Promise<void> {
    return this.#queue(async () => {
      if (this.#claims > 0 || !(await this.#idle())) { await this.#report(); return; }
      this.#updating = true;
      try {
        // 첫 확인과 잠금 사이에 claim이 들어올 수 있어 반드시 다시 대조한다.
        if (this.#claims === 0 && await this.#idle()) {
          for (const agent of AGENTS) {
            try { await this.#apply(agent); }
            catch { this.#errors.set(agent, '새 CLI 설치·점검 실패. 이전 버전을 보존하고 다음 확인 때 다시 시도합니다.'); }
          }
        }
        await this.#report();
      } finally { this.#updating = false; }
    });
  }

  /** 시작 시에만 호출한다. 링크를 바꾸기 전 남은 임시 파일만 지우며, 버전 폴더는 보존한다. */
  recover(): Promise<void> {
    return this.#queue(async () => {
      if (this.#claims > 0) throw new Error('claim 등록 중에는 시작 정리를 할 수 없습니다.');
      this.#updating = true;
      try {
        for (const agent of AGENTS) {
          const base = await this.#ensureBase(agent);
          for (const name of await readdir(base)) {
            if (name.startsWith('.install-') || name.startsWith('.current-') || name.endsWith('.tmp')) {
              await rm(join(base, name), { recursive: true, force: true });
            }
          }
        }
      } finally { this.#updating = false; }
    });
  }

  #queue(work: () => Promise<void>): Promise<void> {
    const operation = this.#tail.then(work);
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async #idle(): Promise<boolean> {
    const rows = await this.#d.activity();
    return rows.every((row) => {
      const own = row.hostId === this.#d.owner.hostId && row.bootId === this.#d.owner.bootId && row.runnerId === this.#d.owner.runnerId;
      return !own || (row.children === 0 && row.held === 0);
    });
  }

  #base(agent: Agent): string { return join(this.#d.home, 'cli', agent.toLowerCase()); }

  async #ensureBase(agent: Agent): Promise<string> {
    const root = join(this.#d.home, 'cli');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw new Error('CLI 루트는 실제 폴더여야 합니다.');
    const base = this.#base(agent);
    await mkdir(base, { recursive: true, mode: 0o700 });
    if (!(await lstat(base)).isDirectory()) throw new Error('CLI 설치 위치는 실제 폴더여야 합니다.');
    return base;
  }

  async #current(agent: Agent): Promise<string | null> {
    await this.#ensureBase(agent);
    try {
      const version = await readlink(join(this.#base(agent), 'current'));
      stableVersion(version);
      return version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async #pending(agent: Agent): Promise<string | null> {
    await this.#ensureBase(agent);
    try {
      const value: unknown = JSON.parse(await readFile(join(this.#base(agent), 'update.json'), 'utf8'));
      if (!value || typeof value !== 'object' || !('update_pending' in value)) throw new Error('업데이트 대기 기록이 올바르지 않습니다.');
      if (value.update_pending === null) return null;
      stableVersion(value.update_pending);
      return value.update_pending;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async #save(agent: Agent, version: string | null): Promise<void> {
    await atomicWrite(await this.#ensureBase(agent), 'update.json', JSON.stringify({ update_pending: version }));
  }

  async #probe(agent: Agent, version: string, directory = join(this.#base(agent), version)): Promise<void> {
    // 버전 폴더나 실행 파일이 사용자 전역 설치로 빠져나가면 점검도 실행하지 않는다.
    if ((await realpath(directory)) !== resolve(directory)) throw new Error('CLI 설치 경로가 다른 폴더를 가리킵니다.');
    const bin = join(directory, 'bin', agent.toLowerCase());
    if (!(await realpath(bin)).startsWith(`${resolve(directory)}${sep}`)) throw new Error('CLI 실행 파일이 설치 경계를 벗어났습니다.');
    await this.#d.registry.probe(agent, version, bin);
  }

  async #apply(agent: Agent): Promise<void> {
    const pending = await this.#pending(agent);
    if (!pending) return;
    const current = await this.#current(agent);
    if (current && !newer(pending, current)) { await this.#save(agent, null); return; }
    const base = this.#base(agent);
    const versionDir = join(base, pending);
    const stage = join(base, `.install-${randomUUID()}`);
    const link = join(base, `.current-${randomUUID()}`);
    try {
      const exists = await lstat(versionDir).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
      if (!exists) {
        await mkdir(stage, { mode: 0o700 });
        await this.#d.registry.install(agent, pending, stage);
        await this.#probe(agent, pending, stage);
        await rename(stage, versionDir);
      } else { await this.#probe(agent, pending); }
      await symlink(pending, link);
      await rename(link, join(base, 'current'));
      const directory = await open(base, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      await this.#save(agent, null);
      this.#errors.delete(agent);
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(link, { force: true });
    }
  }

  async #report(): Promise<void> {
    const versions = new Map<Agent, string>();
    const items: ReadinessItem[] = [];
    for (const agent of AGENTS) {
      try {
        const version = await this.#current(agent);
        if (!version) throw new Error('설치된 CLI가 없습니다.');
        await this.#probe(agent, version);
        versions.set(agent, version);
        let pending: string | null = null;
        try { pending = await this.#pending(agent); }
        catch { this.#errors.set(agent, '업데이트 대기 기록 오류. 기존 CLI를 유지하며 다음 확인 때 다시 시도합니다.'); }
        const warning = this.#errors.get(agent);
        items.push({ key: agent === 'Codex' ? 'codex' : 'claude', status: pending || warning ? 'warn' : 'ok',
          detail: `버전 ${version}${pending ? ` · 업데이트 대기 ${pending}` : ''}${warning ? ` · ${warning}` : ''}` });
      } catch {
        items.push({ key: agent === 'Codex' ? 'codex' : 'claude', status: 'fail', detail: '현재 CLI 실행·점검 불가. 이 Agent의 새 실행을 멈춥니다.', fix: 'CLI 설치·로그인 상태를 확인하세요.' });
      }
    }
    const profiles = this.#d.profiles();
    const note = await (this.#d.obsNote?.() ?? Promise.resolve('')).catch(() => '');
    items.push({ key: 'obs', ...checkCliObservation(profiles, this.#d.verified(), versions, note) });
    const cli = profiles.flatMap((p) => { const version = versions.get(p.agent); return version ? [{ ...p, version }] : []; });
    await this.#d.report({ at: new Date().toISOString(), items, ...(cli.length > 0 && { cli }) });
  }
}
