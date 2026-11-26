import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 실제 git으로 입력 변경 관측을 만든다(M2-03 FIX5 리뷰 N3 회귀 검사용).
 * 계약(reportInputChanges)의 Runner 계산을 그대로 따른다:
 *   changes  = git diff --raw -M --numstat <base> <head> -- prototype/
 *   treeHash = git rev-parse <head>:prototype
 *   baseIsAncestor = git merge-base --is-ancestor <base> <head> 종료 코드
 */

export interface GitChange {
  status: 'A' | 'M' | 'D' | 'R' | 'T'; path: string; from?: string;
  oldBlob: string | null; newBlob: string | null; oldMode: string | null; newMode: string | null; added: number; deleted: number;
}

const ZERO_SHA = /^0+$/;
const nullSha = (sha: string) => (ZERO_SHA.test(sha) ? null : sha);
const nullMode = (mode: string) => (mode === '000000' ? null : mode);

export class GitRepo {
  readonly dir = mkdtempSync(join(tmpdir(), 'awbs-m203-git-'));
  constructor() { this.git('init', '-q', '-b', 'main'); }
  git(...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.fileMode=true', '-C', this.dir, ...args], { encoding: 'utf8' });
  }
  sh(command: string) { execFileSync('sh', ['-c', command], { cwd: this.dir }); }
  commit(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }
  isAncestor(base: string, head: string): boolean {
    const r = spawnSync('git', ['-C', this.dir, 'merge-base', '--is-ancestor', base, head]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw new Error(`merge-base 실패: ${String(r.status)}`);
  }
  /** `git diff --raw -M -z`와 `--numstat -z`를 계약 모양으로 합친다. */
  diff(base: string, head: string): GitChange[] {
    const raw = this.git('diff', '--raw', '-M', '--no-abbrev', '-z', base, head, '--', 'prototype/').split('\0').filter((x, i, a) => i < a.length - 1 || x);
    const numstat = this.git('diff', '--numstat', '-M', '-z', base, head, '--', 'prototype/').split('\0');
    const lines = new Map<string, { added: number; deleted: number }>();
    for (let i = 0; i < numstat.length; i++) {
      const head0 = numstat[i];
      if (!head0) continue;
      const [a = '0', d = '0', path = ''] = head0.split('\t');
      const count = { added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d) };
      if (path) lines.set(path, count);
      else { i += 2; lines.set(numstat[i] ?? '', count); } // 이름 변경: 빈 경로 뒤에 이전·새 경로
    }
    const out: GitChange[] = [];
    for (let i = 0; i < raw.length; i++) {
      const meta = raw[i] ?? '';
      if (!meta.startsWith(':')) continue;
      const [oldMode = '', newMode = '', oldBlob = '', newBlob = '', status = ''] = meta.slice(1).split(' ');
      const kind = status[0] as GitChange['status'];
      const base0 = { oldBlob: nullSha(oldBlob), newBlob: nullSha(newBlob), oldMode: nullMode(oldMode), newMode: nullMode(newMode) };
      if (kind === 'R') {
        const from = raw[++i] ?? '';
        const path = raw[++i] ?? '';
        out.push({ status: 'R', path, from, ...base0, ...(lines.get(path) ?? { added: 0, deleted: 0 }) });
      } else {
        const path = raw[++i] ?? '';
        out.push({ status: kind, path, ...base0, ...(lines.get(path) ?? { added: 0, deleted: 0 }) });
      }
    }
    return out;
  }
  observe(base: string, head: string) {
    return { base, head, baseIsAncestor: this.isAncestor(base, head), treeHash: this.git('rev-parse', `${head}:prototype`).trim(), changes: this.diff(base, head), commits: [] };
  }
  dispose() { rmSync(this.dir, { recursive: true, force: true }); }
}
