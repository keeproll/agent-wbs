import type { PoolClient } from '@awbs/db';
import { canonicalJson, iso, refText } from './events.ts';

/** 「이 값은 입력이 잘못됐다」는 뜻의 오류. 라우트가 400 VALIDATION_FAILED로 바꾼다. */
export class InputProblem extends Error {
  readonly path: string;
  readonly rule: string;
  constructor(path: string, rule: string, message: string) {
    super(message);
    this.path = path;
    this.rule = rule;
  }
}

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function seoulMidnight(date: string, path: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new InputProblem(path, 'format', '달력에 없는 날짜입니다.');
  return ms - SEOUL_OFFSET_MS;
}

/**
 * 날짜 필터(`from`·`to`, 둘 다 그날 포함)를 UTC 시각 구간 [from, to)로 바꾼다.
 * 날짜는 팀장 시간대 Asia/Seoul로 자른다(contracts §1, G§9.2-2). 예: 2026-11-26은 UTC 2026-11-25T15:00부터다.
 */
export function seoulDayRange(from: string | undefined, to: string | undefined): { from: string | null; to: string | null } {
  const start = from === undefined ? null : seoulMidnight(from, 'from');
  const end = to === undefined ? null : seoulMidnight(to, 'to') + DAY_MS;
  if (start !== null && end !== null && start >= end) throw new InputProblem('to', 'range', '끝 날짜가 시작 날짜보다 빠릅니다.');
  return { from: start === null ? null : new Date(start).toISOString(), to: end === null ? null : new Date(end).toISOString() };
}

/** 불투명 커서(contracts §1 「클라이언트가 형식을 만들거나 해석하지 않음」). 정렬 키 목록을 base64url JSON으로 싼다. */
export const encodeCursor = (keys: readonly string[]): string => Buffer.from(JSON.stringify(keys)).toString('base64url');

export function decodeCursor(cursor: string, size: number): string[] | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(value) && value.length === size && value.every((item) => typeof item === 'string') ? value as string[] : null;
  } catch { return null; }
}

/** 이력의 변경 전/후는 jsonb다. API는 문자열|null이므로 문자열은 그대로, 그 밖의 값은 정렬 JSON으로 보인다. */
export const valueText = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === 'string' ? value : canonicalJson(value);

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

interface HistoryRow { id: string; at: string; actor: string; task_key: string | null; kind: string; text: string; before: unknown; after: unknown; ref: unknown }

export interface HistoryFilter { from?: string | undefined; to?: string | undefined; actor?: string | undefined; kind?: string | undefined; taskId?: string; limit?: number | undefined; cursor?: string | undefined }

/**
 * 이력 목록(G§4.9: 기간·주체·유형 필터, 변경 전/후, 관련 Task). 최신이 먼저이고, 같은 시각은 id로 순서를 고정한다.
 * 이력은 추가 전용이라 커서 뒤의 행이 바뀌지 않으므로 (at, id) 커서로 빠짐없이 넘길 수 있다.
 */
export async function listHistory(client: PoolClient, filter: HistoryFilter) {
  const range = seoulDayRange(filter.from, filter.to);
  const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const after = filter.cursor === undefined ? null : decodeCursor(filter.cursor, 2);
  if (filter.cursor !== undefined && !after) throw new InputProblem('cursor', 'format', '이력 커서가 올바르지 않습니다.');
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: (n: string) => string, value: unknown) => { values.push(value); where.push(sql(`$${String(values.length)}`)); };
  if (range.from) add((n) => `h.at>=${n}::timestamptz`, range.from);
  if (range.to) add((n) => `h.at<${n}::timestamptz`, range.to);
  if (filter.actor !== undefined) add((n) => `h.actor=${n}`, filter.actor);
  if (filter.kind !== undefined) add((n) => `h.kind=${n}`, filter.kind);
  if (filter.taskId !== undefined) add((n) => `h.task=${n}::uuid`, filter.taskId);
  if (after) {
    values.push(after[0], after[1]);
    where.push(`(h.at,h.id)<($${String(values.length - 1)}::timestamptz,$${String(values.length)}::uuid)`);
  }
  values.push(limit + 1);
  const rows = (await client.query<HistoryRow>(
    `select h.id,${iso('h.at')} as at,h.actor,t.task_key,h.kind,h.text,h.before,h.after,h.ref
     from task_history h left join tasks t on t.id=h.task
     ${where.length ? `where ${where.join(' and ')}` : ''} order by h.at desc,h.id desc limit $${String(values.length)}`, values,
  )).rows;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id, at: row.at, actor: row.actor, taskKey: row.task_key, kind: row.kind, text: row.text,
      before: valueText(row.before), after: valueText(row.after), ref: refText(row.ref),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor([last.at, last.id]) : null,
  };
}
