/**
 * Task 상세가 읽는 서버 데이터와 저장 도우미.
 *
 * - 9탭의 건수를 처음부터 보여 주기 위해(P L5304 tabsDef) 목록 6종을 함께 읽는다.
 * - 저장은 shared의 useSave를 그대로 쓰고, Task 버전(updatedAt)을 항상 최신 캐시에서 꺼내 보낸다.
 *   왜: 같은 화면에서 저장을 연달아 하면 앞 저장이 버전을 올리므로, 화면을 그릴 때의 값이 아니라 지금 값이 필요하다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { apiKey, useApiQuery, type ChangeTopic } from '../../shared/api/queries.ts';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { useSave, type SaveOptions } from '../../shared/state/useSave.tsx';
import { useNotice, useStableCallback } from '../../shared/ui/feedback.tsx';

const TASK_TOPICS: ChangeTopic[] = ['task', 'dependency', 'schedule'];
const HISTORY_TOPICS: ChangeTopic[] = ['task', 'dependency', 'attempt', 'verification', 'message', 'schedule'];

export function useTaskData(taskKey: string, projectId: string) {
  const params = { taskKey };
  const task = useApiQuery('getTask', { params }, { topics: TASK_TOPICS, keepPrevious: false });
  const gate = useApiQuery('getTaskGate', { params }, { topics: ['task', 'verification', 'attempt'], keepPrevious: false });
  const history = useApiQuery('getTaskHistory', { params, query: { limit: 200 } }, { topics: HISTORY_TOPICS, keepPrevious: false });
  const attempts = useApiQuery('getTaskAttempts', { params, query: { limit: 100 } }, { topics: ['attempt'], keepPrevious: false });
  const verifications = useApiQuery('getTaskVerifications', { params, query: { limit: 100 } }, { topics: ['verification'], keepPrevious: false });
  const messages = useApiQuery('getTaskMessages', { params, query: { limit: 100 } }, { topics: ['message'], keepPrevious: false });
  const evidence = useApiQuery('listEvidence', { query: { taskKey, limit: 200 } }, { topics: ['verification', 'attempt'], keepPrevious: false });
  // 선행·후속 Task의 제목·상태, 의존성 후보, 레일 순서를 위해 WBS 목록을 함께 읽는다(M3-02와 같은 query key라 캐시를 나눠 쓴다).
  const list = useApiQuery('listTasks', { params: { projectId }, query: {} }, { topics: ['task', 'dependency'] });
  return { task, gate, history, attempts, verifications, messages, evidence, list };
}

export type TaskChanged = ResponseOf<'updateTask'>;

/**
 * Task 하나를 바꾸는 저장. useSave의 규칙(버튼 「…중」·오류 막대·400·409 충돌 창)을 그대로 받는다.
 * - run에는 최신 updatedAt이 들어온다.
 * - 성공하면 Task 캐시를 응답으로 바꾸고 Gate·이력·목록을 다시 읽는다.
 * - 충돌 창 「최신 불러오기」는 편집을 닫고(onReload) 최신을 읽는다. 「다시 적용」은 최신을 읽은 뒤 같은 저장을 다시 한다.
 */
export function useTaskSave<T>(taskKey: string, options: Omit<SaveOptions<T>, 'run' | 'onConflictReload' | 'onConflictReapply'> & {
  run: (ctx: { idempotencyKey: string; updatedAt: string }) => Promise<T>;
  onReload?: () => void;
  /** 성공 안내 문구를 성공한 순간에 만든다. 누른 순간의 값(ref)으로 문구를 만들어야 할 때 쓴다. */
  notice?: () => string;
}) {
  const notify = useNotice();
  const queryClient = useQueryClient();
  const key = apiKey('getTask', { params: { taskKey } });
  const latest = () => (queryClient.getQueryData<ResponseOf<'getTask'>>(key))?.updatedAt ?? '';
  const refresh = useRefresh(taskKey);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const handle = useSave<T>({
    ...options,
    run: ({ idempotencyKey }) => options.run({ idempotencyKey, updatedAt: latest() }),
    onSuccess: (result) => {
      const changed = result as { task?: ResponseOf<'getTask'> } | undefined;
      if (changed?.task) queryClient.setQueryData(key, changed.task);
      void refresh(false);
      options.onSuccess?.(result);
      if (options.notice) notify(options.notice());
    },
    onRejected: (error) => { void refresh(true); options.onRejected?.(error); },
    onConflictReload: () => { options.onReload?.(); void refresh(true); },
    onConflictReapply: async () => { await refresh(true); await saveRef.current(); },
  });
  useEffect(() => { saveRef.current = handle.save; });
  return handle;
}

/** 이 Task와 관련된 데이터를 다시 읽는다. withTask=false면 Task 본문은 응답으로 이미 바꿨으니 건너뛴다. */
export function useRefresh(taskKey: string) {
  const queryClient = useQueryClient();
  return useStableCallback(async (withTask: boolean) => {
    const ids = ['getTaskGate', 'getTaskHistory', 'listTasks', 'getTaskAttempts', 'getTaskVerifications', 'getTaskMessages', 'listEvidence', ...(withTask ? ['getTask'] : [])];
    await queryClient.invalidateQueries({
      predicate: (q) => {
        if (!ids.includes(q.queryKey[0] as string)) return false;
        if (q.queryKey[0] === 'listTasks') return true;
        const args = q.queryKey[1] as { params?: { taskKey?: string }; query?: { taskKey?: string } } | undefined;
        return args?.params?.taskKey === taskKey || args?.query?.taskKey === taskKey;
      },
    });
  });
}

/** 다른 Task들의 상세(기술 설계 FK 검사에서 다른 Task의 테이블을 알기 위해). 편집기를 열 때만 읽는다. */
export function useApiClient() {
  return useApi().client;
}
