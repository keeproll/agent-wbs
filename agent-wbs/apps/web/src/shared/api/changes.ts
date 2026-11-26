/**
 * 변경 이벤트 polling(architecture §2.1, contracts §7).
 * 화면이 보이면 3초, 숨겨져 있으면 30초마다 `GET /api/changes`를 부르고,
 * 바뀐 topic의 query만 다시 불러온다. reset이면 전부 다시 불러온다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useApi } from './ApiProvider.tsx';
import { invalidateTopics } from './queries.ts';

export const CHANGE_POLL_MS = { visible: 3_000, hidden: 30_000 } as const;

export function useChangeFeed(enabled: boolean): void {
  const { client } = useApi();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let cursor: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const controller = new AbortController();
    const tick = async () => {
      try {
        // 처음에는 지금 위치(커서)만 잡는다. 화면 데이터는 이미 새로 불러왔기 때문이다.
        let after = cursor ?? 0;
        const topics = new Set<string>();
        let reset = false;
        for (;;) {
          const page = await client.call('getChanges', { query: { after, limit: 500 }, signal: controller.signal });
          if (page.reset) reset = true;
          for (const event of page.events) topics.add(String(event.topic));
          after = page.next;
          if (page.events.length < 500) break;
        }
        if (cursor !== null && (reset || topics.size > 0)) await invalidateTopics(queryClient, reset ? 'all' : [...topics]);
        cursor = after;
      } catch {
        // 실패는 다음 주기에 다시 시도한다. 자동 처리 실패는 오류 막대로 띄우지 않는다(G§0.3).
      }
      if (!stopped) timer = setTimeout(() => { void tick(); }, document.hidden ? CHANGE_POLL_MS.hidden : CHANGE_POLL_MS.visible);
    };
    void tick();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [client, enabled, queryClient]);
}
