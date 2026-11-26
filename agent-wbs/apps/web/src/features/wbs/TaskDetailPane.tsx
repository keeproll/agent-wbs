/**
 * M3-02의 임시 상세(기본 slot 구현). 원본 P L925–955의 머리: 돌아가기·WBS 번호·Task ID·상위 WP, 위치·이전·다음, 제목, 요약.
 * 상세 탭 9개와 Gate 펼침은 M3-03(features/task/TaskDetail.tsx)이 만든다. 병합 때 detail-slot.tsx가 그것을 가리키게 바꾼다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useApiQuery } from '../../shared/api/queries.ts';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { codeLabel } from '../../shared/ui/errors.ts';
import { SmIcon, StatusPill, WBS_ICON } from './cells.tsx';
import { agentMark, planCell, priorityOf, TYPE_LABEL, verifOf, type TaskList, type TaskSummary } from './model.ts';
import type { WbsTaskDetailProps } from './detail-slot.tsx';

/** 상위 Work Package 문구. WBS 화면이 이미 읽은 목록(listTasks 캐시)에서 찾는다. */
function useParentText(nodeId: string | undefined): string {
  const cached = useQueryClient().getQueriesData<TaskList>({ queryKey: ['listTasks'] });
  const node = cached.flatMap(([, d]) => d?.nodes ?? []).find((n) => n.id === nodeId);
  return node ? `Work Package ${node.wbsPath} ${node.title}` : '';
}

