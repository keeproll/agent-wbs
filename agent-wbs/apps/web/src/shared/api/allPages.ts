/**
 * 페이지로 나뉜 목록(`{ items, nextCursor }`)을 끝까지 모두 읽는 query.
 *
 * 왜 필요한가: 검증·Evidence·이력 목록은 서버가 한 번에 최대 200건씩 준다(contracts §1 cursor).
 * 화면의 판정·Agent 필터, 건수(탭 숫자), 「전체 N건 중」은 모든 행을 알아야 서버와 일치한다(UAT-VERIFY-01 b).
 * 첫 쪽만 보고 「없다」고 하면 안 된다(M3-05 알림 링크 판정과 같은 이유).
 *
 * 쓰는 법(useApiQuery와 같은 인수):
 *   const v = useAllPages('listVerifications', { query: { result: 'FAIL' } }, { topics: ['verification'] });
 *   v.data?.items  // 모든 쪽을 이어 붙인 목록
 *
 * - 한 번에 200건(계약 최대)씩 요청한다. 같은 cursor가 다시 오면 멈춘다(서버 결함으로 무한 반복하지 않게).
 * - 변경 이벤트 topic, 이전 데이터 유지(keepPrevious)는 useApiQuery와 같다.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ApiClient, ApiError, CallArgs } from './client.ts';
import type { OperationId, ResponseOf } from './contract.ts';
import { useApi } from './ApiProvider.tsx';
import type { ApiQueryOptions } from './queries.ts';

/** 응답이 `{ items, nextCursor }` 모양인 요청 */
export type PagedId = {
  [K in OperationId]: ResponseOf<K> extends { items: readonly unknown[]; nextCursor: string | null } ? K : never;
}[OperationId];
export type ItemOf<Id extends PagedId> = ResponseOf<Id> extends { items: readonly (infer T)[] } ? T : never;

export const PAGE_LIMIT = 200;
/** 이보다 많은 쪽은 읽지 않는다(4만 건). 넘으면 truncated=true */
export const MAX_PAGES = 200;

export interface AllPages<T> { items: T[]; truncated: boolean }

/** 한 쪽 응답 모양(계약 cursor 목록). */
export interface Page<T> { items: readonly T[]; nextCursor: string | null }

/**
 * cursor 목록을 한 쪽씩 넘기는 **공통 반복 규칙**. 모든 「끝까지 읽기」·「끝까지 찾기」가 이 함수를 쓴다(M3 통합).
 * - fetchPage(cursor): 그 쪽을 읽는다. 첫 쪽은 cursor가 undefined다. 한 쪽 크기는 PAGE_LIMIT(계약 최대 200)로 요청한다.
 * - onPage(items): 받은 쪽을 처리한다. true를 돌려주면 더 읽지 않는다(찾았을 때).
 * - 같은 cursor가 다시 오면 멈춘다. MAX_PAGES 쪽을 넘으면 truncated=true로 멈춘다.
 * 왜 한 곳에: 화면마다 따로 만든 반복은 무한 반복 방지·쪽 크기가 서로 달랐다. 규칙을 고칠 때 한 곳만 고치면 된다.
 */
export async function eachPage<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  onPage: (items: readonly T[]) => boolean,
): Promise<{ truncated: boolean }> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(cursor);
    if (onPage(res.items) === true) return { truncated: false };
    if (!res.nextCursor || seen.has(res.nextCursor)) return { truncated: false };
    seen.add(res.nextCursor);
    cursor = res.nextCursor;
  }
  return { truncated: true };
}

/** 모든 쪽을 이어 붙인다. */
export async function readAllPages<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): Promise<AllPages<T>> {
  const items: T[] = [];
  const { truncated } = await eachPage(fetchPage, (page) => { items.push(...page); return false; });
  return { items, truncated };
}

/** 끝까지 넘기며 match에 맞는 첫 항목을 찾는다. 끝까지 없으면 null. 단건 조회 API가 없는 목록(CP·Planning 세션·메시지)에 쓴다. */
export async function findInPages<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>, match: (item: T) => boolean): Promise<T | null> {
  let hit: T | null = null;
  await eachPage(fetchPage, (page) => { hit = page.find(match) ?? null; return hit !== null; });
  return hit;
}

/** 계약 cursor 질의(한 쪽 PAGE_LIMIT건). */
export const pageQuery = (cursor: string | undefined) => ({ limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });

export function fetchAllPages<Id extends PagedId>(
  client: ApiClient,
  id: Id,
  args: Omit<CallArgs<Id>, 'signal'>,
  signal?: AbortSignal,
): Promise<AllPages<ItemOf<Id>>> {
  return readAllPages((cursor) => {
    const query = { ...((args as { query?: object }).query ?? {}), ...pageQuery(cursor) };
    return client.call(id, { ...args, query, ...(signal ? { signal } : {}) } as CallArgs<Id>) as unknown as Promise<Page<ItemOf<Id>>>;
  });
}

export function useAllPages<Id extends PagedId>(
  id: Id,
  args: Omit<CallArgs<Id>, 'signal'>,
  options: ApiQueryOptions = {},
): UseQueryResult<AllPages<ItemOf<Id>>, ApiError> {
  const { client } = useApi();
  return useQuery<AllPages<ItemOf<Id>>, ApiError>({
    queryKey: ['allPages', id, args] as const,
    queryFn: ({ signal }) => fetchAllPages(client, id, args, signal),
    enabled: options.enabled ?? true,
    meta: { topics: options.topics ?? [] },
    ...(options.keepPrevious === false ? {} : { placeholderData: keepPreviousData }),
  });
}
