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

