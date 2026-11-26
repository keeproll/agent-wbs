/** 이력 탭(UI-03-08) — 원본 P L1338–1349. 최신순, 시각·주체·유형·내용·이전 → 이후. */
import type { UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '../../../shared/api/client.ts';
import type { ResponseOf } from '../../../shared/api/contract.ts';
import { formatDateTime } from '../../../shared/format.ts';
import { AreaLoading } from '../../../shared/ui/loading.tsx';

const GRID = '148px 80px 100px minmax(200px,1fr) minmax(140px,220px)';

export function HistoryTab({ history }: { history: UseQueryResult<ResponseOf<'getTaskHistory'>, ApiError> }) {
  const items = [...(history.data?.items ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="pane">
      <div className="pane-h"><div className="pane-hl"><h3>이력</h3><span className="muted">최신순 · 이 화면에서 수행한 변경이 즉시 기록됩니다</span></div></div>
      {history.data === undefined ? <AreaLoading label="이력 불러오는 중" /> : (
        <div className="gtb" role="table" aria-label="이력">
          <div className="gtr h" style={{ gridTemplateColumns: GRID }} role="row"><span className="gc">시각</span><span className="gc">주체</span><span className="gc">유형</span><span className="gc">변경 내용</span><span className="gc">이전 → 이후</span></div>
          {!items.length && <div className="gtr"><span className="gc muted">이 Task의 이력이 없습니다.</span></div>}
          {items.map((h) => (
            <div className="gtr" key={h.id} style={{ gridTemplateColumns: GRID }} role="row">
              <span className="gc mono">{formatDateTime(h.at)}</span><span className="gc">{h.actor}</span><span className="gc"><span className="tag">{h.kind}</span></span>
              <span className="gc">{h.text}</span><span className="gc mono">{h.before || h.after ? `${h.before || '—'} → ${h.after || '—'}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