export function TaskDetailPane({ taskKey, nav }: WbsTaskDetailProps) {
  const detail = useApiQuery('getTask', { params: { taskKey } }, { topics: ['task', 'dependency', 'attempt', 'verification'], keepPrevious: false });
  const schedule = useApiQuery('getSchedule', {}, { topics: ['schedule', 'task', 'dependency', 'settings'] });
  const parentText = useParentText(detail.data?.wbsNodeId);
  const task = detail.data as TaskSummary | undefined;
  // 첫 조회 실패: 계속 불러오는 것처럼 두지 않고 원인과 다시 시도를 보인다(독립 리뷰 #4).
  if (!task && detail.isError) {
    return (
      <section className="detail" aria-label="Task 상세">
        <div className="dt-body">
          <div className="banner danger" role="alert" style={{ marginTop: 0 }}>
            <div className="banner-b">
              <b>{taskKey} 상세를 불러오지 못했습니다</b> <span className="mono">{codeLabel(detail.error)}</span> — {detail.error.body?.error.message ?? '서버가 응답하지 않습니다.'} 잠시 뒤 다시 시도하세요.{' '}
              <BusyButton small variant="default" busy={detail.isFetching} busyLabel="다시 불러오는 중…" onClick={() => { void detail.refetch(); }}>다시 시도</BusyButton>
            </div>
          </div>
        </div>
      </section>
    );
  }
  if (!task) return <section className="detail" aria-label="Task 상세" aria-busy="true" />;
  const sched = schedule.data?.tasks.find((t) => t.taskKey === taskKey);
  const ag = agentMark(task.assigneeAgent);
  const vf = agentMark(task.verifierAgent);
  const p = priorityOf(task.priority);
  const v = verifOf(task.verifState);
  const plan = planCell(task, sched);
  const pct = sched?.progressPct ?? task.schedule?.progressPct ?? 0;
  const cl = task.checklist;
  return (
    <section className="detail" aria-label="Task 상세">
      <div className="dt-head">
        <div className="dt-top">
          <div className="dt-crumbs">
            {nav.back && <button type="button" className="btn sm" onClick={nav.back.go}>← {nav.back.taskKey}로 돌아가기</button>}
            <span className="mono muted">WBS {task.wbsPath}</span>
            <span className="idchip mono">{task.taskKey}</span>
            <span className="muted">{parentText}</span>
          </div>
          <div className="dt-acts">
            <span className="muted mono" style={{ fontSize: 12 }}>{nav.outside ? '목록 밖 (필터에 맞지 않음)' : nav.pos}</span>
            <button type="button" className="btn ghost sm" onClick={() => nav.prev?.()} disabled={!nav.prev} aria-label="이전 Task">↑ 이전</button>
            <button type="button" className="btn ghost sm" onClick={() => nav.next?.()} disabled={!nav.next} aria-label="다음 Task">↓ 다음</button>
          </div>
        </div>
        <h2 className="dt-title">{task.title}</h2>
        <div className="summary" style={{ marginBottom: 12 }}>
          <div className="sum-i"><span className="sum-l">작업 유형 / 기술 영역</span><span className="sum-v"><span className="wt">{TYPE_LABEL[String(task.workType)] ?? String(task.workType)}</span><span className="dm">{String(task.primaryDomain)}</span>{task.relatedDomains.length > 0 && <span className="dm-rel">+{task.relatedDomains.join(', ')}</span>}</span></div>
          <div className="sum-i"><span className="sum-l">현재 상태</span><span className="sum-v"><StatusPill status={task.lifecycleStatus} /></span></div>
          <div className="sum-i"><span className="sum-l">담당 → 검증 Agent</span><span className="sum-v"><span className="agent"><span className={ag.cls} aria-hidden="true">{ag.init}</span>{ag.name}</span><span className="muted">→</span><span className="agent"><span className={vf.cls} aria-hidden="true">{vf.init}</span>{vf.name}</span></span></div>
          <div className="sum-i"><span className="sum-l">우선순위</span><span className="sum-v"><span className={`pri ${p.c}`}>{p.l}</span></span></div>
          <div className="sum-i"><span className="sum-l">선행 Task</span><span className="sum-v">
            {task.blocked
              ? <span className="blk"><SmIcon d={WBS_ICON.lock} />차단</span>
              : <span className="okt"><SmIcon d={WBS_ICON.check} />{task.preds.length ? `모두 충족 (${String(task.preds.length)}건)` : '없음'}</span>}
          </span></div>
          <div className="sum-i"><span className="sum-l">체크리스트</span><span className="sum-v"><span className="cl-n">{cl.total ? `${String(cl.done)}/${String(cl.total)}` : '—'}</span><span className={cl.total && cl.done === cl.total ? 'bar full' : 'bar'}><span className="bar-f" style={{ width: `${String(cl.total ? Math.round((cl.done / cl.total) * 100) : 0)}%` }} /></span></span></div>
          <div className="sum-i"><span className="sum-l">Verification</span><span className="sum-v"><span className={`vf ${v.c}`}>{v.l}</span></span></div>
          <div className="sum-i"><span className="sum-l">Completion Gate</span><span className="sum-v"><span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{task.gate.passed === task.gate.total && task.gate.total > 0 ? `통과 ${String(task.gate.passed)}/${String(task.gate.total)}` : `미통과 ${String(task.gate.passed)}/${String(task.gate.total)}`}</span></span></div>
          <div className="sum-i"><span className="sum-l">일정 (예상 실행 {sched ? `${String(sched.estHours)}h` : '—'})</span><span className="sum-v"><span className="mono">{plan.planL}{sched && !sched.done ? ' 예상' : ''}</span><span className={plan.scC}>{plan.scL}</span></span></div>
          <div className="sum-i"><span className="sum-l">진행률</span><span className="sum-v"><span className="cl-n">{pct}%</span><span className={pct === 100 ? 'bar full' : 'bar'} style={{ width: 90 }}><span className="bar-f" style={{ width: `${String(pct)}%` }} /></span></span></div>
        </div>
      </div>
      <div className="dt-body">
        <p className="dt-slot" data-slot="task-detail">
          Task 상세 탭(개요 · 작업 명세 · 의존성 · 기술 설계 · 체크리스트 · 실행 · 검증·Evidence · 이력 · 메시지)은 M3-03에서 연결됩니다.
        </p>
      </div>
    </section>
  );
}
