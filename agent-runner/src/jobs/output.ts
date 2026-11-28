import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AttemptJob } from '../exec/session.ts';
import { EVIDENCE_DIR } from '../git/agent-git.ts';

/*
 * Agent 종료 메시지 계약(contracts §5). Agent가 일을 마치고 마지막에 내는 JSON 하나의 모양이다.
 * - dev·rework: {summary, selfCheck[], followups[], designItems[], responses?[]}
 *   변경 파일은 여기 적지 않는다. Runner가 git diff로 본다(자기보고를 믿지 않는다).
 * - qa·reverify: {verdict, criteria[{acId,result,cmd,expected,actual,evidence}], defects[], responses?[]}
 *   acId는 지시문에 준 체크리스트 항목 키(itemKey)다. 종료 코드·로그는 Runner 관측을 우선한다(§4.13).
 * - responses: 이번 실행에 전달한 메시지에 대한 업무 응답 {messageId,text,workState}. 전달하지 않은 ID는 형식 오류다.
 */

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
export interface MessageResponse { messageId: string; text: string; workState: string }
export interface DevOutput { summary: string; selfCheck: string[]; followups: string[]; designItems: string[]; responses?: MessageResponse[] }
export interface QaCriterion { acId: string; result: Verdict; cmd: string; expected: string; actual: string; evidence: string[] }
export interface QaOutput { verdict: Verdict; criteria: QaCriterion[]; defects: { text: string; blocking: boolean }[]; responses?: MessageResponse[] }

/** 지시문(job.payload.instructions)의 체크리스트 항목. 서버가 qa·reverify job에 넣는다. */
export interface ChecklistItem { itemKey: string; content: string }

/** 한 QA 보고가 올릴 수 있는 증거 파일 수. 넘으면 형식 오류다. */
export const EVIDENCE_FILES_LIMIT = 20;
/** 종료 메시지 원문 상한(256 KiB). 넘으면 형식 오류다. */
export const OUTPUT_LIMIT = 256 * 1024;
const text = { type: 'string', minLength: 1, maxLength: 20_000, pattern: '\\S' } as const;
const list = { type: 'array', maxItems: 200, items: text } as const;
const verdict = { enum: ['PASS', 'FAIL', 'BLOCKED'] } as const;
const responses = { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['messageId', 'text', 'workState'],
  properties: { messageId: { type: 'string', minLength: 1, maxLength: 128 }, text, workState: { ...text, maxLength: 200 } } } } as const;

export const DEV_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'selfCheck', 'followups', 'designItems'],
  properties: { summary: { ...text, maxLength: 4000 }, selfCheck: list, followups: list, designItems: list, responses } } as const;
export const QA_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict', 'criteria', 'defects'],
  properties: {
    verdict,
    criteria: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['acId', 'result', 'cmd', 'expected', 'actual', 'evidence'],
      // evidence: 작업 폴더 `.awbs-evidence/` 안의 파일 이름(EVIDENCE_NAME과 같은 규칙). Runner가 Agent 계정으로 읽어 올린다.
      properties: { acId: { type: 'string', minLength: 1, maxLength: 128 }, result: verdict, cmd: text, expected: text, actual: text,
        evidence: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' } } } } },
    defects: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['text', 'blocking'], properties: { text, blocking: { type: 'boolean' } } } },
    responses,
  } } as const;

const ajv = new Ajv2020({ strict: true, allErrors: true });
const checkDev = ajv.compile<DevOutput>(DEV_SCHEMA);
const checkQa = ajv.compile<QaOutput>(QA_SCHEMA);

export const isVerify = (job: AttemptJob) => job.payload.kind === 'qa' || job.payload.kind === 'reverify';

/** 지시문의 체크리스트. 없거나 모양이 다르면 빈 목록(서버가 주지 않은 키를 지어내지 않는다). */
export function checklistOf(job: AttemptJob): ChecklistItem[] {
  const raw = job.payload.instructions.checklist;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const { itemKey, content } = item as Record<string, unknown>;
    return typeof itemKey === 'string' && itemKey !== '' ? [{ itemKey, content: typeof content === 'string' ? content : '' }] : [];
  });
}

/** 지시문의 명세 버전(서버 task_specs.revision). 없으면 QA 근거를 고정할 수 없으므로 예외다. */
export function specRevisionOf(job: AttemptJob): number {
  const revision = job.payload.instructions.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new Error('지시문에 명세 버전(revision)이 없어 QA 근거를 고정할 수 없습니다.');
  return revision;
}

