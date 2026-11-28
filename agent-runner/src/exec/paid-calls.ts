import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../state/files.ts';
import type { Agent } from '../api/generated/client.ts';
import type { LaunchJob } from './launches.ts';

export interface PaidCallInput { job: LaunchJob; agent: Agent; model: string; effort: string }
export interface PaidCall extends PaidCallInput {
  number: number; at: string; result: 'unknown' | 'succeeded' | 'failed' | 'cancelled'; finishedAt?: string; exitCode?: number | null;
}
interface Ledger { used: number; calls: PaidCall[] }

/** 홈 잠금 아래 영속 순번. 실행 허가 직전에 저장하며 결과를 모르면 unknown으로 보존한다. */
// shortcut: Runner가 허가한 CLI만 센다. Agent·CI의 임의 중첩 CLI까지 막으려면 계정·네트워크 격리를 강화한다.
export class PaidCalls {
  #tail: Promise<unknown> = Promise.resolve();
  readonly home: string;
  readonly limit: number;
  readonly maxEffort: string;
  readonly #log: ((call: PaidCall) => void) | undefined;
  constructor(home: string, limit: number, maxEffort = 'high', log?: (call: PaidCall) => void) {
    this.home = home; this.limit = limit; this.maxEffort = maxEffort; this.#log = log;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 30) throw new Error('AWBS_CALL_LIMIT는 0~30 정수여야 합니다.');
    if (!['low', 'medium', 'high'].includes(maxEffort)) throw new Error('AWBS_AGENT_MAX_EFFORT는 low·medium·high 중 하나여야 합니다.');
  }
  async #read(): Promise<Ledger> {
    try {
      const value = JSON.parse(await readFile(join(this.home, 'paid-calls.json'), 'utf8')) as Partial<Ledger>;
      if (!value || !Number.isSafeInteger(value.used) || (value.used ?? -1) < 0 || value.calls !== undefined && (!Array.isArray(value.calls) || value.calls.some(call => !call || !Number.isSafeInteger(call.number) || call.number < 1 || call.number > (value.used ?? 0) || !call.job || typeof call.job.id !== 'string' || !['Codex', 'Claude'].includes(call.agent) || typeof call.model !== 'string' || typeof call.effort !== 'string' || typeof call.at !== 'string' || !['unknown', 'succeeded', 'failed', 'cancelled'].includes(call.result)))) throw new Error('유료 호출 기록이 손상되었습니다. 원본을 보존하세요.');
      // 이전 숫자 장부의 사용량은 유지한다. 없던 과거 호출 내용을 만들지 않는다.
      return { used: value.used as number, calls: value.calls ?? [] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { used: 0, calls: [] }; throw error; }
  }
  async snapshot() { await this.#tail; return { ...await this.#read(), limit: this.limit, maxEffort: this.maxEffort }; }
  async used(): Promise<number> { return (await this.snapshot()).used; }
  async available(): Promise<boolean> { try { return await this.used() < this.limit; } catch { return false; } }
  #queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work); this.#tail = next.catch(() => undefined); return next;
  }
  async #save(ledger: Ledger, call: PaidCall) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await atomicWrite(this.home, 'paid-calls.json', JSON.stringify(ledger));
    try { this.#log?.(structuredClone(call)); } catch { /* 로그 장애가 실행·영속 장부를 바꾸지 않는다. */ }
  }
  take(input: PaidCallInput): Promise<number> {
    return this.#queue(async () => {
      const levels = ['low', 'medium', 'high'];
      if (!levels.includes(input.effort) || levels.indexOf(input.effort) > levels.indexOf(this.maxEffort)) throw new Error('AGENT_EFFORT_LIMIT: owner가 허용한 Effort를 넘습니다.');
      const ledger = await this.#read();
      if (ledger.used >= this.limit) throw new Error('AGENT_CALL_LIMIT: owner가 허용한 유료 호출을 모두 썼습니다.');
      const call: PaidCall = { job: { id: input.job.id, fence: input.job.fence, epoch: input.job.epoch }, agent: input.agent, model: input.model, effort: input.effort, number: ++ledger.used, at: new Date().toISOString(), result: 'unknown' };
      ledger.calls.push(call); await this.#save(ledger, call); return call.number;
    });
  }
  finish(number: number, result: PaidCall['result'], exitCode?: number | null): Promise<void> {
    return this.#queue(async () => {
      const ledger = await this.#read(), call = ledger.calls.find(call => call.number === number);
      if (!call) throw new Error('유료 호출 기록이 없습니다.');
      Object.assign(call, { result, finishedAt: new Date().toISOString(), ...(exitCode !== undefined && { exitCode }) });
      await this.#save(ledger, call);
    });
  }
}

export function paidCallDetail(state: Awaited<ReturnType<PaidCalls['snapshot']>>): string {
  const remaining = Math.max(0, state.limit - state.used);
  const status = state.limit === 0 ? '유료 호출 한도 0: AI 실행 꺼짐' : remaining === 0 ? '유료 호출 한도 도달: AI 실행 꺼짐' : 'AI 실행 예산 있음';
  return [`${status} · ${state.used}/${state.limit}회 사용 · 남은 ${remaining}회 · 최대 ${state.maxEffort} · 하위 Agent 꺼짐`,
    ...state.calls.map(call => `#${call.number} ${call.at} job=${call.job.id} ${call.agent} ${call.model} ${call.effort} 결과=${call.result}${call.exitCode !== undefined ? ` 종료=${String(call.exitCode)}` : ''}`)].join('\n');
}
