/**
 * Task 실행 명령(실행 요청·중단·재개·완료 판정 요청)을 공통 저장 흐름(useSave)으로 보낸다.
 *
 * - 버튼을 누른 순간의 명령과 Task 버전(updatedAt)을 찍어 둔다. 「다시 시도」는 같은 내용·같은 멱등 키로 보낸다.
 * - 409 VERSION_CONFLICT면 충돌 창: 「최신 불러오기」는 Task를 서버에서 새로 읽고, 「다시 적용」은 최신 버전으로 같은 명령을 다시 보낸다(공통 reapplyRequest).
 * - 409 CLAIM_REJECTED 같은 「지금 상태와 맞지 않음」은 오류 막대에 서버 사유를 그대로 보이고 최신 상태를 다시 읽는다(UAT-EXEC-09 b).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { apiKey, invalidateTopics } from '../../shared/api/queries.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { fetchAllAttempts } from './useExecData.ts';
import type { ExecAttempt, RunKind } from './model.ts';

export type Command =
  | { op: 'run'; kind: RunKind; label: string }
  | { op: 'stop'; attempt: ExecAttempt; label: string }
  | { op: 'resume'; attempt: ExecAttempt; label: string }
  | { op: 'complete'; label: string };

interface Payload { command: Command; updatedAt: string }

const NOTICE: Record<Command['op'], string> = {
  run: '실행을 요청했습니다. Runner가 가져가면 실행 기록에 새 시도가 생깁니다.',
  stop: '실행 중단을 요청했습니다. Runner가 프로세스를 멈추면 시도가 중단으로 기록됩니다.',
  resume: '재개를 요청했습니다. 같은 단계 · 같은 등급의 새 시도로 이어 갑니다.',
  complete: '완료 판정을 다시 요청했습니다.',
};

export const EXEC_TOPICS = ['task', 'attempt', 'verification', 'message', 'alert', 'runner'];

export function useTaskCommand(projectId: string, taskKey: string, updatedAt: string) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const chosen = useRef<Command | null>(null);
  // 누른 명령을 상태로 한 번 그린 뒤 보낸다. 그래야 오류 막대의 「대상」·성공 안내가 이번 명령 문구가 된다.
  const [queued, setQueued] = useState<{ command: Command; n: number } | null>(null);
  const label = queued?.command.label ?? '실행 요청';

  /** Task 버전을 서버에서 새로 읽는다(캐시 아님). 목록 캐시도 최신으로 바꾼다. */
  const latestVersion = async (signal?: AbortSignal) => {
    const list = await client.call('listTasks', { params: { projectId }, ...(signal ? { signal } : {}) });
    // 창을 닫아 취소된 조회는 캐시에 넣지 않는다.
    signal?.throwIfAborted();
    queryClient.setQueryData(apiKey('listTasks', { params: { projectId } }), list);
    const task = list.tasks.find((t) => t.taskKey === taskKey);
    if (!task) throw new Error(`${taskKey}를 찾을 수 없습니다.`);
    return task.updatedAt;
  };
  const latestAttempt = async (id: string, signal?: AbortSignal) => {
    const found = (await fetchAllAttempts(client, taskKey, signal)).find((a) => a.id === id);
    if (!found) throw new Error('시도를 찾을 수 없습니다.');
    return found;
  };

  const send = async ({ command, updatedAt: version }: Payload, key?: string) => {
    const idempotencyKey = key ?? crypto.randomUUID();
    if (command.op === 'run') return client.call('requestRun', { params: { taskKey }, body: { updatedAt: version, kind: command.kind }, idempotencyKey });
    if (command.op === 'stop') {
      return client.call('stopAttempt', {
        params: { attemptId: command.attempt.id }, body: { updatedAt: version, attemptUpdatedAt: command.attempt.updatedAt }, idempotencyKey,
      });
    }
    if (command.op === 'resume') return client.call('resumeAttempt', { params: { attemptId: command.attempt.id }, body: { updatedAt: version }, idempotencyKey });
    return client.call('completeTask', { params: { taskKey }, body: { updatedAt: version }, idempotencyKey });
  };

  const { save, busy, conflictModal } = useSave<unknown, Payload>({
    target: `${taskKey} ${label}`,
    failTitle: '요청하지 못했습니다',
    mine: label,
    request: () => {
      const command = chosen.current;
      if (!command) throw new Error('명령이 없습니다.');
      return { command, updatedAt };
    },
    run: ({ payload, idempotencyKey }) => send(payload, idempotencyKey),
    ...(queued ? { successNotice: NOTICE[queued.command.op] } : {}),
    onSuccess: () => { void invalidateTopics(queryClient, EXEC_TOPICS); },
    onRejected: () => { void invalidateTopics(queryClient, EXEC_TOPICS); },
    // 창을 닫으면(Esc) signal이 취소된다. 취소된 조회 결과는 화면에 적용하지 않는다(M3-01 79c2cc1).
    onConflictReload: async ({ signal }) => {
      await latestVersion(signal);
      await invalidateTopics(queryClient, EXEC_TOPICS);
    },
    // 다시 적용(M3-04 공통 reapplyRequest): 같은 명령을 최신 Task·시도 버전으로 만든다. 보내기는 useSave가 run으로 한다.
    reapplyRequest: async ({ signal }) => {
      const command = chosen.current;
      if (!command) throw new Error('명령이 없습니다.');
      const version = await latestVersion(signal);
      const fresh = command.op === 'stop' || command.op === 'resume' ? { ...command, attempt: await latestAttempt(command.attempt.id, signal) } : command;
      return { command: fresh, updatedAt: version };
    },
  });

  useEffect(() => { if (queued) void save(); }, [queued, save]);

  return {
    busy,
    conflictModal,
    /** 이 명령을 보낸다. 성공·실패 안내는 useSave가 한다. */
    run: (command: Command) => { chosen.current = command; setQueued((q) => ({ command, n: (q?.n ?? 0) + 1 })); },
    pending: busy ? queued?.command ?? null : null,
  };
}
