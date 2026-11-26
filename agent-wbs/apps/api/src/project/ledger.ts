/*
 * 입력 원장(ledger) — 입력 변경 감지·「분석 안 함」·「이 버전으로 분석」의 규칙을 한 곳에 둔다.
 *
 * 입력 변경의 정답은 커밋 목록이 아니라 「두 커밋의 prototype/ 트리 차이」다(M2-03 FIX4 리뷰 N1·N2).
 * merge 뒤 fast-forward처럼 first-parent 커밋 목록이 비어도 실제 트리는 바뀔 수 있기 때문이다.
 *
 * - 원장은 「입력 보고」의 사슬이다. 시작은 등록 커밋(v1), 끝(head)은 마지막으로 받은 보고의 main 끝 커밋이다.
 * - Runner는 head를 base로 삼아 base·head를 SHA로 고정하고 같은 이력에서
 *   `git diff --raw -M --numstat <base> <head> -- prototype/`(추가·수정·삭제·이름 변경, 전후 blob)와
 *   head의 prototype/ 트리 해시를 보낸다. 커밋 목록은 참고 정보다.
 * - 서버는 base가 지금 head와 같을 때만 받아 head를 언제나 옮긴다(빈 차이 포함, N2).
 *   차이가 비어 있지 않을 때만 팀장이 확인할 「입력 변경」 항목(pending)이 생긴다.
 * - 마지막 입력 버전 이후의 보고 차이를 blob 단위로 이어 붙여 「순 변경」(버전 → head)을 정확히 계산한다.
 *   A→B→A처럼 되돌아간 파일은 순 변경에서 빠진다.
 * - 입력 버전은 팀장이 「이 버전으로 분석」을 누를 때 head로 고정한다(G§4.2 A 방식). 순 변경이 없으면 만들지 않는다.
 * - baseIsAncestor·차이·트리 해시는 Runner의 관측을 믿는다(신뢰 전제, contracts 계약 주석).
 *   서버는 그 안에서 모순(빈 차이인데 트리 해시가 바뀜, 이전 보고와 맞지 않는 blob 등)만 거부한다.
 */

export type CommitState = 'pending' | 'skipped' | 'analyzed';
export type Kind = 'added' | 'modified' | 'deleted';
export interface RawChange { status: 'A' | 'M' | 'D' | 'R'; path: string; from?: string | undefined; oldBlob: string | null; newBlob: string | null }
/** 받은 보고 하나. changes가 비면 head만 옮긴 보고다(팀장 확인 항목 아님). */
export interface LedgerReport { seq: number; base: string; head: string; tree: string; changes: readonly RawChange[]; state: CommitState; version: number | null }
export interface LedgerVersion { v: number; sha: string; tree: string | null }
export interface Ledger { versions: readonly LedgerVersion[]; reports: readonly LedgerReport[] }
export interface Observation { base: string; head: string; baseIsAncestor: boolean; treeHash: string; changes: readonly RawChange[] }
export interface LedgerError { path: string; rule: string; message: string }
export type ReceiveResult =
  | { kind: 'ok'; ledger: Ledger; head: string; report: LedgerReport | null }
  | { kind: 'stale'; head: string }
  | { kind: 'rewritten'; head: string }
  | { kind: 'invalid'; error: LedgerError };

const lastReport = (ledger: Ledger) => [...ledger.reports].sort((a, b) => b.seq - a.seq)[0];
/** 입력 head: 마지막으로 받은 보고의 main 끝 커밋. 아직 없으면 등록 커밋(v1)이다. */
export const chainHead = (ledger: Ledger): string => lastReport(ledger)?.head ?? ledger.versions[0]?.sha ?? '';
/** head의 prototype/ 트리 해시. 등록 커밋은 첫 보고 전까지 모른다(null). */
export const headTree = (ledger: Ledger): string | null => lastReport(ledger)?.tree ?? ledger.versions.at(-1)?.tree ?? null;
const unversioned = (ledger: Ledger) => ledger.reports.filter((r) => r.version === null).sort((a, b) => a.seq - b.seq);

/** 보고 차이들을 이어 붙인 경로별 blob 변화(버전 시점 blob → 지금 blob). null은 「없음」. */
function compose(reports: readonly LedgerReport[]): Map<string, { from: string | null; to: string | null }> {
  const state = new Map<string, { from: string | null; to: string | null }>();
  const touch = (path: string, oldBlob: string | null, newBlob: string | null) => {
    const prev = state.get(path);
    state.set(path, { from: prev ? prev.from : oldBlob, to: newBlob });
  };
  for (const report of reports) {
    for (const c of report.changes) {
      if (c.status === 'R' && c.from) { touch(c.from, c.oldBlob, null); touch(c.path, null, c.newBlob); }
      else touch(c.path, c.oldBlob, c.newBlob);
    }
  }
  return state;
}

