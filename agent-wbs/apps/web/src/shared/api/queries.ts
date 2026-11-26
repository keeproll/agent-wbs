/**
 * 서버 데이터 읽기(TanStack Query) 도우미.
 *
 * - query key는 `[요청 이름, 인수]`로 통일한다. 예: `['getTask', { params: { taskKey: 'TASK-0007' } }]`.
 * - `topics`는 이 데이터를 바꾸는 변경 이벤트 종류다(contracts §7). 변경 이벤트가 오면 그 topic의 query만 다시 불러온다.
 */
import { keepPreviousData, useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ApiError, CallArgs } from './client.ts';
import type { OperationId, ResponseOf } from './contract.ts';
import { useApi } from './ApiProvider.tsx';

/** 변경 이벤트 topic(contracts §7) */
export type ChangeTopic =
  | 'task' | 'dependency' | 'attempt' | 'verification' | 'message' | 'proposal' | 'planning' | 'schedule'
  | 'runner' | 'ci' | 'design' | 'report' | 'mail' | 'notify' | 'alert' | 'project' | 'settings';

export const apiKey = <Id extends OperationId>(id: Id, args?: Omit<CallArgs<Id>, 'signal'>) => [id, args ?? {}] as const;

export interface ApiQueryOptions {
  enabled?: boolean;
  topics?: readonly ChangeTopic[];
  /** 조건(필터·정렬)이 바뀌어도 새 응답이 올 때까지 이전 데이터를 보여 준다. 기본 true(G§0.3). */
  keepPrevious?: boolean;
}

export function useApiQuery<Id extends OperationId>(
  id: Id,
  args: Omit<CallArgs<Id>, 'signal'>,
  options: ApiQueryOptions = {},
): UseQueryResult<ResponseOf<Id>, ApiError> {
  const { client } = useApi();
  return useQuery<ResponseOf<Id>, ApiError>({
    queryKey: apiKey(id, args),
    queryFn: ({ signal }) => client.call(id, { ...args, signal } as CallArgs<Id>),
    enabled: options.enabled ?? true,
    meta: { topics: options.topics ?? [] },
    ...(options.keepPrevious === false ? {} : { placeholderData: keepPreviousData }),
  });
}

/** 변경 이벤트의 topic을 쓰는 query만 다시 불러온다. reset이면 전부. */
export function invalidateTopics(queryClient: QueryClient, topics: readonly string[] | 'all'): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      if (query.queryKey[0] === 'getSession' || query.queryKey[0] === 'getChanges') return false;
      if (topics === 'all') return true;
      const own = (query.meta?.topics ?? []) as readonly string[];
      return own.some((topic) => topics.includes(topic));
    },
  });
}
