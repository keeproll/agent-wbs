/**
 * 초기화 기록 카드(P L740–745)와 Runner 정리 대기 배너(P L705).
 * 초기화 기록은 프로젝트 데이터와 따로 남는다(G§4.2 ③). 그래서 등록 전 화면에도 보인다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import type { ProjectState } from './labels.ts';

type ResetItem = ResponseOf<'listResets'>['items'][number];

/** Runner 정리 상태 문구. 「정리 완료」는 Runner의 정리 결과 보고를 받은 뒤에만 보인다(MM-19). */
export function cleanupLabel(r: Pick<ResetItem, 'runnerCleanupStatus' | 'finishedAt'>): string {
  switch (r.runnerCleanupStatus) {
    case 'done': return `정리 완료${r.finishedAt ? ` (${formatDateTime(r.finishedAt)})` : ''}`;
    case 'pending': return '정리 대기 — 다시 연결되면 실행';
    case 'running': return '정리 중';
    case 'failed': return '정리 실패 — 다시 연결되면 재시도';
    default: return '정리할 것 없음';
  }
}

export function ResetHistory() {
  const resets = useApiQuery('listResets', {}, { topics: ['project'] });
  const items = [...(resets.data?.items ?? [])].sort((a, b) => b.epoch - a.epoch);
  return (
    <section className="card" style={{ margin: 0 }} aria-labelledby="rs-hist-h">
      <div className="dp-h"><h2 id="rs-hist-h">초기화 기록</h2><span className="fhint">프로젝트 데이터와 별도 보관</span></div>
      {resets.isError && !resets.data && <p className="muted" style={{ margin: 0 }}>초기화 기록을 불러오지 못했습니다. <button type="button" className="reflink" onClick={() => { void resets.refetch(); }}>다시 시도</button></p>}
      {items.map((r) => (
        <div key={r.epoch} className="rpt-li" data-testid="reset-row">
          <span className="mono">{formatDateTime(r.at)}</span>
          <span>{r.actor}</span>
          <span>{`초기화 번호 ${String(r.epoch - 1)} → ${String(r.epoch)} · Task ${String(r.deletedTaskCount)}건 삭제 · 설정 ${r.keepSettings ? '유지' : '삭제'}`}</span>
          <span className="muted">Runner {cleanupLabel(r)}</span>
        </div>
      ))}
      {resets.data && items.length === 0 && <p className="muted" style={{ margin: 0 }}>초기화한 적이 없습니다.</p>}
    </section>
  );
}

/** 이전 초기화의 Runner 정리가 끝나지 않았을 때(P L705). 정리가 끝나기 전에는 새 초기 분석이 시작되지 않는다(G§4.2 ③). */
export function CleanupBanner({ project }: { project: ProjectState }) {
  if (project.cleanup === 'none') return null;
  const title = project.cleanup === 'failed' ? 'Runner 정리 실패' : project.cleanup === 'running' ? 'Runner 정리 중' : 'Runner 정리 대기';
  return (
    <div className="banner warn" role="status" data-testid="cleanup-banner">
      <div className="banner-b"><b>{title}</b> — 초기화 번호 {project.epoch}. 정리가 끝나기 전에는 저장소 확인 · 새 초기 분석이 시작되지 않습니다. 헤더의 Runner 상태를 눌러 연결하면 정리가 먼저 실행됩니다.</div>
    </div>
  );
}
