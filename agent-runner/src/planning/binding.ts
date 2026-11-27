import { createHash } from 'node:crypto';
import type { JudgedContent } from '../api/generated/client.ts';

/*
 * 판단과 「Agent에게 실제로 보여준 입력」을 묶는다(4차 리뷰 P1).
 *
 * 원칙
 * 1. 보낼 내용을 먼저 확정하고, 그 내용에서 판단 대상(투영, projection)을 만들어 두 Agent에게 보여준다.
 * 2. 판단 기록의 `sourceRef`에 보여준 입력의 지문을 붙인다: `<job ID>#input-sha256:<64자>`.
 *    - JudgedContent를 보여줬으면 지문은 서버 subjectHash와 같은 계산(data-model §2.3-1)이다. 서버가 저장하는 변경 후 hash와 바로 대조할 수 있다.
 *    - 그 밖의 입력(초안 Task, CP의 새 Task, 기존 Task의 변경 목록, 분할 ops)은 같은 정규 JSON의 SHA-256이다.
 * 3. 서버로 보내기 직전에 실제 전송 본문에서 투영을 다시 만들어 지문을 비교한다. 다르면 보내지 않는다.
 *    - 새로 만든 본문: 한 번 다시 판단한다. 그래도 다르면 Agent 출력 오류로 멈춘다.
 *    - 진행 기록에서 읽은 본문: 손상으로 보고 멈춘다(CHECKPOINT_UNREADABLE).
 *
 * 왜: 예를 들어 작성자가 충돌 묶음을 새로 고르면, 규칙 판단도 새 묶음을 본 판단이어야 한다.
 *     옛 묶음을 보여 주고 새 묶음과 함께 보내면, 서버는 새 내용의 hash로 판단을 저장해 「보지 않은 전제」가 유효한 판단처럼 기록된다.
 */

export const INPUT_TAG = '#input-sha256:';
const HEX = /^[0-9a-f]{64}$/;
const SPEC_KEYS = ['req', 'work', 'steps', 'inputs', 'outputs', 'files', 'constraints', 'errors', 'docs', 'verify'] as const;
const DESIGN_ORDER = ['DB', 'API', 'FE', 'DevOps'];

/** 서버 canonicalJson과 같은 규칙: 객체 키를 UTF-16 순서로 정렬, undefined 키 제외, 배열 순서 유지, 공백 없음 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 아무 입력의 지문 */
export function fingerprint(value: unknown): string { return sha256(canonicalJson(value)); }

/** JudgedContent의 지문 = 서버 subjectHash(산출물 이름순·설계 종류순·명세 10칸) */
export function judgedContentHash(content: JudgedContent): string {
  const spec = Object.fromEntries(SPEC_KEYS.map((key) => [key, [...((content.spec as Record<string, string[] | undefined>)[key] ?? [])]]));
  return fingerprint({
    title: content.title, scope: [...content.scope], out: [...content.out], doneCond: content.doneCond, spec,
    ac: content.ac.map(({ given, when, then, method }) => ({ given, when, then, method })),
    outputs: [...content.outputs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(({ name, kind, required, verify }) => ({ name, kind, required, verify })),
    designs: [...content.designs].sort((a, b) => DESIGN_ORDER.indexOf(a.kind) - DESIGN_ORDER.indexOf(b.kind)).map(({ kind, content: c }) => ({ kind, content: c })),
    conflictGroup: content.conflictGroup,
  });
}

export function boundRef(jobId: string, inputFingerprint: string): string { return `${jobId}${INPUT_TAG}${inputFingerprint}`; }

export function refFingerprint(sourceRef: unknown): string | null {
  if (typeof sourceRef !== 'string') return null;
  const at = sourceRef.lastIndexOf(INPUT_TAG);
  const hex = at < 0 ? '' : sourceRef.slice(at + INPUT_TAG.length);
  return HEX.test(hex) ? hex : null;
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
