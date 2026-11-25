export interface ParallelInput {
  /** 실행 중인 Task. 충돌 묶음이 없으면 null. */
  running: readonly { taskKey: string; conflictGroup: string | null }[];
  /** 선행이 충족되어 시작할 수 있는 Task */
  startable: readonly { taskKey: string; conflictGroup: string | null }[];
}

export interface Parallel {
  /** 동시에 할 수 있는 Task 수 (실행 중 포함) */
  width: number;
  /** 실행 중인 Task 때문에 기다리는 Task */
  conflictWaits: { taskKey: string; conflictGroup: string; by: string }[];
}

/** 병렬 가능한 Task 수. 같은 충돌 묶음은 하나만 센다(G §6.6 직렬화). */
export function parallelWidth(input: ParallelInput): Parallel {
  const busy = new Map<string, string>();
  for (const t of input.running) if (t.conflictGroup) busy.set(t.conflictGroup, t.taskKey);

  const conflictWaits: Parallel['conflictWaits'] = [];
  const pending = new Set<string>();
  let width = input.running.length;
  for (const t of input.startable) {
    if (!t.conflictGroup) {
      width += 1;
      continue;
    }
    const by = busy.get(t.conflictGroup);
    if (by !== undefined && by !== t.taskKey) {
      conflictWaits.push({ taskKey: t.taskKey, conflictGroup: t.conflictGroup, by });
    } else if (by === undefined && !pending.has(t.conflictGroup)) {
      pending.add(t.conflictGroup);
      width += 1;
    }
  }
  return { width, conflictWaits };
}

export type LimitFactor = 'cap' | 'runner_limit' | 'parallel_tasks';

export interface ConcurrencyInput {
  capTotal: number;
  runnerLimit: number;
  width: number;
  /** 세션당 하위 Agent 비율 */
  subRatio: number;
}

export interface Concurrency {
  /** 실행 한도 = min(상한, Runner 조절 한도). 보유 계산 합계를 이 값과 비교한다. */
  limit: number;
  /** 실제 동시 실행 수 = min(한도, 병렬 가능한 Task × (1 + 하위 Agent 비율)) */
  expected: number;
  /** 지금 동시 실행을 제한하는 요인. 같으면 상한 → Runner → 병렬 순(P `conc`). */
  factor: LimitFactor;
  /** 상한을 올리면 실제 동시 실행 수가 늘어나는가 */
  raisingCapHelps: boolean;
}

export function concurrency(i: ConcurrencyInput): Concurrency {
  const demand = i.width * (1 + i.subRatio);
  const limit = Math.min(i.capTotal, i.runnerLimit);
  const expected = Math.min(limit, demand);
  const factor: LimitFactor =
    i.capTotal === expected ? 'cap' : i.runnerLimit === expected ? 'runner_limit' : 'parallel_tasks';
  return { limit, expected, factor, raisingCapHelps: i.capTotal < Math.min(i.runnerLimit, demand) };
}

/** 메모리 여유가 예비보다 작거나 swap을 쓰면 자원 압박 — 새 실행을 보류한다(G §6.6). */
export const memoryPressure = (memFreeGb: number, swapUsedGb: number, memReserveGb: number): boolean =>
  memFreeGb < memReserveGb || swapUsedGb > 0;
