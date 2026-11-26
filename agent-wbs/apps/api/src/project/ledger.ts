/*
 * 입력 커밋 원장(ledger) — 입력 변경 감지·「분석 안 함」·「이 버전으로 분석」의 순서 규칙을 한 곳에 둔다.
 *
 * 순서는 서버가 계산하지 않고 git이 정한다(M2-03 FIX3 리뷰 D1~D3).
 * - 원장은 「입력 사슬(chain)」 하나다. 시작은 등록 커밋(v1)이고, 끝(head)은 마지막으로 받은 보고의 main 끝 커밋이다.
 * - Runner는 head를 base로 삼아 `git rev-list --first-parent --reverse <base>..<main> -- prototype/`로 구한
 *   새 입력 커밋 목록과 그때의 main 끝(head)을 보낸다. 서버는 base가 지금 head와 같을 때만 목록을 받은 순서대로
 *   붙이고 head를 옮긴다(비교 후 추가). 다르면 붙이지 않고 지금 head를 알려 준다(stale). Runner는 그 head로 다시 계산한다.
 * - 입력 버전으로 고정하는 커밋은 목록의 커밋이 아니라 head다. merge로 들어온 feature 커밋은 이전 버전의 자손이
 *   아닐 수 있지만, head는 언제나 base의 자손(baseIsAncestor)이라 버전이 앞으로만 간다.
 * - base가 main의 조상이 아니면(금지된 이력 재작성) 붙이지 않는다(rewritten → 팀장 경고).
 *
 * 그래서 불변식이 구조로 성립한다.
 *   입력 버전은 사슬 순서대로만 증가하고(사슬의 뒤 커밋은 앞 커밋의 자손), 확정 커밋 이전의 커밋은
 *   pending·skipped와 관계없이 확정 범위에 들어가 분석 대상에서 빠진다.
 * 이전의 도착 순서 추측(seq)과 depth(첫 부모 깊이) 비교는 merge·얕은 clone·지연 보고에서 깨졌다.
 */

export type CommitState = 'pending' | 'skipped' | 'analyzed';
export interface LedgerCommit {
  sha: string;
  /** 사슬 안 위치(1부터, 붙인 순서 = git first-parent 순서) */
  pos: number;
  /** 이 커밋을 실어 온 보고의 main 끝 커밋 */
  head: string;
  state: CommitState;
  version: number | null;
}
export interface LedgerVersion { v: number; sha: string }
export interface Ledger { versions: readonly LedgerVersion[]; commits: readonly LedgerCommit[] }
export interface ChainReport { base: string; head: string; baseIsAncestor: boolean; commits: readonly { sha: string; hasInput: boolean }[] }
export interface LedgerError { path: string; rule: string; message: string }
export type ReceiveResult =
  | { kind: 'ok'; ledger: Ledger; head: string; appended: number }
  | { kind: 'stale'; head: string }
  | { kind: 'rewritten'; head: string }
  | { kind: 'invalid'; error: LedgerError };

/** 사슬의 끝 = 마지막으로 붙인 보고의 main 끝 커밋. 아직 붙인 것이 없으면 등록 커밋(v1)이다. */
export function chainHead(ledger: Ledger): string {
  const last = [...ledger.commits].sort((a, b) => b.pos - a.pos)[0];
  return last?.head ?? ledger.versions[0]?.sha ?? '';
}

/** Runner 보고를 받는다. 비교(base = head) 뒤 추가만 하며, 순서는 보고 목록의 순서(git이 정한 순서) 그대로다. */
export function receive(ledger: Ledger, report: ChainReport): ReceiveResult {
  const head = chainHead(ledger);
  if (report.base !== head) return { kind: 'stale', head };
  if (!report.baseIsAncestor) return { kind: 'rewritten', head };
  const invalid = (rule: string, message: string): ReceiveResult => ({ kind: 'invalid', error: { path: 'commits', rule, message } });
  if (!report.commits.length) return { kind: 'ok', ledger, head, appended: 0 };
  if (report.commits.at(-1)?.sha !== report.head && report.commits.some((c) => c.sha === report.head)) return { kind: 'invalid', error: { path: 'head', rule: 'chain', message: 'head는 목록의 마지막 커밋이거나 목록 밖의 main 끝이어야 합니다.' } };
  const known = new Set([...ledger.commits.map((c) => c.sha), ...ledger.commits.map((c) => c.head), ...ledger.versions.map((v) => v.sha)]);
  const seen = new Set<string>();
  for (const c of report.commits) {
    // base..main에는 base와 그 조상이 나올 수 없다. 이미 아는 커밋이나 중복은 계산이 잘못된 보고다.
    if (known.has(c.sha) || seen.has(c.sha)) return invalid('chain', `${c.sha}는 이미 받은 커밋이거나 목록에 두 번 있습니다.`);
    // 목록은 `-- prototype/`으로 거른 결과라 모든 커밋이 입력 파일을 바꾼다.
    if (!c.hasInput) return invalid('input', `${c.sha}는 prototype/ 아래 파일을 바꾸지 않는 커밋입니다.`);
    seen.add(c.sha);
  }
  const start = Math.max(0, ...ledger.commits.map((c) => c.pos));
  const added = report.commits.map((c, i): LedgerCommit => ({ sha: c.sha, pos: start + i + 1, head: report.head, state: 'pending', version: null }));
  return { kind: 'ok', ledger: { versions: ledger.versions, commits: [...ledger.commits, ...added] }, head: report.head, appended: added.length };
}

export function skip(ledger: Ledger, shas: readonly string[]): Ledger {
  return { versions: ledger.versions, commits: ledger.commits.map((c) => (c.state === 'pending' && shas.includes(c.sha) ? { ...c, state: 'skipped' } : c)) };
}

/** 분석 대상(아직 분석하지 않은 커밋), 사슬 순 */
export const openCommits = (ledger: Ledger) => ledger.commits.filter((c) => c.state !== 'analyzed').sort((a, b) => a.pos - b.pos);
/** 「이 버전으로 분석」에 쓸 커밋: 분석 대상이 있을 때의 사슬 끝(head) */
export const analyzable = (ledger: Ledger) => (openCommits(ledger).length ? chainHead(ledger) : undefined);

/**
 * 「이 버전으로 분석」. 지금 사슬 끝(head)만 고정할 수 있고, 범위는 분석 대상 전부다(모두 head의 조상).
 * head는 이전 버전의 자손이므로 새 버전은 앞으로만 간다. 분석 대상이 없으면 바뀐 입력이 없다.
 */
export function analyze(ledger: Ledger, sha: string): { ledger: Ledger; range: LedgerCommit[]; version: LedgerVersion } | { error: 'unchanged' | 'reference' | 'latest' } {
  if (ledger.versions.some((v) => v.sha === sha)) return { error: 'unchanged' };
  const range = openCommits(ledger);
  if (!range.length) return { error: ledger.commits.some((c) => c.sha === sha || c.head === sha) ? 'unchanged' : 'reference' };
  if (chainHead(ledger) !== sha) return { error: range.some((c) => c.sha === sha) || ledger.commits.some((c) => c.head === sha) ? 'latest' : 'reference' };
  const version: LedgerVersion = { v: (ledger.versions.at(-1)?.v ?? 0) + 1, sha };
  return {
    ledger: { versions: [...ledger.versions, version], commits: ledger.commits.map((c) => (range.some((r) => r.sha === c.sha) ? { ...c, state: 'analyzed', version: version.v } : c)) },
    range, version,
  };
}
