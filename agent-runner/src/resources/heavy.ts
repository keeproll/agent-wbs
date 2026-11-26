/**
 * 무거운 작업(빌드·전체 테스트·E2E·pnpm install·병합 대기열·배포 확인) 동시 실행 번호표.
 * Agent 세션과 CI가 같은 인스턴스를 함께 쓴다(G §6.6 「무거운 작업 상한」, §9.6-2-2). 초과분은 들어온 순서대로 기다린다.
 */
export type Release = () => void;

interface Waiter {
  label: string;
  grant: (release: Release) => void;
}

const checkCapacity = (n: number): void => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`무거운 작업 상한이 올바르지 않습니다: ${String(n)}`);
};

export class HeavySemaphore {
  #capacity: number;
  #running = 0;
  readonly #queue: Waiter[] = [];

  constructor(capacity: number) {
    checkCapacity(capacity);
    this.#capacity = capacity;
  }

  /** 서버가 준 무거운 작업 상한으로 바꾼다. 줄여도 실행 중인 작업은 끊지 않는다. */
  resize(capacity: number): void {
    checkCapacity(capacity);
    this.#capacity = capacity;
    this.#drain();
  }

  /** 번호표를 받는다. 받은 쪽은 끝나면 반드시 release를 부른다. `label`은 대기열 표시용. */
  acquire(label: string, signal?: AbortSignal): Promise<Release> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const waiter: Waiter = {
        label,
        grant: (release) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const i = this.#queue.indexOf(waiter);
        if (i >= 0) this.#queue.splice(i, 1);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  snapshot(): { capacity: number; running: number; waiting: number } {
    return { capacity: this.#capacity, running: this.#running, waiting: this.#queue.length };
  }

  /** 대기열의 이름 목록(먼저 온 순) */
  waitingLabels(): string[] {
    return this.#queue.map((w) => w.label);
  }

  #drain(): void {
    while (this.#running < this.#capacity) {
      const next = this.#queue.shift();
      if (!next) return;
      this.#running += 1;
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true;
        this.#running -= 1;
        this.#drain();
      });
    }
  }
}
