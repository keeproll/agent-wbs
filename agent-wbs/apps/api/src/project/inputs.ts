export type Change = 'added' | 'modified' | 'deleted';
export interface PathChange { path: string; change: Change }

/**
 * 여러 커밋에 걸친 같은 파일의 변경을 「이전 입력 버전 → 새 버전」 한 줄로 합친다.
 * 이전 버전과 비교하는 것이므로(G§4.2 ②) 처음 상태와 마지막 상태만 본다.
 * 예: 추가 후 삭제는 이전 버전에도 새 버전에도 없으니 빠지고, 삭제 후 추가는 「수정」이다.
 */
export function mergeChanges(ordered: readonly PathChange[]): PathChange[] {
  const first = new Map<string, Change>();
  const last = new Map<string, Change>();
  for (const { path, change } of ordered) {
    if (!first.has(path)) first.set(path, change);
    last.set(path, change);
  }
  const out: PathChange[] = [];
  for (const [path, begin] of first) {
    const end = last.get(path) ?? begin;
    const existedBefore = begin !== 'added';
    const existsAfter = end !== 'deleted';
    if (!existedBefore && !existsAfter) continue;
    out.push({ path, change: !existedBefore ? 'added' : !existsAfter ? 'deleted' : 'modified' });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const isDoc = (path: string) => path.startsWith('prototype/docs/') && path.toLowerCase().endsWith('.md');

/** 설계 문서 목록(prototype/docs 아래 md, G§4.2 디렉토리 규칙)을 변경에 맞춰 갱신한다. */
export function nextMdList(previous: readonly string[], changes: readonly PathChange[]): string[] {
  const list = new Set(previous);
  for (const { path, change } of changes) {
    if (!isDoc(path)) continue;
    if (change === 'deleted') list.delete(path);
    else list.add(path);
  }
  return [...list].sort();
}

/**
 * 아직 분석하지 않은 입력 커밋의 순서(existing, 오래된 것 먼저)에 새 보고 배치(batch, 오래된 것 먼저)를 합친다(재리뷰 R1).
 * - 입력 버전으로 이미 고정했거나 분석한 커밋(settled)과 배치에서 그 앞에 있는 커밋은 그 버전의 차이에 포함되었으므로 버린다.
 * - 새 커밋은 배치 안에서 자기 뒤에 오는 기존 커밋 바로 앞에 놓는다. 뒤따르는 기존 커밋이 없으면 맨 뒤에 붙인다.
 *   「처음 본 커밋 = 가장 최근」으로 붙이면, 겹쳐 늦게 도착한 보고에서 옛 커밋이 최신으로 뒤집힌다.
 * - 배치 안 기존 커밋들의 순서가 이미 받은 순서와 어긋나면 어느 쪽도 믿을 수 없으므로 null을 돌려준다.
 */
export function mergeCommitOrder(existing: readonly string[], batch: readonly string[], settled: ReadonlySet<string>): string[] | null {
  const lastSettled = batch.reduce((at, sha, i) => (settled.has(sha) ? i : at), -1);
  const rest = batch.slice(lastSettled + 1).filter((sha) => !settled.has(sha));
  const known = rest.filter((sha) => existing.includes(sha)).map((sha) => existing.indexOf(sha));
  if (known.some((position, i) => i > 0 && position <= (known[i - 1] ?? -1))) return null;
  const order = [...existing];
  rest.forEach((sha, i) => {
    if (order.includes(sha)) return;
    const next = rest.slice(i + 1).find((later) => existing.includes(later));
    if (next === undefined) order.push(sha);
    else order.splice(order.indexOf(next), 0, sha);
  });
  return order;
}
