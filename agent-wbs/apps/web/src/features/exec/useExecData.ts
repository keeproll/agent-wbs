/**
 * 작업 실행 화면이 읽는 서버 데이터. 모두 계약 operation id로 부른다(shared/README §2).
 * - 왼쪽 목록: Task 목록 + 목록에 보이는 Task마다 시도 목록(계약에 전체 시도 목록 API가 없어서 Task별로 읽는다).
 * - 가운데·오른쪽: 선택 Task의 시도·검증·메시지·Evidence, Runner 상태, 열린 알림, 「실행 중 전달」 설정.
 *
 * 쪽 나눔(M3-06 리뷰 #8): 시도·검증·메시지·Evidence는 nextCursor가 없을 때까지 끝까지 읽는다.
 * 왜: 서버는 id 순서로 주므로 최신 시도가 첫 쪽에 있다는 보장이 없다. 일부만 읽으면 현재 실행을 놓친다.
 */
import { useQueries, useQuery, type QueryFunctionContext } from '@tanstack/react-query';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { PAGE_LIMIT, pageQuery, readAllPages, type Page } from '../../shared/api/allPages.ts';
import type { ApiClient, ApiError } from '../../shared/api/client.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { EXEC_STATUSES, sortAttempts, sortVerifications, type ExecAttempt } from './model.ts';

/** 한 번에 읽는 쪽 크기 — 공통 규칙(shared/api/allPages.ts)과 같은 값 */
export { PAGE_LIMIT };

/** nextCursor가 없을 때까지 모든 쪽을 읽어 합친다. M3 통합: 반복 규칙은 공통 readAllPages가 한다. */
export async function readAll<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  return (await readAllPages(fetchPage)).items;
}
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const fetchAllAttempts = (client: ApiClient, taskKey: string, signal?: AbortSignal) =>
  readAll((cursor) => client.call('getTaskAttempts', { params: { taskKey }, query: pageQuery(cursor), ...withSignal(signal) }));

/** 화면 query key. 「모두 읽음」을 key에 넣어 한 쪽만 읽는 다른 화면의 캐시와 섞이지 않게 한다. */
const allKey = (id: 'getTaskAttempts' | 'getTaskVerifications' | 'getTaskMessages' | 'listEvidence', taskKey: string) =>
  [id, { taskKey }, 'all'] as const;
export const attemptsKey = (taskKey: string) => allKey('getTaskAttempts', taskKey);

export function useExecData(projectId: string, requestedKey: string | undefined) {
  const { client } = useApi();
  const tasks = useApiQuery('listTasks', { params: { projectId } }, { topics: ['task', 'dependency'] });
  const all = tasks.data?.tasks.filter((t) => t.deletedAt === null) ?? [];
  const listed = all
    .filter((t) => EXEC_STATUSES.includes(String(t.lifecycleStatus)))
    .sort((a, b) => a.taskKey.localeCompare(b.taskKey, undefined, { numeric: true }));
  // 주소로 직접 연 Task는 목록 상태가 아니어도(예: 계획 중) 보여 준다.
  // 주소에 Task가 있는데 없는 Task면 다른 Task로 바꾸지 않는다(M3-06 리뷰 #4). 키 없는 /exec만 첫 Task.
  const task = requestedKey === undefined ? listed[0] ?? null : all.find((t) => t.taskKey === requestedKey) ?? null;
  const missingTask = requestedKey !== undefined && tasks.data !== undefined && task === null ? requestedKey : null;

  const attempts = useQueries({
    queries: listed.map((t) => ({
      queryKey: attemptsKey(t.taskKey),
      queryFn: ({ signal }: QueryFunctionContext) => fetchAllAttempts(client, t.taskKey, signal),
      meta: { topics: ['attempt'] },
    })),
  });
  const attemptsByTask = new Map<string, ExecAttempt[]>();
  listed.forEach((t, i) => { const d = attempts[i]?.data; if (d) attemptsByTask.set(t.taskKey, sortAttempts(d)); });

  const key = task?.taskKey ?? '';
  const enabled = task !== null;
  const own = useQuery<ExecAttempt[], ApiError>({
    queryKey: attemptsKey(key), enabled, meta: { topics: ['attempt'] },
    queryFn: ({ signal }) => fetchAllAttempts(client, key, signal),
  });
  const verifications = useQuery<ReturnType<typeof sortVerifications>, ApiError>({
    queryKey: allKey('getTaskVerifications', key), enabled, meta: { topics: ['verification'] },
    queryFn: async ({ signal }) => sortVerifications(await readAll((cursor) =>
      client.call('getTaskVerifications', { params: { taskKey: key }, query: pageQuery(cursor), ...withSignal(signal) }))),
  });
  const messages = useQuery({
    queryKey: allKey('getTaskMessages', key), enabled, meta: { topics: ['message'] },
    queryFn: ({ signal }: QueryFunctionContext) => readAll((cursor) =>
      client.call('getTaskMessages', { params: { taskKey: key }, query: pageQuery(cursor), ...withSignal(signal) })),
  });
  const evidence = useQuery({
    queryKey: allKey('listEvidence', key), enabled, meta: { topics: ['verification'] },
    queryFn: ({ signal }: QueryFunctionContext) => readAll((cursor) =>
      client.call('listEvidence', { query: { taskKey: key, ...pageQuery(cursor) }, ...withSignal(signal) })),
  });
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  const alerts = useApiQuery('listAlerts', {}, { topics: ['alert'] });
  const workflow = useApiQuery('getWorkflowSettings', {}, { topics: ['settings'] });

  return { tasks, listed, task, missingTask, attemptsByTask, own, verifications, messages, evidence, runner, alerts, workflow };
}

export type ExecData = ReturnType<typeof useExecData>;
