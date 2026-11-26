/*
 * 입력 커밋 원장의 무작위 속성 검사(M2-03 FIX2 리뷰 F1).
 *
 * 불변식(하나로 정함):
 *   입력 버전은 커밋 순서(main 첫 부모 이력의 깊이)대로만 증가하고,
 *   확정 커밋 이전의 커밋은 pending·skipped 상태와 관계없이 확정 범위에서 제외된다.
 *
 * 무작위로 만든 실제 Git 이력(정답)을 두고, Runner의 주기 보고를 겹치게·중복으로·늦게·순서를 섞어 보내며
 * 팀장의 「분석 안 함」·「이 버전으로 분석」을 사이사이 끼워 넣는다. 매 단계 정답 깊이로 불변식을 확인한다.
 */

export interface ReportedCommit { sha: string; depth: number; hasInput: boolean }
/** 검사 대상. 서비스와 같은 규칙의 순수 모델을 넣는다. */
export interface InputModel {
  report(batch: readonly ReportedCommit[]): void;
  skipAllPending(): void;
  /** 성공하면 true(새 입력 버전), 거부하면 false */
  analyze(sha: string): boolean;
  /** 서버가 「최신」으로 안내하는 커밋(없으면 undefined) */
  latest(): string | undefined;
  /** 입력 버전 커밋, v1부터 */
  versions(): readonly string[];
  /** 아직 분석 대상인 커밋(pending·skipped) */
  open(): readonly string[];
  /** 알고 있는 모든 커밋(분석·제외 포함) */
  known(): readonly string[];
}

/** 시드를 고정한 난수(mulberry32). 실패한 시드를 그대로 다시 돌릴 수 있다. */
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

export interface Failure { seed: number; step: number; message: string; trace: string[] }

/**
 * 한 시드를 실행한다. 정답 이력: 깊이 0의 등록 커밋 A(입력 v1) 다음에 깊이 1..n 커밋이 이어진다.
 * 위반을 찾으면 Failure를, 아니면 null을 돌려준다.
 */
export function runSeed(seed: number, make: (baseSha: string) => InputModel): Failure | null {
  const r = random(seed);
  const n = 4 + r.int(9);
  const history: ReportedCommit[] = Array.from({ length: n }, (_, i) => ({ sha: `c${String(i + 1)}`, depth: i + 1, hasInput: r.next() < 0.75 }));
  const depth = new Map<string, number>([['A', 0], ...history.map((c) => [c.sha, c.depth] as const)]);
  // Runner의 주기 확인: 매번 정답 끝(tip)까지의 창을 보낸다. 지난 확인보다 앞에서 시작하는 겹친 창도 섞는다.
  const batches: ReportedCommit[][] = [];
  let tip = 0;
  while (tip < n) {
    const nextTip = Math.min(n, tip + 1 + r.int(3));
    // 겹친 창은 지난 끝보다 앞(또는 같은 곳)에서 시작한다. 뒤에서 시작하면 정답 커밋을 건너뛰게 된다.
    const start = r.next() < 0.4 ? r.int(tip + 1) : tip;
    batches.push(history.slice(start, nextTip));
    tip = nextTip;
  }
  for (let i = r.int(3); i > 0; i--) batches.push(r.pick(batches)); // 중복 재전송
  const queue = [...batches];
  for (let i = queue.length - 1; i > 0; i--) { const j = r.int(i + 1); [queue[i], queue[j]] = [queue[j] as ReportedCommit[], queue[i] as ReportedCommit[]]; } // 지연·순서 섞기

  const model = make('A');
  const trace: string[] = [];
  const check = (step: number): Failure | null => {
    const fail = (message: string) => ({ seed, step, message, trace });
    const versions = model.versions().map((sha) => depth.get(sha) ?? Number.NaN);
    for (let i = 1; i < versions.length; i++) {
      if (!((versions[i] ?? 0) > (versions[i - 1] ?? 0))) return fail(`입력 버전이 커밋 순서대로 증가하지 않음: ${model.versions().join(' → ')}`);
    }
    const last = versions.at(-1) ?? 0;
    const stale = model.open().filter((sha) => (depth.get(sha) ?? 0) <= last);
    if (stale.length) return fail(`확정 커밋(${model.versions().at(-1) ?? ''}) 이전 커밋이 분석 대상에 남음: ${stale.join(',')}`);
    return null;
  };
  let step = 0;
  while (queue.length || r.next() < 0.3) {
    step++;
    const action = queue.length ? r.int(10) : 7 + r.int(3);
    if (action < 6 && queue.length) {
      const batch = queue.shift() ?? [];
      trace.push(`report [${batch.map((c) => `${c.sha}${c.hasInput ? '' : '(src)'}`).join(',')}]`);
      model.report(batch);
    } else if (action === 6) {
      trace.push('skip');
      model.skipAllPending();
    } else if (action === 7 || action === 8) {
      const latest = model.latest();
      if (latest) { trace.push(`analyze latest ${latest} -> ${String(model.analyze(latest))}`); }
    } else {
      const open = model.open();
      if (open.length) {
        const sha = r.pick(open);
        const deepest = open.reduce((a, b) => ((depth.get(a) ?? 0) >= (depth.get(b) ?? 0) ? a : b));
        const ok = model.analyze(sha);
        trace.push(`analyze ${sha} -> ${String(ok)}`);
        if (ok && sha !== deepest) return { seed, step, message: `가장 최근(${deepest})이 아닌 ${sha}로 입력 버전을 고정함`, trace };
      }
    }
    const failure = check(step);
    if (failure) return failure;
    if (step > 200) break;
  }
  // 모두 도착한 뒤: 마지막 확정 커밋보다 뒤의 입력 커밋은 하나도 잃지 않는다.
  // 그보다 앞의 커밋은 확정 버전의 차이(git diff)에 이미 들어 있으므로 따로 남기지 않아도 된다.
  const lastDepth = depth.get(model.versions().at(-1) ?? 'A') ?? 0;
  const lost = history.filter((c) => c.hasInput && c.depth > lastDepth && !model.known().includes(c.sha));
  if (lost.length) return { seed, step, message: `보고한 입력 커밋을 잃음: ${lost.map((c) => c.sha).join(',')}`, trace };
  return null;
}
