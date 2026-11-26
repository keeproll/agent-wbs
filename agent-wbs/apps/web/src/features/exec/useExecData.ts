/**
 * 작업 실행 화면이 읽는 서버 데이터. 모두 계약 operation id로 부른다(shared/README §2).
 * - 왼쪽 목록: Task 목록 + 목록에 보이는 Task마다 시도 목록(계약에 전체 시도 목록 API가 없어서 Task별로 읽는다).
 * - 가운데·오른쪽: 선택 Task의 검증·메시지·Gate, Runner 상태, 열린 알림, 「실행 중 전달」 설정.
 */
import { useQueries } from '@tanstack/react-query';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ApiError } from '../../shared/api/client.ts';
import { apiKey, useApiQuery } from '../../shared/api/queries.ts';
import { EXEC_STATUSES, sortAttempts, type ExecAttempt } from './model.ts';

/** 한 번에 읽는 시도·검증·메시지 수. 계약 최대 크기 안에서 Task 하나의 기록을 모두 받는 값. */
export const PAGE_LIMIT = 200;

export const attemptsArgs = (taskKey: string) => ({ params: { taskKey }, query: { limit: PAGE_LIMIT } });

export function useExecData(projectId: string, selectedKey: string | undefined) {
  const { client } = useApi();
  const tasks = useApiQuery('listTasks', { params: { projectId } }, { topics: ['task', 'dependency'] });
  const all = tasks.data?.tasks.filter((t) => t.deletedAt === null) ?? [];
  const listed = all
    .filter((t) => EXEC_STATUSES.includes(String(t.lifecycleStatus)))
    .sort((a, b) => a.taskKey.localeCompare(b.taskKey, undefined, { numeric: true }));
  // 주소로 직접 연 Task는 목록 상태가 아니어도(예: 계획 중) 보여 준다. 없는 Task면 목록 첫 Task.
  const task = all.find((t) => t.taskKey === selectedKey) ?? listed[0] ?? null;

  const attempts = useQueries({
    queries: listed.map((t) => ({
      queryKey: apiKey('getTaskAttempts', attemptsArgs(t.taskKey)),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.call('getTaskAttempts', { ...attemptsArgs(t.taskKey), signal }),
      meta: { topics: ['attempt'] },
    })),
  });
  const attemptsByTask = new Map<string, ExecAttempt[]>();
  listed.forEach((t, i) => { const d = attempts[i]?.data; if (d) attemptsByTask.set(t.taskKey, sortAttempts(d.items)); });

  const key = task?.taskKey ?? '';
  const enabled = task !== null;
  const own = useApiQuery('getTaskAttempts', attemptsArgs(key), { enabled, topics: ['attempt'], keepPrevious: false });
  const verifications = useApiQuery('getTaskVerifications', { params: { taskKey: key }, query: { limit: PAGE_LIMIT } }, { enabled, topics: ['verification'], keepPrevious: false });
  const messages = useApiQuery('getTaskMessages', { params: { taskKey: key }, query: { limit: PAGE_LIMIT } }, { enabled, topics: ['message'], keepPrevious: false });
  const evidence = useApiQuery('listEvidence', { query: { taskKey: key, limit: PAGE_LIMIT } }, { enabled, topics: ['verification'], keepPrevious: false });
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  const alerts = useApiQuery('listAlerts', {}, { topics: ['alert'] });
  const workflow = useApiQuery('getWorkflowSettings', {}, { topics: ['settings'] });

  const firstError: ApiError | null = tasks.error ?? null;
  return { tasks, listed, task, attemptsByTask, own, verifications, messages, evidence, runner, alerts, workflow, firstError };
}

export type ExecData = ReturnType<typeof useExecData>;
