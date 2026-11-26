/**
 * 작업 실행(UI-06, P L1747–1856) — 3분할: 왼쪽 Task · 시도 목록 / 가운데 다음 작업 · 결과 · 기록 / 오른쪽 연결 메시지.
 *
 * 주소(안정 키):
 * - `/exec` — 목록의 첫 Task
 * - `/exec/:taskKey` — 그 Task(Task 상세 실행 탭·알림 링크가 여는 주소, UAT-TASK-10 b)
 * - `/exec/:taskKey?att=<attemptKey>` — 그 시도. 없는 시도면 고르지 않는다(UAT-EMPTY-03).
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { MenuScreen, useRefreshError, useRevisitFetching } from '../../shared/layout/MenuScreen.tsx';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { PageSkeleton, useDelayedFlag } from '../../shared/ui/loading.tsx';
import { useTopBar } from '../../shared/ui/feedback.tsx';
import { ExecCenter } from './ExecCenter.tsx';
import { ExecMessages } from './ExecMessages.tsx';
import { ExecRail } from './ExecRail.tsx';
import { flowOf, nextStep, pickAttempt, runnerReason, sortAttempts, type RunnerSlice } from './model.ts';
import { useExecData } from './useExecData.ts';

/** contracts §3.5: 같은 종류 연속 실패는 최초 포함 총 3회, 자동 재작업은 Task당 3회 */
export const AUTO_LIMITS = { retry: 3, rework: 3 } as const;
const TITLE = '작업 실행';
const SUB = '개발 → QA → 재작업 → 재검증 → Completion Gate → 완료 · 첫 개발만 팀장이 시작하고, 이후 단계는 서버가 Runner 보고에 따라 자동으로 이어 갑니다';

export function ExecPage() {
  return <MenuScreen menu="exec">{(project) => ('id' in project ? <ExecBody projectId={String(project.id)} /> : null)}</MenuScreen>;
}

/** 실행 중 시도의 「실행 시간」을 1분마다 다시 그린다. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 60_000);
    return () => { clearInterval(timer); };
  }, []);
  return now;
}

function ExecBody({ projectId }: { projectId: string }) {
  useDocumentTitle(TITLE);
  const now = useNow();
  const { taskKey } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const data = useExecData(projectId, taskKey);
  const [reworkFor, setReworkFor] = useState<string | null>(null);
  useTopBar(useRevisitFetching(data.tasks));
  useRefreshError(data.tasks, '작업 실행 최신 내용 불러오기');
  useRefreshError(data.own, '실행 기록 최신 내용 불러오기');
  const skeleton = useDelayedFlag(data.tasks.isPending);

  if (data.tasks.data === undefined && data.tasks.isError) {
    return <LoadError title={TITLE} error={data.tasks.error} retrying={data.tasks.isFetching} onRetry={() => { void data.tasks.refetch(); }} />;
  }
  if (data.tasks.data === undefined) return <div className="page scroll">{skeleton && <PageSkeleton menu="exec" />}</div>;

  const task = data.task;
  const attempts = task ? sortAttempts(data.own.data?.items ?? data.attemptsByTask.get(task.taskKey) ?? []) : [];
  const verifications = data.verifications.data?.items ?? [];
  const { attempt, explicit } = pickAttempt(attempts, search.get('att'));
  const runner = data.runner.data as unknown as RunnerSlice | undefined;
  const online = runner?.connection.online ?? true;
  const taskAlerts = task ? (data.alerts.data?.items ?? []).filter((a) => a.taskKey === task.taskKey) : [];
  const pick = (key: string, att: string | null) => {
    void navigate(`/exec/${encodeURIComponent(key)}${att ? `?att=${encodeURIComponent(att)}` : ''}`);
  };

  return (
    <div className="page">
      <div className="page-h"><div><h1>{TITLE}</h1><p className="page-sub">{SUB}</p></div></div>
      <div className="three">
        <ExecRail data={data} selectedTask={task?.taskKey ?? null} selectedAttempt={explicit ? attempt?.attemptKey ?? null : null} onPick={pick} />
        {task ? (() => {
          const flow = flowOf(task, attempts, verifications);
          const isDevSide = flow.stage === 'dev' || flow.stage === 'rework';
          const agent = String((isDevSide ? task.assigneeAgent : task.verifierAgent) ?? 'Claude');
          const reason = runner ? runnerReason(runner, agent, task.taskKey) : '';
          const next = nextStep({ task, flow, attempts, verifications, alerts: taskAlerts, reason, limits: AUTO_LIMITS });
          return (
            <>
              <ExecCenter
                key={task.taskKey} projectId={projectId} task={task} flow={flow} next={next} attempt={attempt}
                verifications={verifications} evidence={data.evidence.data} alerts={taskAlerts}
                reworkOpen={reworkFor === task.taskKey} onRework={(open) => { setReworkFor(open ? task.taskKey : null); }} now={now}
              />
              <ExecMessages key={task.taskKey}
                taskKey={task.taskKey} taskStatus={String(task.lifecycleStatus)} defaultAgent={task.assigneeAgent ?? 'Claude'}
                attempts={attempts} scopeAttempt={explicit ? attempt : null} messages={data.messages.data?.items ?? []}
                online={online} liveInject={data.workflow.data?.liveInject ?? false}
              />
            </>
          );
        })() : (
          <div className="mainc"><p className="empty">왼쪽에서 Task를 고르세요.</p></div>
        )}
      </div>
    </div>
  );
}
