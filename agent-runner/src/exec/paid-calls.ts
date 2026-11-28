import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../state/files.ts';

/** 홈 잠금 아래 영속 순번. 실패·중단된 호출도 소비하며 초기화(epoch)나 재시작으로 되돌리지 않는다. */
export class PaidCalls {
  #tail: Promise<unknown> = Promise.resolve();
  readonly home: string;
  readonly limit: number;
  readonly maxEffort: string;
  constructor(home: string, limit: number, maxEffort = 'high') {
    this.home = home; this.limit = limit; this.maxEffort = maxEffort;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 30) throw new Error('AWBS_AGENT_CALL_LIMIT는 0~30 정수여야 합니다.');
    if (!['low', 'medium', 'high'].includes(maxEffort)) throw new Error('AWBS_AGENT_MAX_EFFORT는 low·medium·high 중 하나여야 합니다.');
  }
  async used(): Promise<number> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.home, 'paid-calls.json'), 'utf8'));
      if (!value || typeof value !== 'object' || !('used' in value) || !Number.isSafeInteger(value.used) || (value.used as number) < 0) throw new Error('유료 호출 기록이 손상되었습니다. 원본을 보존하세요.');
      return value.used as number;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  }
  async available(): Promise<boolean> { await this.#tail; return await this.used() < this.limit; }
  take(effort: string): Promise<void> {
    const next = this.#tail.then(async () => {
      const levels = ['low', 'medium', 'high'];
      if (!levels.includes(effort) || levels.indexOf(effort) > levels.indexOf(this.maxEffort)) throw new Error('AGENT_EFFORT_LIMIT: owner가 허용한 Effort를 넘습니다.');
      const used = await this.used();
      if (used >= this.limit) throw new Error('AGENT_CALL_LIMIT: owner가 허용한 유료 호출을 모두 썼습니다.');
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      await atomicWrite(this.home, 'paid-calls.json', JSON.stringify({ used: used + 1 }));
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
