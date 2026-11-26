/**
 * Task 상세가 읽는 서버 데이터와 저장 도우미.
 *
 * - 9탭의 건수를 처음부터 보여 주기 위해(P L5304 tabsDef) 목록 6종을 함께 읽는다.
 * - 저장은 shared의 useSave를 그대로 쓰고, Task 버전(updatedAt)을 항상 최신 캐시에서 꺼내 보낸다.
 *   왜: 같은 화면에서 저장을 연달아 하면 앞 저장이 버전을 올리므로, 화면을 그릴 때의 값이 아니라 지금 값이 필요하다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
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

export interface TaskSaveOptions<T, P> {
  target: string;
  failTitle?: string;
  /** 충돌 창의 「내 변경」 설명 */
  mine?: string;
  successNotice?: string;
  /** 성공 안내를 요청 내용으로 만든다(누른 순간의 값이 문구에 들어갈 때). */
  notice?: (payload: P) => string;
  /** 누른 순간의 요청 내용(입력 복사). 재시도는 이 값과 같은 키·버전으로 다시 보낸다(M3-01 useSave 규칙). */
  request?: () => P;
  /**
   * 보낼 버전. 편집기는 **편집을 시작했을 때의 버전**을 돌려준다(리뷰 R1).
   * 왜: 변경 polling이 캐시를 최신으로 바꾼 뒤 그 버전으로 보내면, 그 사이 다른 사람이 저장한 내용을 충돌 없이 덮어쓴다.
   * 없으면 누른 순간 캐시의 버전(체크 토글·승인처럼 편집 시작이 없는 한 번짜리 동작).
   */
  version?: () => string;
  /**
   * 요청을 보낸다. 화면 상태를 읽지 말고 payload·updatedAt만 쓴다.
   * current()는 지금 캐시의 최신 Task다. 묶음으로만 저장되는 값(개요·명세)은 「최신 값 + 내가 바꾼 칸」으로 만들어
   * 내가 건드리지 않은 칸을 옛 값으로 되돌리지 않는다.
   */
  run: (ctx: { idempotencyKey: string; updatedAt: string; payload: P; current: () => ResponseOf<'getTask'> | undefined }) => Promise<T>;
  onSuccess?: (result: T, payload: P) => void;
  /** 충돌 창 「최신 내용 불러오기」를 고르면 편집을 닫는다. */
  onReload?: () => void;
  onRejected?: SaveOptions<T, P>['onRejected'];
  onFieldErrors?: SaveOptions<T, P>['onFieldErrors'];
}

/**
 * Task 하나를 바꾸는 저장. shared useSave의 규칙(버튼 「…중」·오류 막대·400·409 충돌 창·같은 키 재시도)을 그대로 받는다.
 * - 버전(updatedAt)은 누른 순간 캐시의 최신 값을 요청 내용과 함께 찍는다. 재시도도 같은 버전으로 보낸다.
 * - 성공하면 Task 캐시를 응답으로 바꾸고 Gate·이력·목록을 다시 읽는다.
 * - 충돌 창 「다시 적용」은 최신 Task를 읽은 뒤 같은 요청 내용을 새 버전으로 다시 보낸다. 실패하면 오류를 던져 창 안에 보인다.
 */
export function useTaskSave<T, P = undefined>(taskKey: string, options: TaskSaveOptions<T, P>) {
  const queryClient = useQueryClient();
  const client = useApi().client;
  const notify = useNotice();
  const key = apiKey('getTask', { params: { taskKey } });
  const current = () => queryClient.getQueryData<ResponseOf<'getTask'>>(key);
  const latest = () => current()?.updatedAt ?? '';
  const refresh = useRefresh(taskKey);
  const last = useRef<{ updatedAt: string; data: P } | null>(null);
  const done = useStableCallback((result: T, payload: P) => {
    const changed = result as { task?: ResponseOf<'getTask'> } | undefined;
    // 응답에 Task가 있으면(TaskChanged) 그것으로 바꾸고, 없으면(의존성 추가·삭제, 분할 요청 등) Task도 다시 읽는다.
    if (changed?.task) queryClient.setQueryData(key, changed.task);
    void refresh(!changed?.task);
    options.onSuccess?.(result, payload);
    if (options.notice) notify(options.notice(payload));
  });
  return useSave<T, { updatedAt: string; data: P }>({
    target: options.target,
    ...(options.failTitle ? { failTitle: options.failTitle } : {}),
    ...(options.mine ? { mine: options.mine } : {}),
    ...(options.successNotice ? { successNotice: options.successNotice } : {}),
    ...(options.onFieldErrors ? { onFieldErrors: options.onFieldErrors } : {}),
    request: () => {
      const payload = { updatedAt: options.version?.() ?? latest(), data: (options.request ? options.request() : undefined) as P };
      last.current = payload;
      return payload;
    },
    run: ({ idempotencyKey, payload }) => options.run({ idempotencyKey, updatedAt: payload.updatedAt, payload: payload.data, current }),
    onSuccess: (result) => { done(result, last.current?.data as P); },
    onRejected: (error) => { void refresh(true); options.onRejected?.(error); },
    onConflictReload: () => { options.onReload?.(); void refresh(true); },
    onConflictReapply: async () => {
      // 최신 버전을 직접 읽는다(실패하면 ApiError가 그대로 던져져 충돌 창이 이유를 보인다).
      const fresh = await queryClient.fetchQuery({ queryKey: key, queryFn: ({ signal }) => client.call('getTask', { params: { taskKey }, signal }), staleTime: 0 });
      const data = last.current?.data as P;
      last.current = { updatedAt: fresh.updatedAt, data };
      const result = await options.run({ idempotencyKey: crypto.randomUUID(), updatedAt: fresh.updatedAt, payload: data, current });
      done(result, data);
      if (options.successNotice) notify(options.successNotice);
    },
  });
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
