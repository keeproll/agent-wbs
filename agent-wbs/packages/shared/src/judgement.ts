import { createHash } from 'node:crypto';
import { DESIGN_KINDS, type DesignKind } from './vocabulary.ts';

/** 명세 본문의 10개 칸(P SPEC_GROUPS). 저장된 값에 없는 칸은 빈 목록으로 본다. */
export const SPEC_KEYS = ['req', 'work', 'steps', 'inputs', 'outputs', 'files', 'constraints', 'errors', 'docs', 'verify'] as const;
export type SpecBody = Record<(typeof SPEC_KEYS)[number], string[]>;

export interface Overview {
  purpose: string; background: string; scope: string[]; out: string[]; precond: string; doneCond: string;
}
export interface Ac { given: string; when: string; then: string; method: string }
export interface Output { name: string; kind: string; required: boolean; verify: string; delivered: boolean }
export interface Design { kind: DesignKind; content: Record<string, unknown> }

/** DB에 저장된 Task 내용 중 판단 대상 계산에 필요한 부분 */
export interface JudgedSource {
  title: string;
  overview: Overview;
  spec: Partial<Record<string, unknown>>;
  ac: readonly Ac[];
  outputs: readonly Output[];
  designs: readonly Design[];
  conflictGroup: string | null;
}

const lines = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function specBody(spec: Partial<Record<string, unknown>>): SpecBody {
  return Object.fromEntries(SPEC_KEYS.map((key) => [key, lines(spec[key])])) as SpecBody;
}

/**
 * 키를 정렬한 JSON. 배열 순서는 의미가 있으므로 그대로 둔다.
 * Planning(M2-07)이 같은 hash를 계산해야 하므로 규칙을 바꾸면 양쪽을 함께 바꾼다.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * data-model §2.3-1의 JudgedContent. 목적·배경·선행 조건·제출 여부·우선순위·담당·상태는 넣지 않는다.
 * 산출물은 저장 순서가 없어 이름순, 설계는 종류 순서(DB·API·FE·DevOps)로 고정한다.
 */
export function judgedContent(source: JudgedSource) {
  return {
    title: source.title,
    scope: [...source.overview.scope],
    out: [...source.overview.out],
    doneCond: source.overview.doneCond,
    spec: specBody(source.spec),
    ac: source.ac.map(({ given, when, then, method }) => ({ given, when, then, method })),
    outputs: [...source.outputs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(({ name, kind, required, verify }) => ({ name, kind, required, verify })),
    designs: [...source.designs].sort((a, b) => DESIGN_KINDS.indexOf(a.kind) - DESIGN_KINDS.indexOf(b.kind))
      .map(({ kind, content }) => ({ kind, content })),
    conflictGroup: source.conflictGroup,
  };
}

export function subjectHash(source: JudgedSource): string {
  return createHash('sha256').update(canonicalJson(judgedContent(source))).digest('hex');
}
