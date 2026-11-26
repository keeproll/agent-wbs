/*
 * 입력 원장의 무작위 속성 검사(M2-03 FIX4 리뷰 N1·N2).
 *
 * 정답은 커밋 목록이 아니라 「파일 트리」다. 무작위 Git 그래프의 커밋마다 prototype/ 파일 트리(경로 → 내용)를 두고,
 * merge는 부모 트리에서 경로별로 고르거나 한쪽 트리를 그대로 쓴다(`-s ours` 포함).
 * 「feature에 main을 합친 뒤 main을 fast-forward」하면 first-parent 목록이 비어도 실제 트리는 바뀔 수 있다(N1).
 *
 * 매 단계 서버의 입력 상태를 트리 정답과 비교한다.
 *   (a) 입력 버전은 앞으로만 간다(새 버전 커밋은 이전 버전의 자손)
 *   (b) 서버의 순 변경(마지막 버전 → 서버 head) = 두 커밋의 prototype/ 트리 차이(정답)
 *   (c) head로 하는 분석은 정답 차이가 있을 때만 성공하고, 성공하면 순 변경이 비워진다
 *   (d) 이력 재작성 보고는 rewritten이고 아무것도 바꾸지 않는다
 *   (e) 마지막 동기화 뒤 서버 head = main(N2), 순 변경 = 정답
 * Runner는 응답을 잃거나(다음 보고가 낡은 base) 옛 요청이 늦게·중복으로 다시 도착한다.
 */

export type Tree = ReadonlyMap<string, string>;
export type Kind = 'added' | 'modified' | 'deleted';
/** `git diff --raw -M base head -- prototype/` 한 줄. blob은 내용 해시다. */
export interface RawChange { status: 'A' | 'M' | 'D' | 'R'; path: string; from?: string; oldBlob: string | null; newBlob: string | null }
export interface Observation {
  base: string; head: string; baseIsAncestor: boolean; treeHash: string; changes: readonly RawChange[];
  /** 참고: first-parent 커밋별 변경(수정 전 계약 비교용) */
  commits: readonly { sha: string; files: readonly { path: string; change: Kind }[] }[];
}
export type ReportResult = { kind: 'ok'; head: string } | { kind: 'stale'; head: string } | { kind: 'rewritten' } | { kind: 'invalid' };
export interface InputModel {
  report(o: Observation): ReportResult;
  skipAll(): void;
  analyze(sha: string): boolean;
  /** 「이 버전으로 분석」에 쓸 커밋(없으면 undefined) */
  analyzable(): string | undefined;
  head(): string;
  versions(): readonly string[];
  /** 마지막 버전 → head의 순 변경(경로 → 종류) */
  net(): ReadonlyMap<string, Kind>;
}

export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T };
}

export const treeHash = (tree: Tree) => `t:${[...tree].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, c]) => `${p}=${c}`).join('|')}`;
/** 두 트리의 경로별 차이(정답). 이름 변경은 삭제 + 추가로 본다. */
export function treeDiff(from: Tree, to: Tree): Map<string, Kind> {
  const out = new Map<string, Kind>();
  for (const path of new Set([...from.keys(), ...to.keys()])) {
    const a = from.get(path);
    const b = to.get(path);
    if (a === b) continue;
    out.set(path, a === undefined ? 'added' : b === undefined ? 'deleted' : 'modified');
  }
  return out;
}

export class Graph {
  readonly parents = new Map<string, string[]>();
  readonly trees = new Map<string, Tree>();
  private n = 0;
  commit(parents: string[], tree: Tree): string {
    const sha = `g${String(++this.n)}`;
    this.parents.set(sha, parents);
    this.trees.set(sha, tree);
    return sha;
  }
  tree(sha: string): Tree { return this.trees.get(sha) ?? new Map(); }
  ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const c = stack.pop() as string;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...(this.parents.get(c) ?? []));
    }
    return seen;
  }
  isAncestor(a: string, b: string) { return this.ancestors(b).has(a); }
  firstParentChain(tip: string): string[] {
    const out: string[] = [];
    for (let c: string | undefined = tip; c; c = this.parents.get(c)?.[0]) out.push(c);
    return out;
  }
  /** `git rev-list --first-parent --reverse base..tip -- prototype/`와 커밋별(첫 부모 대비) 변경 */
  revList(base: string, tip: string) {
    const excluded = this.ancestors(base);
    const out: { sha: string; files: { path: string; change: Kind }[] }[] = [];
    for (let c: string | undefined = tip; c && !excluded.has(c); c = this.parents.get(c)?.[0]) {
      const parent = this.parents.get(c)?.[0];
      const files = [...treeDiff(parent ? this.tree(parent) : new Map(), this.tree(c))].map(([path, change]) => ({ path, change }));
      if (files.length) out.push({ sha: c, files });
    }
    return out.reverse();
  }
}

