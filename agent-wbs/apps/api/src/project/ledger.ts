/*
 * 입력 커밋 원장(ledger) — 입력 변경 감지·「분석 안 함」·「이 버전으로 분석」의 순서 규칙을 한 곳에 둔다.
 *
 * 불변식(하나로 정함, M2-03 FIX2 리뷰 F1):
 *   입력 버전은 커밋 순서대로만 증가하고, 확정 커밋 이전의 커밋은 pending·skipped 상태와 관계없이
 *   확정 범위에서 제외된다(그 버전의 차이에 이미 들어 있다).
 *
 * 커밋 순서는 도착 순서로 추측하지 않는다. Runner가 커밋마다 보내는 `depth`(main 첫 부모 이력의 깊이,
 * `git rev-list --count --first-parent <sha>`)로 정한다. 보고가 겹치거나·중복되거나·늦게·뒤섞여 도착해도
 * 깊이는 바뀌지 않으므로 순서를 다시 맞출 필요가 없다. 이전에는 도착 순서와 겹침으로 순서를 추측해
 * 같은 계열의 결함(리뷰 2 → R1 → F1)이 되풀이되었다.
 */

export type CommitState = 'pending' | 'skipped' | 'analyzed';
export interface LedgerCommit { sha: string; depth: number; state: CommitState; /** 이 커밋을 포함한 입력 버전 번호 */ version: number | null }
/** depth가 null이면 아직 모른다(등록 커밋 v1은 Runner가 보고하기 전까지 깊이를 모른다 → 가장 앞으로 본다). */
export interface LedgerVersion { v: number; sha: string; depth: number | null }
export interface Ledger { versions: readonly LedgerVersion[]; commits: readonly LedgerCommit[] }
export interface ReportedCommit { sha: string; depth: number; hasInput: boolean }
export interface LedgerError { path: string; rule: string; message: string }

const depthOf = (v: LedgerVersion) => v.depth ?? 0;
export const lastDepth = (ledger: Ledger) => Math.max(0, ...ledger.versions.map(depthOf));
/** 깊이 d의 커밋을 포함하는 입력 버전: 깊이가 d 이상인 가장 이른 버전 */
const coveringVersion = (ledger: Ledger, depth: number) => ledger.versions.find((v) => depthOf(v) >= depth)?.v ?? null;

/** 불변식을 회복한다: 마지막 확정 커밋 이하 깊이의 pending·skipped 커밋은 그 깊이를 포함하는 버전으로 넘긴다. */
export function settle(ledger: Ledger): Ledger {
  const last = lastDepth(ledger);
  return {
    versions: ledger.versions,
    commits: ledger.commits.map((c) => (c.state !== 'analyzed' && c.depth <= last ? { ...c, state: 'analyzed', version: coveringVersion(ledger, c.depth) } : c)),
  };
}

/**
 * Runner 보고를 받는다. 형식 오류(배열 순서와 깊이가 어긋남, 같은 커밋의 다른 깊이, 다른 커밋의 같은 깊이)는
 * 어느 쪽을 믿을지 알 수 없으므로 거부하고 아무것도 바꾸지 않는다. 입력 파일이 없는 커밋은 올리지 않는다.
 */
export function receive(ledger: Ledger, batch: readonly ReportedCommit[]): { ledger: Ledger } | { error: LedgerError } {
  const error = (rule: string, message: string) => ({ error: { path: 'commits', rule, message } });
  if (batch.some((c, i) => i > 0 && c.depth <= (batch[i - 1]?.depth ?? 0))) return error('order', '커밋 배열은 main 이력 순서(깊이가 커지는 순서)여야 합니다.');
  const bySha = new Map(ledger.commits.map((c) => [c.sha, c]));
  const byDepth = new Map(ledger.commits.map((c) => [c.depth, c.sha]));
  let versions = ledger.versions;
  for (const c of batch) {
    const knownDepth = bySha.get(c.sha)?.depth ?? ledger.versions.find((v) => v.sha === c.sha)?.depth ?? null;
    if (knownDepth !== null && knownDepth !== c.depth) return error('depth', `${c.sha}의 깊이가 이전 보고와 다릅니다.`);
    const other = byDepth.get(c.depth) ?? ledger.versions.find((v) => v.depth === c.depth && v.sha !== c.sha)?.sha;
    if (other !== undefined && other !== c.sha) return error('depth', `깊이 ${String(c.depth)}에 다른 커밋(${other})이 이미 있습니다.`);
    // 등록 커밋(v1)처럼 깊이를 몰랐던 확정 커밋은 보고로 깊이를 알게 된다.
    versions = versions.map((v) => (v.sha === c.sha && v.depth === null ? { ...v, depth: c.depth } : v));
  }
  if (versions.some((v, i) => i > 0 && depthOf(v) <= depthOf(versions[i - 1] as LedgerVersion))) return error('depth', '확정된 입력 버전의 순서와 맞지 않는 깊이입니다.');
  const added = batch.filter((c) => c.hasInput && !bySha.has(c.sha) && !versions.some((v) => v.sha === c.sha) && !ledger.commits.some((k) => k.sha === c.sha))
    .filter((c, i, list) => list.findIndex((x) => x.sha === c.sha) === i)
    .map((c): LedgerCommit => ({ sha: c.sha, depth: c.depth, state: 'pending', version: null }));
  return { ledger: settle({ versions, commits: [...ledger.commits, ...added] }) };
}

export function skip(ledger: Ledger, shas: readonly string[]): Ledger {
  return { versions: ledger.versions, commits: ledger.commits.map((c) => (c.state === 'pending' && shas.includes(c.sha) ? { ...c, state: 'skipped' } : c)) };
}

/** 분석 대상(아직 분석하지 않은 커밋), 깊이 순 */
export const openCommits = (ledger: Ledger) => ledger.commits.filter((c) => c.state !== 'analyzed').sort((a, b) => a.depth - b.depth);
export const latestOpen = (ledger: Ledger) => openCommits(ledger).at(-1);

/**
 * 「이 버전으로 분석」. 가장 깊은 분석 대상 커밋만 고정할 수 있고, 범위는 모든 분석 대상이다.
 * settle 덕분에 분석 대상은 모두 마지막 확정 커밋보다 깊으므로 새 버전은 항상 커밋 순서대로 증가한다.
 */
export function analyze(ledger: Ledger, sha: string): { ledger: Ledger; range: LedgerCommit[]; version: LedgerVersion } | { error: 'unchanged' | 'reference' | 'latest' } {
  if (ledger.versions.some((v) => v.sha === sha)) return { error: 'unchanged' };
  const open = openCommits(ledger);
  const target = open.find((c) => c.sha === sha);
  if (!target) return { error: ledger.commits.some((c) => c.sha === sha) ? 'unchanged' : 'reference' };
  if (latestOpen(ledger)?.sha !== sha || target.depth <= lastDepth(ledger)) return { error: 'latest' };
  const version: LedgerVersion = { v: (ledger.versions.at(-1)?.v ?? 0) + 1, sha, depth: target.depth };
  const range = open.filter((c) => c.depth <= target.depth);
  const next: Ledger = {
    versions: [...ledger.versions, version],
    commits: ledger.commits.map((c) => (range.some((r) => r.sha === c.sha) ? { ...c, state: 'analyzed', version: version.v } : c)),
  };
  return { ledger: settle(next), range, version };
}
