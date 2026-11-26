import { StringDecoder } from 'node:string_decoder';

/**
 * CLI 출력 한 줄. JSON 객체면 `json`, 아니면 `unparsed`로 원문을 남긴다(버리지 않는다).
 * - `invalid_json`: JSON이 아닌 줄(예: CLI가 섞어 낸 경고 문구)
 * - `not_object`: JSON이지만 객체가 아님(이벤트가 아님)
 * - `too_long`: 한 줄이 너무 김. 앞부분 `keepBytes`만 `raw`에 남기고 `bytes`에 원래 크기를 적는다.
 * - `truncated`: 줄바꿈 없이 끝난 마지막 조각(스트림 단절)
 */
export type StreamRecord =
  | { kind: 'json'; line: number; raw: string; value: Record<string, unknown> }
  | { kind: 'unparsed'; line: number; raw: string; reason: 'invalid_json' | 'not_object' | 'too_long' | 'truncated'; bytes: number };

export interface DecoderOptions {
  /** 한 줄 최대 바이트. 기본 8 MiB — 큰 명령 출력도 한 이벤트에 담기므로 넉넉히 둔다. */
  maxLineBytes?: number;
  /** 너무 긴 줄에서 남길 앞부분 바이트. 기본 4 KiB. */
  keepBytes?: number;
}

/**
 * JSONL(한 줄에 JSON 하나) 해석기. 파이프 조각의 경계가 줄·글자 중간이어도 된다.
 * 왜 바이트로 세나: 한글처럼 여러 바이트 글자가 조각 경계에서 잘려도 깨지지 않게 하고, 메모리 한도를 바이트로 지키기 위해서다.
 */
export class JsonlDecoder {
  readonly #max: number;
  readonly #keep: number;
  #parts: Buffer[] = [];
  #size = 0;
  #overflow = false;
  #line = 0;

  constructor({ maxLineBytes = 8 * 1024 * 1024, keepBytes = 4096 }: DecoderOptions = {}) {
    this.#max = maxLineBytes;
    this.#keep = keepBytes;
  }

  push(chunk: Buffer | string): StreamRecord[] {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const out: StreamRecord[] = [];
    for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a)) {
      this.#append(buf.subarray(0, nl));
      const record = this.#flush(false);
      if (record) out.push(record);
      buf = buf.subarray(nl + 1);
    }
    this.#append(buf);
    return out;
  }

  /** 입력 끝. 남은 조각이 있으면 완전한 JSON인지 확인하고, 아니면 단절로 남긴다. */
  end(): StreamRecord[] {
    const record = this.#flush(true);
    return record ? [record] : [];
  }

  #append(part: Buffer): void {
    if (part.length === 0) return;
    this.#size += part.length;
    // 이미 한도를 넘었으면 앞부분은 남겨 두었으니 크기만 센다.
    if (this.#overflow) return;
    this.#parts.push(part);
    if (this.#size > this.#max) {
      // 한도를 넘으면 앞부분만 남기고 나머지는 세기만 한다.
      this.#overflow = true;
      this.#parts = [Buffer.concat(this.#parts).subarray(0, this.#keep)];
    }
  }

  #flush(atEnd: boolean): StreamRecord | null {
    // 줄 번호는 빈 줄도 센다. 원본 기록 파일의 줄과 맞추기 위해서다. 입력 끝의 빈 조각은 줄이 아니다.
    if (!atEnd || this.#size > 0) this.#line++;
    const bytes = this.#size;
    const overflow = this.#overflow;
    let body = Buffer.concat(this.#parts);
    this.#parts = [];
    this.#size = 0;
    this.#overflow = false;
    if (body.at(-1) === 0x0d) body = body.subarray(0, -1);
    const raw = new StringDecoder('utf8').end(body);
    if (bytes === 0 || (!overflow && raw.trim() === '')) return null;
    const line = this.#line;
    if (overflow) return { kind: 'unparsed', line, raw, reason: 'too_long', bytes };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: 'unparsed', line, raw, reason: atEnd ? 'truncated' : 'invalid_json', bytes };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'unparsed', line, raw, reason: 'not_object', bytes };
    return { kind: 'json', line, raw, value: value as Record<string, unknown> };
  }
}
