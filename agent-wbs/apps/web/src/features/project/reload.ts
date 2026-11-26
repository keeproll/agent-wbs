/**
 * 충돌 창 「최신 내용 불러오기」용 프로젝트 다시 읽기(재리뷰 P2-2).
 * 서버에서 실제로 새로 읽고, 성공해야 화면 캐시를 바꾼다. 실패하면 ApiError를 그대로 던진다.
 * 왜: 공통 useSave는 돌려준 Promise가 실패하면 창을 열어 둔 채 이유를 보인다. invalidate만 하고 끝내면 실패를 성공으로 안내한다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { apiKey, invalidateTopics } from '../../shared/api/queries.ts';
import type { ProjectState } from './labels.ts';

export function useProjectReload(): () => Promise<ProjectState> {
  const { client } = useApi();
  const queryClient = useQueryClient();
  return async () => {
    const latest = await client.call('getProject', {});
    queryClient.setQueryData(apiKey('getProject', {}), latest);
    void invalidateTopics(queryClient, ['alert']);
    return latest;
  };
}
