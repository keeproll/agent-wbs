import { createHash } from 'node:crypto';
import type { JudgedContent } from '../api/generated/client.ts';
import { normalizeJudged } from './judged.ts';

/*
 * 판단과 「Agent에게 실제로 보여준 입력」을 묶는다(4차 리뷰 P1).
 *
 * 원칙
 * 1. 보낼 내용을 먼저 확정하고, 그 내용에서 판단 대상(투영, projection)을 만들어 두 Agent에게 보여준다.
 * 2. 판단 기록의 `sourceRef`에 보여준 입력의 지문을 붙인다: `sha256:<64자>`(서버 계약, srv4 fix3).
 *    - 일반 판단(재판단·CP 판단·CP 새 Task·기존 Task 변경·초안)은 모두 변경 후 JudgedContent(judged.ts)를 보여 준다.
 *      지문은 서버 subjectHash와 같은 계산(JCS·UTF-8·SHA-256)이라, 서버가 저장할 hash와 바로 대조된다.
 *    - 분할 전체 판단(D-34)만 `{ops, splitTasks}`의 같은 계산(서버 splitSubjectHash)이다.
 * 3. 서버로 보내기 직전에 실제 전송 본문에서 투영을 다시 만들어 지문을 비교한다. 다르면 보내지 않는다.
 *    - 새로 만든 본문: 한 번 다시 판단한다. 그래도 다르면 Agent 출력 오류로 멈춘다.
 *    - 진행 기록에서 읽은 본문: 손상으로 보고 멈춘다(CHECKPOINT_UNREADABLE).
 *
 * 왜: 예를 들어 작성자가 충돌 묶음을 새로 고르면, 규칙 판단도 새 묶음을 본 판단이어야 한다.
 *     옛 묶음을 보여 주고 새 묶음과 함께 보내면, 서버는 새 내용의 hash로 판단을 저장해 「보지 않은 전제」가 유효한 판단처럼 기록된다.
 */

/** 서버 계약(srv4 fix3): 판단 입력 지문은 `sha256:<소문자 16진수 64자>`다. */
const REF = /^sha256:([0-9a-f]{64})$/;

export class JcsError extends TypeError { override name = 'JcsError'; }

/**
 * RFC 8785 JCS(JSON Canonicalization Scheme). 서버 packages/shared judgement.ts `jcs`와 같은 규칙이다.
 * - 객체 키를 UTF-16 코드 단위 순서로 정렬, 숫자·문자열은 ECMAScript JSON 표기, 공백 없음
 * - 잘못된 Unicode 문자열·유한하지 않은 수·JSON 밖의 값은 다른 값으로 바꾸지 않고 거부한다
 * - 값이 undefined인 객체 키는 뺀다: 전송 JSON에서 사라지는 키라 서버가 보는 본문과 같아진다
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new JcsError('JCS는 올바른 Unicode 문자열만 받습니다.');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new JcsError('JCS는 유한한 수만 받습니다.');
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${canonicalJson(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new JcsError('JCS는 JSON 값만 받습니다.');
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 아무 입력의 지문: JCS 문자열의 UTF-8 바이트 SHA-256 */
export function fingerprint(value: unknown): string { return sha256(canonicalJson(value)); }

/** JudgedContent의 지문 = 서버 subjectHash(judged.ts normalizeJudged + JCS + SHA-256) */
export function judgedContentHash(content: JudgedContent): string {
  return fingerprint(normalizeJudged(content));
}

/** 판단 기록의 sourceRef: 보여 준 입력의 지문 */
export function boundRef(inputFingerprint: string): string { return `sha256:${inputFingerprint}`; }

export function refFingerprint(sourceRef: unknown): string | null {
  return typeof sourceRef === 'string' ? REF.exec(sourceRef)?.[1] ?? null : null;
}

/** 판단 기록의 모든 항목이 기대 지문의 입력에 묶였는가. 문제가 없으면 null */
export function bindingProblem(record: unknown, expected: string, label: string): string | null {
  const items = (record as { items?: unknown[] } | undefined)?.items;
  if (!Array.isArray(items)) return null;
  for (const [i, item] of items.entries()) {
    const actual = refFingerprint((item as { sourceRef?: unknown }).sourceRef);
    if (actual === null) return `${label} 판단 items[${String(i)}]에 보여준 입력의 지문이 없습니다`;
    if (actual !== expected) return `${label} 판단이 본 입력과 보내는 내용이 다릅니다`;
  }
  return null;
}

/** 판단 기록을 뺀 값(판단 대상 투영에 쓴다) */
export function withoutJudged<T extends object>(value: T): Omit<T, 'judgedRules'> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'judgedRules')) as Omit<T, 'judgedRules'>;
}

/**
 * 판단을 담은 본문을 만든다. 만든 본문이 보여준 입력에 묶이지 않았으면 한 번 다시 판단하고, 그래도 다르면 `fail` 오류로 멈춘다.
 * 이 검사를 통과한 본문만 진행 기록에 남고 전송된다(reporter의 bind가 전송 직전에 같은 검사를 다시 한다).
 */
export async function bound<R>(make: () => Promise<R>, bind: (request: R) => string | null, fail: (problem: string) => Error): Promise<R> {
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const request = await make();
    const found = bind(request);
    if (found === null) return request;
    problem = found;
  }
  throw fail(problem);
}