/** Runner의 관측: base·head를 고정하고 같은 이력에서 diff·트리 해시·목록을 계산한다. */
export function observe(g: Graph, base: string, head: string, r: ReturnType<typeof random>): Observation {
  const baseIsAncestor = g.isAncestor(base, head);
  const from = g.tree(base);
  const to = g.tree(head);
  const changes: RawChange[] = [];
  const diff = treeDiff(from, to);
  const added = [...diff].filter(([, k]) => k === 'added').map(([p]) => p);
  const usedAdd = new Set<string>();
  for (const [path, kind] of diff) {
    if (kind === 'modified') changes.push({ status: 'M', path, oldBlob: from.get(path) ?? null, newBlob: to.get(path) ?? null });
    else if (kind === 'deleted') {
      // git diff -M처럼 같은 내용의 추가가 있으면 이름 변경으로 보고하기도 한다.
      const twin = added.find((p) => !usedAdd.has(p) && to.get(p) === from.get(path));
      if (twin && r.next() < 0.7) { usedAdd.add(twin); changes.push({ status: 'R', path: twin, from: path, oldBlob: from.get(path) ?? null, newBlob: to.get(twin) ?? null }); }
      else changes.push({ status: 'D', path, oldBlob: from.get(path) ?? null, newBlob: null });
    }
  }
  for (const path of added) if (!usedAdd.has(path)) changes.push({ status: 'A', path, oldBlob: null, newBlob: to.get(path) ?? null });
  return { base, head, baseIsAncestor, treeHash: treeHash(to), changes: baseIsAncestor ? changes : [], commits: baseIsAncestor ? g.revList(base, head) : [] };
}

export interface Failure { seed: number; step: number; message: string; trace: string[] }
const show = (m: ReadonlyMap<string, Kind>) => [...m].sort().map(([p, k]) => `${k[0] ?? ''}:${p.replace('prototype/', '')}`).join(',') || '-';
const same = (a: ReadonlyMap<string, Kind>, b: ReadonlyMap<string, Kind>) => a.size === b.size && [...a].every(([p, k]) => b.get(p) === k);

