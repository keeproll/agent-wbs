/**
 * 일정 재조정 이력(UI-05-02). 원본 P L1618–1637, 로직 P L4284–4305.
 *
 * - 자동 재조정 정책(GET /api/settings/schedule의 autoReplan)이 꺼져 있으면 기록은 「반영 대기」(pending)로만 남고 기준은 바뀌지 않는다(D-10).
 *   팀장이 「재조정 실행」(POST /api/replans/run)을 눌러야 다시 계산해 새 기준으로 확정한다.
 * - 원본의 「Planning Agent 재조정 실행 (Mock)」은 실제 서버 요청이라 「재조정 실행」으로 쓴다.
 * - 각 기록의 「변경 Task 보기」는 펼침 상태를 기록 id로 기억한다(배열 위치 아님).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { useRefreshError } from '../../shared/layout/MenuScreen.tsx';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { causeMessage, codeLabel } from '../../shared/ui/errors.ts';
import type { TaskInfo } from '../change/model.ts';
import { PAGE_LIMIT } from '../change/find.ts';
import { replanRows } from './model.ts';

const M_GRID = { gridTemplateColumns: '110px minmax(160px,1fr) 90px 80px 80px 80px' };
const EV_GRID = { gridTemplateColumns: '110px minmax(0,1fr) 110px minmax(0,1fr)' };
const md = (d: string | null | undefined) => (d ? d.slice(5, 10) : '—');

export function ReplanTab({ tasks }: { tasks: ReadonlyMap<string, TaskInfo> | null }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const replans = useApiQuery('listReplans', { query: { limit: PAGE_LIMIT } }, { topics: ['schedule'] });
  useRefreshError(replans, '일정 재조정 이력 최신 내용 불러오기');
  const schedule = useApiQuery('getSchedule', {}, { topics: ['schedule', 'task'] });
  const policy = useApiQuery('getScheduleSettings', {}, { topics: ['settings'] });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const run = useSave({
    target: '일정 재조정 실행',
    failTitle: '재조정을 실행하지 못했습니다',
    // 같은 실행의 재시도는 같은 멱등 키로 보낸다(두 번 재조정되지 않게).
    request: () => ({}),
    run: ({ idempotencyKey }) => client.call('runReplan', { idempotencyKey }),
    onSuccess: () => { void Promise.all(['listReplans', 'getSchedule'].map((id) => queryClient.invalidateQueries({ queryKey: [id] }))); },
    successNotice: 'Planning Agent가 전체 일정을 다시 계산해 기준 일정에 반영했습니다.',
  });

  const rows = replanRows(replans.data?.items ?? []);
  const sp = schedule.data?.project;
  const auto = policy.data ? Boolean((policy.data as { autoReplan?: boolean }).autoReplan) : null;
  const summary = sp
    ? `현재 기준 v${String(sp.baselineVersion)} · 완료 예상 ${md(sp.end)} (범위 ${md(sp.lo)} ~ ${md(sp.hi)}) · 기준 대비 ${sp.slipDays > 0 ? '+' : ''}${String(sp.slipDays)}일 · 최초 기준 v1 ${md(sp.firstBaselineEnd)} · 재조정 ${String(rows.length)}회`
    : schedule.isError ? `현재 일정을 불러오지 못했습니다 (${codeLabel(schedule.error)}).` : '현재 일정 불러오는 중…';

  return (
    <>
      <div className="card">
        <div className="dp-h">
          <div>
            <h2 className="dp-t">일정 재조정 이력 {auto !== null && <span className="tag">{auto ? '자동 반영' : '자동 반영 꺼짐 — 실행해야 반영'}</span>}</h2>
            <p className="fhint" style={{ margin: '4px 0 0' }}>{summary}{schedule.isError && !sp && <> <button type="button" className="btn ghost sm" onClick={() => { void schedule.refetch(); }}>다시 시도</button></>}</p>
          </div>
          <BusyButton small busy={run.busy} busyLabel="재조정 실행 중…" onClick={() => { void run.save(); }}>재조정 실행</BusyButton>
        </div>
        <p className="fhint" style={{ margin: 0 }}>Task 추가 · 삭제 · 재추정, Runner 중단, 사용량 한도, 작업 불가일 변경이 생기면 Planning Agent가 전체 일정을 다시 계산하고 새 기준 일정 버전으로 자동 반영합니다. 밀리거나 당겨진 Task는 각 Task 이력에도 남습니다.</p>
        {auto === false && <p className="fhint" style={{ margin: '4px 0 0' }}>지금은 자동 반영이 꺼져 있어 재조정은 「반영 대기」로만 기록되고 기준 일정은 바뀌지 않습니다. 「재조정 실행」을 누르면 다시 계산해 새 기준으로 확정합니다.</p>}
      </div>
      {replans.data === undefined && replans.isError && (
        // 첫 조회 실패: 로딩으로 남기지 않고 원인과 「다시 시도」를 보인다(독립 리뷰 ca3902d #5). 모양은 공통 오류 카드(.load-err).
        <section className="card load-err rpc" aria-labelledby="rp-err-t">
          <h2 id="rp-err-t" className="load-err-t">재조정 이력을 불러오지 못했습니다</h2>
          <p>{causeMessage(replans.error, false)} ({codeLabel(replans.error)})</p>
          <div className="form-acts" style={{ justifyContent: 'flex-start' }}>
            <BusyButton busy={replans.isFetching} busyLabel="다시 불러오는 중…" onClick={() => { void replans.refetch(); }}>다시 시도</BusyButton>
          </div>
        </section>
      )}
      {replans.data === undefined && !replans.isError && <AreaLoading label="재조정 이력 불러오는 중" />}
      {replans.data !== undefined && rows.length === 0 && (
        <div className="card rpc"><p className="empty" style={{ margin: 0 }}>재조정 기록이 없습니다. 초기 WBS를 승인하면 기준 v1이 생기고, 일정이 바뀌면 여기에 기록됩니다.</p></div>
      )}
      {rows.map((rp) => (
        <div key={rp.id} className="card rpc" role="group" aria-label={`재조정 ${rp.id}`}>
          <div className="dp-h" style={{ margin: 0 }}>
            <div className="att-h" style={{ margin: 0 }}>
              <span className="att-n mono">{rp.id}</span><span className="tag">{rp.v}</span>
              <span className={rp.dC}>{rp.dL}</span><span className="mono muted">{formatDateTime(rp.at)}</span>
              {rp.discarded && <span className="sc sc-none">닫힘(반영 안 함)</span>}
            </div>
            <span className="muted">{rp.by}</span>
          </div>
          <p style={{ margin: '6px 0', color: '#3E4651' }}>{rp.trigger}</p>
          <div className="ev" style={EV_GRID}>
            <span className="ev-l">완료 예상</span><span className="mono">{rp.endL}</span>
            <span className="ev-l">범위</span><span className="mono">{rp.rangeL}</span>
            <span className="ev-l">적용 가동률</span><span className="mono">{rp.rateL}</span>
            <span className="ev-l">변경 Task</span><span className="mono">{rp.n}</span>
          </div>
          {rp.moved.length > 0 && (
            <button type="button" className="btn ghost sm" style={{ marginTop: 6 }} aria-expanded={Boolean(open[rp.id])}
              onClick={() => { setOpen((o) => ({ ...o, [rp.id]: !o[rp.id] })); }}>
              {open[rp.id] ? '변경 Task 접기' : `변경 Task ${String(rp.moved.length)}건 보기`}
            </button>
          )}
          {open[rp.id] && (
            <div className="gtb" style={{ margin: '8px 0 0' }} role="region" aria-label={`${rp.id} 변경 Task`} tabIndex={0}>
              <div className="gtr h" style={M_GRID}><span className="gc">Task</span><span className="gc">제목</span><span className="gc">변경</span><span className="gc">이전 기준</span><span className="gc">새 기준</span><span className="gc">차이</span></div>
              {rp.moved.map((m) => {
                const t = tasks?.get(m.task);
                return (
                  <div key={m.task} className="gtr" style={M_GRID}>
                    <span className="gc">{t ? <Link className="reflink" to={`/wbs/${m.task}`}>{m.task}</Link> : <span className="mono">{m.task}</span>}</span>
                    <span className="gc">{t?.title ?? (tasks ? '(삭제됨)' : '')}</span>
                    <span className="gc"><span className={m.kindC}>{m.kind}</span></span>
                    <span className="gc mono">{m.before}</span><span className="gc mono">{m.after}</span><span className="gc mono">{m.delta}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {run.conflictModal}
    </>
  );
}
