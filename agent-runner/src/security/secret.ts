import { inspect } from 'node:util';

/** 문자열 변환·JSON·inspect로 값이 새지 않는 비밀값. 필요한 곳에서만 reveal()을 부른다. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [inspect.custom](): string {
    return '[REDACTED]';
  }
}
