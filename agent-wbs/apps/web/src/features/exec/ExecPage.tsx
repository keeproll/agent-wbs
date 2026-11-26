/**
 * 작업 실행(UI-06, P L1747–1856) — 3분할: 왼쪽 Task · 시도 목록 / 가운데 다음 작업 · 결과 · 기록 / 오른쪽 연결 메시지.
 *
 * 주소(안정 키):
 * - `/exec` — 목록의 첫 Task
 * - `/exec/:taskKey` — 그 Task(Task 상세 실행 탭·알림 링크가 여는 주소, UAT-TASK-10 b)
 * - `/exec/:taskKey?att=<attemptKey>` — 그 시도. 없는 시도면 고르지 않고 알린다(UAT-EMPTY-03, 리뷰 #4).
 * - 없는 Task 키면 다른 Task를 열지 않고 「찾을 수 없습니다」를 보인다(리뷰 #4).
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { MenuScreen, useRefreshError, useRevisitFetching } from '../../shared/layout/MenuScreen.tsx';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { AreaLoading, PageSkeleton, useDelayedFlag } from '../../shared/ui/loading.tsx';
import { AreaError } from './AreaError.tsx';
import { useDraftProtection } from './messageDrafts.ts';
import './exec.css';
import { useTopBar } from '../../shared/ui/feedback.tsx';
import { ExecCenter } from './ExecCenter.tsx';
import { ExecMessages } from './ExecMessages.tsx';
import { ExecRail } from './ExecRail.tsx';
import { flowOf, nextStep, pickAttempt, runnerReason, sortAttempts, type RunnerSlice } from './model.ts';
import { useExecData } from './useExecData.ts';
import { LINK } from '../../shared/links.ts';

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
  useRefreshError(data.verifications, '검증 기록 최신 내용 불러오기');
  // 다른 Task에 보관 중인 메시지 초안도 새로고침·세션 만료에서 지킨다(M3-06 리뷰 #6).
  useDraftProtection();
  const skeleton = useDelayedFlag(data.tasks.isPending);

  if (data.tasks.data === undefined && data.tasks.isError) {
    return <LoadError title={TITLE} error={data.tasks.error} retrying={data.tasks.isFetching} onRetry={() => { void data.tasks.refetch(); }} />;
  }
  if (data.tasks.data === undefined) return <div className="page scroll">{skeleton && <PageSkeleton menu="exec" />}</div>;

  const task = data.task;
  const pick = (key: string, att: string | null) => {
    void navigate(LINK.exec(key, att));
  };
  const own = data.own;
  const attempts = task ? sortAttempts(own.data ?? []) : [];
  const verifications = data.verifications.data ?? [];
  const { attempt, explicit, missing } = pickAttempt(attempts, search.get('att'));
  const runner = data.runner.data as unknown as RunnerSlice | undefined;
  const online = runner?.connection.online ?? true;
  const taskAlerts = task ? (data.alerts.data?.items ?? []).filter((a) => a.taskKey === task.taskKey) : [];

  /** 가운데 영역. 시도·검증 기록을 모르면 단계·다음 작업(명령)을 계산하지 않는다(M3-06 리뷰 #3). */
  const middle = () => {
    if (!task) {
      return (
        <div className="mainc">
          <p className="empty">{data.missingTask ? `${data.missingTask}를 찾을 수 없습니다.` : '실행할 Task가 없습니다.'}</p>
          <p className="fhint">{data.missingTask ? '삭제됐거나 잘못된 주소입니다. 왼쪽 목록에서 Task를 고르세요.' : '착수 승인을 받은 Task가 실행 대기가 되면 왼쪽에 보입니다.'}</p>
        </div>
      );
    }
    const failed = own.data === undefined && own.isError ? { what: '실행 기록을', q: own }
      : data.verifications.data === undefined && data.verifications.isError ? { what: '검증 기록을', q: data.verifications } : null;
    if (failed || own.data === undefined || data.verifications.data === undefined) {
      return (
        <div key={`center:${task.taskKey}`} className="mainc scrollc" aria-label="선택 Task 실행">
          <div className="card">
            <span className="mono muted">WBS {task.wbsPath} · {task.taskKey}</span>
            <h2 className="h2">{task.title}</h2>
            {failed
              ? <AreaError what={failed.what} error={failed.q.error ?? new Error('알 수 없는 오류')} retrying={failed.q.isFetching} onRetry={() => { void failed.q.refetch(); }} />
              : <AreaLoading label="실행 기록 불러오는 중" />}
          </div>
        </div>
      );
    }
    const flow = flowOf(task, attempts, verifications);
    const isDevSide = flow.stage === 'dev' || flow.stage === 'rework';
    const agent = String((isDevSide ? task.assigneeAgent : task.verifierAgent) ?? 'Claude');
    const reason = runner ? runnerReason(runner, agent, task.taskKey)
      : data.runner.isError ? 'Runner 상태를 불러오지 못해 실행할 수 있는지 확인하지 못했습니다 — 요청하면 서버가 판단합니다.' : '';
    const next = nextStep({ task, flow, attempts, verifications, alerts: taskAlerts, reason, limits: AUTO_LIMITS });
    return (
      <ExecCenter
        key={`center:${task.taskKey}`} projectId={projectId} task={task} flow={flow} next={next} attempt={attempt} missingAttempt={missing}
        verifications={verifications} evidence={data.evidence} alerts={taskAlerts} alertsQuery={data.alerts}
        reworkOpen={reworkFor === task.taskKey} onRework={(open) => { setReworkFor(open ? task.taskKey : null); }} now={now}
      />
    );
  };

  return (
    <div className="page exec-page">
      <div className="page-h"><div><h1>{TITLE}</h1><p className="page-sub">{SUB}</p></div></div>
      <div className="three">
        <ExecRail data={data} selectedTask={task?.taskKey ?? null} selectedAttempt={explicit ? attempt?.attemptKey ?? null : null} onPick={pick} />
        {middle()}
        {task && (
          <ExecMessages
            key={`messages:${task.taskKey}`}
            taskKey={task.taskKey} taskStatus={String(task.lifecycleStatus)} defaultAgent={task.assigneeAgent ?? 'Claude'}
            attempts={attempts} scopeAttempt={explicit ? attempt : null} messages={data.messages}
            online={online} liveInject={data.workflow.data?.liveInject ?? false}
          />
        )}
      </div>
    </div>
  );
}
