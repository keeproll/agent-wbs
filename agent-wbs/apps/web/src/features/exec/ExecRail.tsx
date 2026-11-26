/**
 * 왼쪽: Task · 실행 시도 목록(P L1751–1758). 항목은 배열 위치가 아니라 taskKey·attemptKey(안정 키)로 고른다.
 */
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { ATTEMPT_STATUS, flowOf, KIND_LABEL, STAGE_LABEL, statusOf, type ExecAttempt } from './model.ts';
import type { ExecData } from './useExecData.ts';

export interface RailProps {
  data: ExecData;
  selectedTask: string | null;
  /** 주소로 고른 시도(없으면 null) */
  selectedAttempt: string | null;
  onPick: (taskKey: string, attemptKey: string | null) => void;
}

export function ExecRail({ data, selectedTask, selectedAttempt, onPick }: RailProps) {
  return (
    <aside className="side scrollc" aria-label="Task 및 실행 목록">
      {data.listed.length === 0 && (
        <EmptyState kind="none" message="실행할 Task가 없습니다." hint="착수 승인을 받은 Task가 실행 대기가 되면 여기에 보입니다." />
      )}
      {data.listed.map((t) => {
        const attempts: ExecAttempt[] = data.attemptsByTask.get(t.taskKey) ?? [];
        // 단계 표시는 검증 결과 없이 시도만으로 계산한다(목록에서 Task마다 검증을 읽지 않기 위해). 정확한 단계는 가운데에 보인다.
        const raw = flowOf(t, attempts, []).stage;
        const stage = t.lifecycleStatus === 'rework' || t.lifecycleStatus === 'gate' ? (String(t.lifecycleStatus) as 'rework' | 'gate') : raw;
        const st = statusOf(t.lifecycleStatus);
        const on = selectedTask === t.taskKey && selectedAttempt === null;
        return (
          <div key={t.taskKey} className="ex-t">
            <button type="button" className={on ? 'side-i on' : 'side-i'} aria-current={on || undefined} onClick={() => { onPick(t.taskKey, null); }}>
              <span className="side-r">
                <span className="mono muted">{t.taskKey}</span>
                <span className={`st ${st.cls}`}><span className="st-d" aria-hidden="true" />{st.label}</span>
              </span>
              <span className="side-t">{t.title}</span>
              <span className="muted">단계: {STAGE_LABEL[stage]}{t.blocked && <span className="blk"> · 차단</span>}</span>
            </button>
            {attempts.map((a) => {
              const as = ATTEMPT_STATUS[String(a.status)] ?? { label: String(a.status), cls: 's-plan' };
              const aon = selectedTask === t.taskKey && selectedAttempt === a.attemptKey;
              return (
                <button key={a.attemptKey} type="button" className={aon ? 'ex-a on' : 'ex-a'} aria-current={aon || undefined} onClick={() => { onPick(t.taskKey, a.attemptKey); }}>
                  <span className="mono">{a.attemptKey}</span>
                  <span>{KIND_LABEL[a.kind] ?? String(a.kind)} · {String(a.agent)}</span>
                  <span className={`st ${as.cls}`}>{as.label}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
