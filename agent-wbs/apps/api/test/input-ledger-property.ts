/*
 * 입력 커밋 원장의 무작위 속성 검사(M2-03 FIX3 리뷰 D1~D3).
 *
 * 불변식:
 *   입력 버전은 커밋 순서대로만 증가하고(새 버전은 이전 버전의 자손),
 *   확정 커밋 이전(조상)의 커밋은 pending·skipped 상태와 관계없이 확정 범위에서 제외된다.
 *   그리고 main의 새 입력 커밋은 잃지 않는다.
 *
 * 정답은 무작위로 만든 실제 Git 그래프(DAG)다. merge(main이 첫 부모인 보통 merge,
 * feature에 main을 합친 뒤 main을 fast-forward하는 merge), side branch, 드물게 이력 재작성을 넣는다.
 * Runner는 계약대로 `git rev-list --first-parent --reverse base..main -- prototype/`를 계산해 보내며,
 * 응답을 잃거나(다음 보고가 낡은 base), 같은 요청이 늦게·중복으로 다시 도착한다.
 */

export interface ReportedCommit { sha: string; hasInput: boolean; /** 수정 전(depth) 모델 비교용. 새 계약에는 없다. */ depth: number }
/** head = Runner가 목록을 계산한 main 끝 커밋. 다음 보고의 base가 되고, 입력 버전으로 고정하는 커밋이다. */
export interface Report { base: string; head: string; baseIsAncestor: boolean; commits: readonly ReportedCommit[] }
export type ReportResult = { kind: 'ok'; head: string } | { kind: 'stale'; head: string } | { kind: 'rewritten' } | { kind: 'invalid' };
export interface InputModel {
  report(report: Report): ReportResult;
  skipAllPending(): void;
  analyze(sha: string): boolean;
  latest(): string | undefined;
  versions(): readonly string[];
  open(): readonly string[];
  known(): readonly string[];
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

/** 실제 Git 그래프의 최소 모형 */
export class Graph {
  readonly parents = new Map<string, string[]>();
  readonly input = new Map<string, boolean>();
  private n = 0;
  commit(parents: string[], input: boolean): string {
    const sha = `g${String(++this.n)}`;
    this.parents.set(sha, parents);
    this.input.set(sha, input);
    return sha;
  }
  /** sha 자신과 모든 조상(모든 부모를 따라감) */
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
  /** `git rev-list --first-parent --reverse base..tip -- prototype/` */
  revList(base: string, tip: string): string[] {
    const excluded = this.ancestors(base);
    const out: string[] = [];
    for (let c: string | undefined = tip; c && !excluded.has(c); c = this.parents.get(c)?.[0]) out.push(c);
    return out.filter((c) => this.input.get(c)).reverse();
  }
  /** `git rev-list --count --first-parent sha` (수정 전 depth 계약) */
  firstParentDepth(sha: string) {
    let d = 0;
    for (let c: string | undefined = sha; c; c = this.parents.get(c)?.[0]) d++;
    return d;
  }
  firstParentChain(tip: string): string[] {
    const out: string[] = [];
    for (let c: string | undefined = tip; c; c = this.parents.get(c)?.[0]) out.push(c);
    return out;
  }
}

export interface Failure { seed: number; step: number; message: string; trace: string[] }

export function runSeed(seed: number, make: (registration: string) => InputModel): Failure | null {
  const r = random(seed);
  const g = new Graph();
  // 등록 전 이력: 등록 커밋은 첫 커밋이 아니다(D1).
  let main = g.commit([], true);
  for (let i = r.int(5); i > 0; i--) main = g.commit([main], r.next() < 0.6);
  const registration = main;
  const model = make(registration);
  const trace: string[] = [`register ${registration} (depth ${String(g.firstParentDepth(registration))})`];
  let runnerBase = registration;
  let rewritten = false;
  const sent: Report[] = [];

  const build = (base: string): Report => {
    const baseIsAncestor = g.isAncestor(base, main);
    const commits = baseIsAncestor ? g.revList(base, main).map((sha) => ({ sha, hasInput: true, depth: g.firstParentDepth(sha) })) : [];
    return { base, head: main, baseIsAncestor, commits };
  };
  const sync = (loseResponse: boolean) => {
    const report = build(runnerBase);
    if (report.baseIsAncestor && !report.commits.length) return;
    sent.push(report);
    const result = model.report(report);
    trace.push(`report base=${report.base} [${report.commits.map((c) => c.sha).join(',')}]${report.baseIsAncestor ? '' : ' (base not ancestor)'} -> ${result.kind}${loseResponse ? ' (응답 유실)' : ''}`);
    if (loseResponse) return;
    if (result.kind === 'ok' || result.kind === 'stale') runnerBase = result.head;
  };
  const fail = (step: number, message: string): Failure => ({ seed, step, message, trace });
  const check = (step: number): Failure | null => {
    const versions = model.versions();
    for (let i = 1; i < versions.length; i++) {
      const prev = versions[i - 1] as string;
      const cur = versions[i] as string;
      if (cur === prev || !g.isAncestor(prev, cur)) return fail(step, `입력 버전이 커밋 순서대로 증가하지 않음: ${versions.join(' → ')}`);
    }
    const last = versions.at(-1) as string;
    const stale = model.open().filter((sha) => g.isAncestor(sha, last));
    if (stale.length) return fail(step, `확정 커밋(${last}) 이전 커밋이 분석 대상에 남음: ${stale.join(',')}`);
    return null;
  };

  let step = 0;
  for (; step < 60; step++) {
    const action = r.int(20);
    if (action < 4) { main = g.commit([main], r.next() < 0.7); trace.push(`commit ${main}`); }
    else if (action < 7 && !rewritten) {
      // feature 분기: main의 첫 부모 조상 중 하나에서 갈라져 1~3개 커밋
      const from = r.pick(g.firstParentChain(main).slice(0, 4));
      let tip = from;
      for (let i = 1 + r.int(3); i > 0; i--) tip = g.commit([tip], r.next() < 0.7);
      if (r.next() < 0.5) { main = g.commit([main, tip], r.next() < 0.3); trace.push(`merge ${tip} into main -> ${main}`); }
      else {
        // feature에 main을 합친 뒤 main을 fast-forward: 새 main의 첫 부모는 feature, 옛 main은 둘째 부모(D2)
        main = g.commit([tip, main], r.next() < 0.3);
        trace.push(`merge main into feature, fast-forward main -> ${main} (first parent ${tip})`);
      }
    } else if (action === 7 && r.next() < 0.15 && !rewritten) {
      // 금지된 이력 재작성: 등록 이전 커밋에서 새 main을 만든다(옛 base는 새 main의 조상이 아님).
      main = g.commit([g.firstParentChain(registration).at(-1) as string], true);
      rewritten = true;
      trace.push(`rewrite main -> ${main}`);
    } else if (action < 13) sync(r.next() < 0.2);
    else if (action < 15 && sent.length) {
      // 같은 요청이 늦게·중복으로 다시 도착(네트워크 재전송). 응답은 Runner에 전달되지 않는다.
      const report = r.pick(sent);
      const result = model.report(report);
      trace.push(`replay base=${report.base} [${report.commits.map((c) => c.sha).join(',')}] -> ${result.kind}`);
    } else if (action === 15) { model.skipAllPending(); trace.push('skip'); }
    else if (action < 18) {
      const latest = model.latest();
      if (latest) {
        const ok = model.analyze(latest);
        trace.push(`analyze latest ${latest} -> ${String(ok)}`);
        if (!ok) return fail(step, `서버가 안내한 최신 커밋(${latest}) 분석이 거부됨`);
      }
    } else {
      const open = model.open();
      if (open.length) {
        const sha = r.pick(open);
        const ok = model.analyze(sha);
        trace.push(`analyze ${sha} -> ${String(ok)}`);
        if (ok && open.some((other) => other !== sha && !g.isAncestor(other, sha))) return fail(step, `다른 분석 대상의 자손이 아닌 ${sha}로 입력 버전을 고정함`);
      }
    }
    const failure = check(step);
    if (failure) return failure;
  }
  if (rewritten) {
    // 재작성 뒤에는 무엇도 붙이지 않는다(팀장 경고). 원장이 재작성 이력을 받아들였는지 확인한다.
    const before = model.known().length;
    sync(false);
    if (model.known().length !== before) return fail(step, '이력 재작성 뒤 보고를 원장에 붙임');
    return null;
  }
  // 마지막 동기화: Runner가 따라잡은 뒤, 마지막 확정 버전 이후 main의 입력 커밋은 모두 분석 대상이어야 한다.
  for (let i = 0; i < 4; i++) sync(false);
  const last = model.versions().at(-1) as string;
  const expected = g.isAncestor(last, main) ? g.revList(last, main) : [];
  const open = new Set(model.open());
  const lost = expected.filter((sha) => !open.has(sha));
  if (lost.length) return fail(step, `main의 새 입력 커밋을 잃음: ${lost.join(',')} (기대 ${expected.join(',')}, 분석 대상 ${[...open].join(',')})`);
  return null;
}
