/**
 * 충돌 창 「최신 내용 불러오기」·「다시 적용」용 프로젝트 다시 읽기(재리뷰 P2-2, M3-08 재리뷰 signal).
 * 서버에서 실제로 새로 읽고, 성공해야 화면 캐시를 바꾼다. 실패하면 ApiError를 그대로 던진다.
 * - 왜 기다리나: 공통 useSave는 돌려준 Promise가 실패하면 창을 열어 둔 채 이유를 보인다. invalidate만 하고 끝내면 실패를 성공으로 안내한다.
 * - signal: 공통 useSave가 넘긴 취소 신호를 요청에 그대로 넘긴다. 창을 닫아(Esc) 취소됐으면 늦게 온 응답도 캐시에 넣지 않고 던진다.
 *   그래서 호출한 쪽의 다음 줄(선택 지우기 등)도 실행되지 않는다. 왜: 닫은 뒤 새로 고른 입력이 늦은 응답에 지워지면 안 된다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { apiKey, invalidateTopics } from '../../shared/api/queries.ts';
import type { ProjectState } from './labels.ts';

export function useProjectReload(): (signal?: AbortSignal) => Promise<ProjectState> {
  const { client } = useApi();
  const queryClient = useQueryClient();
  return async (signal) => {
    const latest = await client.call('getProject', signal ? { signal } : {});
    signal?.throwIfAborted();
    queryClient.setQueryData(apiKey('getProject', {}), latest);
    void invalidateTopics(queryClient, ['alert']);
    return latest;
  };
}