export function runSeed(seed: number, make: (registration: string) => InputModel): Failure | null {
  const r = random(seed);
  const g = new Graph();
  let counter = 0;
  const content = () => `c${String(++counter)}`;
  const mutate = (tree: Tree): Tree => {
    const next = new Map(tree);
    const paths = [...next.keys()];
    const op = r.int(6);
    if (op === 0 || !paths.length) next.set(`prototype/docs/f${String(++counter)}.md`, content());
    else if (op === 1) next.set(r.pick(paths), content());
    else if (op === 2) next.delete(r.pick(paths));
    else if (op === 3) { const p = r.pick(paths); const c = next.get(p) as string; next.delete(p); next.set(`prototype/uiux/m${String(++counter)}.html`, c); }
    // op 4·5: src만 바꾼 커밋(prototype/ 트리 그대로)
    return next;
  };
  const mergeTrees = (a: Tree, b: Tree): Tree => {
    const mode = r.int(3);
    if (mode === 0) return a; // -s ours: 첫 부모 트리 유지
    if (mode === 1) return b;
    const out = new Map<string, string>();
    for (const p of new Set([...a.keys(), ...b.keys()])) { const v = r.next() < 0.5 ? a.get(p) : b.get(p); if (v !== undefined) out.set(p, v); }
    return out;
  };

  let main = g.commit([], new Map([['prototype/docs/guide.md', content()]]));
  for (let i = r.int(4); i > 0; i--) main = g.commit([main], mutate(g.tree(main)));
  const registration = main;
  const model = make(registration);
  const trace: string[] = [`register ${registration}`];
  let runnerBase = registration;
  let rewritten = false;
  const sent: Observation[] = [];
  const fail = (step: number, message: string): Failure => ({ seed, step, message, trace });

  const sync = (lose: boolean, step: number): Failure | null => {
    const o = observe(g, runnerBase, main, r);
    sent.push(o);
    const before = { head: model.head(), versions: model.versions().join(), net: show(model.net()) };
    const result = model.report(o);
    trace.push(`report ${o.base}..${o.head} [${o.changes.map((c) => `${c.status}:${c.path.replace('prototype/', '')}`).join(',')}]${o.baseIsAncestor ? '' : ' (재작성)'} -> ${result.kind}${lose ? ' (응답 유실)' : ''}`);
    if (!o.baseIsAncestor && o.base === before.head) {
      if (result.kind !== 'rewritten') return fail(step, `이력 재작성 보고가 rewritten이 아님: ${result.kind}`);
      if (model.head() !== before.head || model.versions().join() !== before.versions || show(model.net()) !== before.net) return fail(step, '이력 재작성 보고로 원장이 바뀜');
    }
    if (result.kind === 'invalid') return fail(step, '정확한 관측 보고가 거부됨(invalid)');
    if (!lose && (result.kind === 'ok' || result.kind === 'stale')) runnerBase = result.head;
    return null;
  };
  const check = (step: number): Failure | null => {
    const versions = model.versions();
    for (let i = 1; i < versions.length; i++) {
      if (!g.isAncestor(versions[i - 1] as string, versions[i] as string) || versions[i] === versions[i - 1]) return fail(step, `입력 버전이 앞으로만 가지 않음: ${versions.join(' → ')}`);
    }
    const expected = treeDiff(g.tree(versions.at(-1) as string), g.tree(model.head()));
    if (!same(model.net(), expected)) return fail(step, `순 변경이 트리 정답과 다름: 서버 ${show(model.net())} / 정답 ${show(expected)} (head ${model.head()})`);
    return null;
  };

  let step = 0;
  for (; step < 50; step++) {
    const action = r.int(20);
    if (action < 4) { main = g.commit([main], mutate(g.tree(main))); trace.push(`commit ${main}`); }
    else if (action < 7 && !rewritten) {
      const from = r.pick(g.firstParentChain(main).slice(0, 4));
      let tip = from;
      for (let i = 1 + r.int(3); i > 0; i--) tip = g.commit([tip], mutate(g.tree(tip)));
      if (r.next() < 0.5) { main = g.commit([main, tip], mergeTrees(g.tree(main), g.tree(tip))); trace.push(`merge ${tip} into main -> ${main}`); }
      else { main = g.commit([tip, main], mergeTrees(g.tree(tip), g.tree(main))); trace.push(`merge main into feature, fast-forward -> ${main}`); }
    } else if (action === 7 && r.next() < 0.15 && !rewritten) {
      main = g.commit([g.firstParentChain(registration).at(-1) as string], mutate(new Map()));
      rewritten = true;
      trace.push(`rewrite main -> ${main}`);
    } else if (action < 13) { const f = sync(r.next() < 0.2, step); if (f) return f; }
    else if (action < 15 && sent.length) {
      const o = r.pick(sent);
      const result = model.report(o);
      trace.push(`replay ${o.base}..${o.head} -> ${result.kind}`);
      if (result.kind === 'invalid') return fail(step, '늦게 도착한 정확한 보고가 invalid로 거부됨(stale이어야 함)');
    } else if (action === 15) { model.skipAll(); trace.push('skip'); }
    else if (action < 18) {
      const sha = model.analyzable();
      const expected = treeDiff(g.tree(model.versions().at(-1) as string), g.tree(model.head()));
      if (sha) {
        const ok = model.analyze(sha);
        trace.push(`analyze ${sha} -> ${String(ok)}`);
        if (!ok) return fail(step, `안내한 분석 커밋(${sha}) 분석이 거부됨`);
        if (expected.size === 0) return fail(step, '트리 정답에 변경이 없는데 새 입력 버전을 만듦');
        if (model.net().size) return fail(step, '분석 뒤에도 순 변경이 남음');
      } else if (expected.size) return fail(step, `트리 정답에는 변경(${show(expected)})이 있는데 분석할 수 없음`);
    } else {
      const expected = treeDiff(g.tree(model.versions().at(-1) as string), g.tree(model.head()));
      const head = model.head();
      const ok = model.analyze(head);
      trace.push(`analyze head ${head} -> ${String(ok)}`);
      if (ok !== (expected.size > 0)) return fail(step, `head 분석 결과(${String(ok)})가 트리 정답 변경 유무(${String(expected.size > 0)})와 다름`);
    }
    const failure = check(step);
    if (failure) return failure;
  }
  if (rewritten) { const f = sync(false, step); return f ?? check(step); }
  for (let i = 0; i < 4; i++) { const f = sync(false, step); if (f) return f; }
  if (model.head() !== main) return fail(step, `마지막 동기화 뒤 서버 head(${model.head()})가 main(${main})이 아님`);
  return check(step);
}