/** 지시문 끝에 붙이는 Runner 안내. 종료 메시지 형식과 입력 사본 위치를 알린다. */
export function outputGuide(job: AttemptJob, inputPath: string | null): string {
  const lines = ['[Runner 안내]'];
  if (inputPath) lines.push(`입력 문서(prototype/) 읽기 전용 사본: ${inputPath}`);
  if (isVerify(job)) {
    const items = checklistOf(job);
    lines.push('이 작업 폴더는 검사한 커밋 그대로입니다. 파일을 바꾸거나 커밋하지 마세요. 끝날 때 Runner가 HEAD와 청결을 다시 확인합니다.');
    lines.push(`체크리스트(acId로 쓰세요): ${items.length ? items.map(i => `${i.itemKey}=${i.content}`).join(' / ') : '없음'}`);
    lines.push(`마지막 메시지는 다음 JSON 하나만 내세요(설명 없이): ${JSON.stringify(QA_SCHEMA)}`);
    lines.push('모든 체크리스트 항목을 criteria에 한 번씩 넣으세요. verdict가 PASS이면 모든 항목이 PASS여야 합니다.');
    lines.push(`증거 파일(로그·스크린샷 등)은 이 작업 폴더의 ${EVIDENCE_DIR}/ 안에 두고, criteria[].evidence에 파일 이름만 적으세요(예: unit.log). 하위 폴더·링크는 받지 않습니다. 모두 ${String(EVIDENCE_FILES_LIMIT)}개, 파일마다 50 MiB까지입니다.`);
  } else {
    lines.push('변경은 이 작업 폴더의 지금 브랜치에 커밋하세요. 커밋하지 않은 변경이 남으면 ① 검사가 실패합니다. 변경 파일 목록은 Runner가 git으로 봅니다.');
    lines.push(`마지막 메시지는 다음 JSON 하나만 내세요(설명 없이): ${JSON.stringify(DEV_SCHEMA)}`);
  }
  lines.push('전달받은 메시지가 있으면 responses에 messageId별 업무 응답을 넣으세요. 전달받지 않은 ID는 쓰지 마세요.');
  return lines.join('\n');
}

export type Parsed = { ok: true; value: DevOutput | QaOutput } | { ok: false; problems: string[] };

/** 원문에서 JSON 하나를 꺼낸다. 전체가 JSON이거나, 마지막 ```json 코드 블록이어야 한다. 다른 추측은 하지 않는다. */
function extract(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const blocks = [...trimmed.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) throw new SyntaxError('JSON 본문이 없습니다.');
  return JSON.parse(last);
}

/** 스키마 검사 + 의미 검사(전달한 메시지·체크리스트 키·판정 일관성). 문제 목록은 수정 요청 지시문에 그대로 쓴다. */
export function parseOutput(job: AttemptJob, raw: string, delivered: readonly string[]): Parsed {
  if (Buffer.byteLength(raw) > OUTPUT_LIMIT) return { ok: false, problems: [`종료 메시지가 ${String(OUTPUT_LIMIT)}바이트를 넘습니다.`] };
  let value: unknown;
  try { value = extract(raw); } catch (error) { return { ok: false, problems: [`JSON으로 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`] }; }
  const check = isVerify(job) ? checkQa : checkDev;
  if (!check(value)) return { ok: false, problems: (check.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? '계약 위반'}`) };
  const output = value as DevOutput | QaOutput;
  const problems: string[] = [];
  const ids = (output.responses ?? []).map(r => r.messageId);
  if (new Set(ids).size !== ids.length) problems.push('responses에 같은 messageId가 두 번 있습니다.');
  for (const id of ids) if (!delivered.includes(id)) problems.push(`responses의 messageId ${id}는 이번에 전달한 메시지가 아닙니다.`);
  if ('verdict' in output) {
    const keys = checklistOf(job).map(i => i.itemKey);
    const seen = output.criteria.map(c => c.acId);
    if (new Set(seen).size !== seen.length) problems.push('criteria에 같은 acId가 두 번 있습니다.');
    for (const id of seen) if (!keys.includes(id)) problems.push(`criteria의 acId ${id}는 체크리스트 항목이 아닙니다.`);
    for (const id of keys) if (!seen.includes(id)) problems.push(`체크리스트 항목 ${id}의 결과가 criteria에 없습니다.`);
    if (output.verdict === 'PASS' && output.criteria.some(c => c.result !== 'PASS')) problems.push('verdict가 PASS인데 PASS가 아닌 항목이 있습니다.');
    if (output.verdict === 'FAIL' && output.defects.length === 0) problems.push('verdict가 FAIL이면 defects에 결함을 하나 이상 적어야 합니다.');
    if (new Set(output.criteria.flatMap(c => c.evidence)).size > EVIDENCE_FILES_LIMIT) problems.push(`증거 파일은 모두 ${String(EVIDENCE_FILES_LIMIT)}개까지입니다.`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: output };
}

/** 형식 수정 요청 지시문. 같은 세션에서 한 번만 보낸다. */
export function fixPrompt(job: AttemptJob, problems: readonly string[]): string {
  return [
    '직전 종료 메시지가 Runner 계약(contracts §5)과 맞지 않습니다. 이번이 한 번뿐인 수정 요청입니다.',
    '파일을 바꾸거나 커밋하지 마세요. 마지막 메시지로 JSON 하나만 다시 내세요.',
    `문제: ${problems.slice(0, 20).join(' / ')}`,
    `형식: ${JSON.stringify(isVerify(job) ? QA_SCHEMA : DEV_SCHEMA)}`,
  ].join('\n');
}