/** 순 변경(마지막 입력 버전 → 지금 head). 되돌아간 경로는 빠진다. */
export function netChanges(ledger: Ledger): Map<string, Kind> {
  const out = new Map<string, Kind>();
  for (const [path, { from, to }] of compose(unversioned(ledger))) {
    if (from === to) continue;
    out.set(path, from === null ? 'added' : to === null ? 'deleted' : 'modified');
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 관측 하나의 형식 검사: 경로 중복, 상태와 blob의 짝, 이전 보고와 이어지는지 */
function checkChanges(ledger: Ledger, o: Observation): LedgerError | null {
  const err = (rule: string, message: string): LedgerError => ({ path: 'changes', rule, message });
  const seen = new Set<string>();
  for (const c of o.changes) {
    for (const p of [c.path, ...(c.status === 'R' && c.from ? [c.from] : [])]) {
      if (seen.has(p)) return err('unique', `${p}가 차이에 두 번 나옵니다.`);
      seen.add(p);
    }
    const ok = c.status === 'A' ? c.oldBlob === null && c.newBlob !== null
      : c.status === 'D' ? c.oldBlob !== null && c.newBlob === null
        : c.status === 'M' ? c.oldBlob !== null && c.newBlob !== null && c.oldBlob !== c.newBlob
          : c.oldBlob !== null && c.newBlob !== null && Boolean(c.from) && c.from !== c.path;
    if (!ok) return err('status', `${c.path}의 상태(${c.status})와 blob이 맞지 않습니다.`);
  }
  // 이번 차이의 「이전 blob」은 지금까지 이어 붙인 head 시점 blob과 같아야 한다(모르는 경로는 검사하지 않음).
  const now = compose(unversioned(ledger));
  for (const c of o.changes) {
    const pairs: [string, string | null][] = c.status === 'R' && c.from ? [[c.from, c.oldBlob], [c.path, null]] : [[c.path, c.oldBlob]];
    for (const [path, blob] of pairs) {
      const known = now.get(path);
      if (known && known.to !== blob) return err('blob', `${path}의 이전 내용이 지난 보고와 다릅니다.`);
    }
  }
  return null;
}

/** Runner 보고를 받는다(비교 후 갱신). */
export function receive(ledger: Ledger, o: Observation): ReceiveResult {
  const head = chainHead(ledger);
  if (o.base !== head) return { kind: 'stale', head };
  if (!o.baseIsAncestor) return { kind: 'rewritten', head };
  const invalid = (error: LedgerError): ReceiveResult => ({ kind: 'invalid', error });
  const error = checkChanges(ledger, o);
  if (error) return invalid(error);
  const known = headTree(ledger);
  if (o.head === o.base) {
    if (o.changes.length || (known !== null && known !== o.treeHash)) return invalid({ path: 'head', rule: 'tree', message: 'base와 head가 같은데 차이나 트리 해시가 다릅니다.' });
    return { kind: 'ok', ledger, head, report: null };
  }
  // 차이가 비었는지와 트리 해시가 바뀌었는지는 같은 사실이어야 한다(트리 해시를 아는 경우).
  if (known !== null && (o.changes.length === 0) !== (known === o.treeHash)) {
    return invalid({ path: 'treeHash', rule: 'tree', message: '차이와 트리 해시가 서로 맞지 않습니다.' });
  }
  const report: LedgerReport = {
    seq: (lastReport(ledger)?.seq ?? 0) + 1, base: o.base, head: o.head, tree: o.treeHash, changes: o.changes,
    state: o.changes.length ? 'pending' : 'analyzed', version: null,
  };
  return { kind: 'ok', ledger: { versions: ledger.versions, reports: [...ledger.reports, report] }, head: o.head, report };
}

export function skip(ledger: Ledger, heads: readonly string[]): Ledger {
  return { versions: ledger.versions, reports: ledger.reports.map((r) => (r.state === 'pending' && heads.includes(r.head) ? { ...r, state: 'skipped' } : r)) };
}

/** 팀장이 확인할 입력 변경 항목(차이가 있는 보고 중 아직 버전에 들어가지 않은 것) */
export const openReports = (ledger: Ledger) => unversioned(ledger).filter((r) => r.changes.length > 0);
/** 「이 버전으로 분석」에 쓸 커밋: 순 변경이 있을 때의 head */
export const analyzable = (ledger: Ledger) => (netChanges(ledger).size ? chainHead(ledger) : undefined);

/**
 * 「이 버전으로 분석」. head만 고정할 수 있고, 순 변경이 없으면 만들지 않는다.
 * 마지막 버전 이후의 보고는 모두 이 버전에 묶인다(빈 보고 포함).
 */
export function analyze(ledger: Ledger, sha: string):
  { ledger: Ledger; net: Map<string, Kind>; reports: LedgerReport[]; version: LedgerVersion } | { error: 'unchanged' | 'reference' | 'latest' } {
  if (ledger.versions.some((v) => v.sha === sha)) return { error: 'unchanged' };
  const head = chainHead(ledger);
  if (sha !== head) return { error: ledger.reports.some((r) => r.head === sha) ? 'latest' : 'reference' };
  const net = netChanges(ledger);
  if (!net.size) return { error: 'unchanged' };
  const version: LedgerVersion = { v: (ledger.versions.at(-1)?.v ?? 0) + 1, sha, tree: headTree(ledger) };
  const reports = unversioned(ledger);
  return {
    ledger: { versions: [...ledger.versions, version], reports: ledger.reports.map((r) => (r.version === null ? { ...r, state: 'analyzed', version: version.v } : r)) },
    net, reports, version,
  };
}
