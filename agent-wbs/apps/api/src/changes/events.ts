import type { Pool, PoolClient } from '@awbs/db';

/**
 * 변경 이벤트(contracts §7). 화면은 이 목록으로 「무엇이 바뀌었는지」만 알고, 내용은 조회 API로 다시 읽는다.
 * 본문을 싣지 않고 참조(ref)만 싣는 이유: 조회 API의 권한 검사·최신값 보장을 이벤트가 우회하지 않게 하려는 것이다.
 */
export const CHANGE_TOPICS = [
  'task', 'dependency', 'attempt', 'verification', 'message', 'proposal', 'planning', 'schedule',
  'runner', 'ci', 'design', 'report', 'mail', 'notify', 'alert', 'project', 'settings',
] as const;
export type ChangeTopic = (typeof CHANGE_TOPICS)[number];
/** DB에는 jsonb로 저장한다. 화면이 다시 읽을 대상을 가리키는 짧은 값만 넣는다(예: `{taskKey}`·`{id}`·`{key}`). */
export type ChangeRef = string | Readonly<Record<string, unknown>> | null;

/**
 * 모든 이벤트 쓰기가 커밋까지 잡는 잠금. seq(bigserial)는 번호를 먼저 받은 트랜잭션이 나중에 커밋할 수 있어,
 * 잠금 없이 쓰면 화면이 큰 번호를 먼저 보고 작은 번호를 영영 놓칠 수 있다. 잠금을 커밋까지 잡으면
 * 「번호 순서 = 커밋 순서」가 되어(contracts §7 「프로젝트 잠금 안에서 seq 발급」) 조회 쪽은 잠그지 않아도 된다.
 * 잠금 순서(data-model §5.1)상 「그 외」에 속하므로 업무 행 잠금을 모두 잡은 뒤, 트랜잭션 끝 무렵에 부른다.
 */
export const CHANGE_LOCK = 'awbs:change-events';

export async function emitChange(client: PoolClient, projectId: string | null, topic: ChangeTopic, ref: ChangeRef): Promise<void> {
  if (!CHANGE_TOPICS.includes(topic)) throw new Error(`알 수 없는 변경 이벤트 topic: ${String(topic)}`);
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [CHANGE_LOCK]);
  await client.query('insert into change_events(project_id,topic,ref) values($1,$2,$3::jsonb)', [projectId, topic, JSON.stringify(ref)]);
}

/**
 * 한 트랜잭션의 변경 이벤트를 모았다가 마지막에 한 번에 쓴다.
 * 이벤트 잠금(CHANGE_LOCK)은 커밋까지 잡히므로, 업무 행(Task 등)을 잠그기 전에 잡으면
 * 「Task를 먼저 잡고 나중에 이벤트를 쓰는」 다른 트랜잭션과 서로 기다리는 교착이 생긴다(리뷰 지적 2).
 * 잠금 순서: epoch → 조정 잠금(설정 행, M2-05의 runner-dispatch와 같은 자리) → Task(id 순) → job → 변경 이벤트 잠금(항상 마지막).
 */
export class ChangeBatch {
  private readonly items: { projectId: string | null; topic: ChangeTopic; ref: ChangeRef }[] = [];
  add(projectId: string | null, topic: ChangeTopic, ref: ChangeRef): void {
    if (!this.items.some((item) => item.projectId === projectId && item.topic === topic && JSON.stringify(item.ref) === JSON.stringify(ref))) {
      this.items.push({ projectId, topic, ref });
    }
  }
  /** 트랜잭션의 모든 업무 잠금·변경을 끝낸 뒤 부른다. */
  async emit(client: PoolClient): Promise<void> {
    for (const item of this.items) await emitChange(client, item.projectId, item.topic, item.ref);
    this.items.length = 0;
  }
}

/**
 * 트랜잭션 중간에서 쓰는 변경 이벤트. 그 자리에서 이벤트 잠금을 잡으면 뒤이어 잡는 업무 행 잠금과 교착할 수 있어,
 * 연결(트랜잭션)별로 모아 두었다가 커밋 직전 `flushChanges`가 한 번에 쓴다(잠금은 항상 마지막).
 * 쓰기 트랜잭션을 여는 곳(공통 관문 `finish`, `inEpoch`)은 커밋 직전에 flushChanges, 되돌릴 때 dropChanges를 부른다.
 * 연결은 풀에서 재사용되므로 되돌릴 때 반드시 비워야 다음 트랜잭션에 섞이지 않는다.
 */
