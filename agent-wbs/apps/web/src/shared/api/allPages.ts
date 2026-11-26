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

export async function fetchAllPages<Id extends PagedId>(
  client: ApiClient,
  id: Id,
  args: Omit<CallArgs<Id>, 'signal'>,
  signal?: AbortSignal,
): Promise<AllPages<ItemOf<Id>>> {
  const items: ItemOf<Id>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = { ...((args as { query?: object }).query ?? {}), limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) };
    const res = (await client.call(id, { ...args, query, ...(signal ? { signal } : {}) } as CallArgs<Id>)) as unknown as {
      items: ItemOf<Id>[]; nextCursor: string | null;
    };
    items.push(...res.items);
    if (!res.nextCursor || seen.has(res.nextCursor)) return { items, truncated: false };
    seen.add(res.nextCursor);
    cursor = res.nextCursor;
  }
  return { items, truncated: true };
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