const deferred = new WeakMap<object, ChangeBatch>();
export function deferChange(client: Pick<PoolClient, 'query'>, projectId: string | null, topic: ChangeTopic, ref: ChangeRef): void {
  if (!CHANGE_TOPICS.includes(topic)) throw new Error(`알 수 없는 변경 이벤트 topic: ${String(topic)}`);
  let batch = deferred.get(client);
  if (!batch) { batch = new ChangeBatch(); deferred.set(client, batch); }
  batch.add(projectId, topic, ref);
}
/** 커밋 직전에 부른다. 모아 둔 이벤트를 이벤트 잠금 아래에서 쓴다. */
export async function flushChanges(client: PoolClient): Promise<void> {
  const batch = deferred.get(client);
  if (!batch) return;
  deferred.delete(client);
  await batch.emit(client);
}
/** 되돌리는 트랜잭션의 모아 둔 이벤트를 버린다. */
export function dropChanges(client: PoolClient): void { deferred.delete(client); }

/** 키를 정렬한 JSON. 같은 내용이면 항상 같은 문자열이다. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const REF_KEYS = ['taskKey', 'id', 'key'] as const;

/**
 * DB jsonb 참조를 API 문자열로 바꾼다(API `ref`는 문자열|null). 조정자 승인 기본안(2026-11-26):
 * 문자열은 그대로, 객체는 taskKey → id → key 순서의 문자열 값, 그런 값이 없으면 정렬 JSON.
 */
export function refText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of REF_KEYS) {
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === 'string') return item;
    }
  }
  return canonicalJson(value);
}

export interface ChangeRow { seq: number; topic: string; ref: unknown; at: string }
export interface ChangesPage { events: { seq: number; topic: string; ref: string | null; at: string }[]; next: number; reset: boolean }

/**
 * 조회 결과를 만든다.
 * - 화면 커서(after)는 화면이 받은 이벤트의 seq이거나 0(처음)이다.
 * - 그 행이 지워졌다면(7일 보존 정리, 또는 초기화가 표 전체를 비움) 사이의 이벤트를 놓쳤을 수 있으므로 reset:true다.
 *   번호가 중간에 비는 것(실패·취소된 트랜잭션)은 정상이라 「빈 번호」로는 판단하지 않는다.
 * - reset일 때 next는 남은 최신 seq다. 하나도 없으면 0으로 돌려, 다음 조회가 다시 reset되지 않게 한다.
 */
export function changesPage(input: { after: number; limit: number; cursorFound: boolean; rows: readonly ChangeRow[]; latest: number | null }): ChangesPage {
  if (input.after > 0 && !input.cursorFound) return { events: [], next: input.latest ?? 0, reset: true };
  const events = input.rows.slice(0, input.limit).map((row) => ({ seq: row.seq, topic: row.topic, ref: refText(row.ref), at: row.at }));
  return { events, next: events.at(-1)?.seq ?? input.after, reset: false };
}

export const iso = (column: string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function readChanges(client: PoolClient, after: number, limit: number): Promise<ChangesPage> {
  const rows = (await client.query<ChangeRow>(
    `select seq::bigint::float8 as seq,topic,ref,${iso('at')} as at from change_events where seq>$1 order by seq limit $2`, [after, limit],
  )).rows;
  const cursorFound = after > 0 && Boolean((await client.query('select 1 from change_events where seq=$1', [after])).rowCount);
  const latest = (await client.query<{ seq: number | null }>('select max(seq)::float8 as seq from change_events')).rows[0]?.seq ?? null;
  return changesPage({ after, limit, cursorFound, rows, latest });
}

/** 7일 보존 정리(data-model §2.8). DB 함수만 지울 수 있다. 지운 건수를 돌려준다. */
export async function pruneChanges(pool: Pool): Promise<number> {
  return (await pool.query<{ n: number }>('select public.prune_change_events() as n')).rows[0]?.n ?? 0;
}

/** 보존 정리를 주기적으로 실행한다. 실패는 기록만 하고 다음 주기에 다시 한다. 반환 함수로 멈춘다. */
export function startChangePruner(pool: Pool, onError: (error: unknown) => void, everyMs = 60 * 60 * 1000): () => void {
  const timer = setInterval(() => { pruneChanges(pool).catch(onError); }, everyMs);
  timer.unref();
  return () => { clearInterval(timer); };
}
