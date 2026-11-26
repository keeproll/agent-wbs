/**
 * 대시보드(UI-01) — 원본 P L1858–1900을 그대로 옮긴 화면.
 *
 * 데이터:
 * - GET /api/dashboard: 숫자·패널·분포·등급·최근 결과(계약 Dashboard). 서버 핸들러는 서버 후속 2차에서 들어온다(보고함).
 * - GET /api/alerts: 「팀장 확인 필요」 경고. 대시보드 응답의 alerts가 아니라 이 API를 쓴다(조정자 지시).
 * - GET /api/runner-state: 「일정 · 진행」 설명의 동시 실행 한도.
 *
 * 원본과 다른 점:
 * - 모든 항목은 주소가 있는 링크다(새로고침·뒤로 가기, MM-29). WBS 필터는 `/wbs?status=done` 같은 주소로 넘긴다.
 * - 알림의 「확인」(닫기) 버튼은 없다. 팀장이 알림을 닫는 API가 계약에 없어 가짜 버튼을 두지 않는다(보고함).
 */
import { Link } from 'react-router';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { MenuScreen, useRefreshError, useRevisitFetching } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { PageSkeleton, useDelayedFlag } from '../../shared/ui/loading.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import { useTopBar } from '../../shared/ui/feedback.tsx';
import { agentClass, agentInitial } from '../verify/labels.ts';
import '../verify/screens.css';
import {
  alertLink, domainBars, gradeRows, panels, recentRows, schedCards, schedNote, taskKpis, typeBars, type AlertItem, type Dashboard,
} from './model.ts';

const TOPICS = ['task', 'dependency', 'attempt', 'verification', 'message', 'proposal', 'planning', 'schedule', 'runner'] as const;
/** 원본 등급 표 열 폭(P gGrid L6325) */
const G_GRID = '90px minmax(150px,1fr) 70px 60px 60px 100px 60px 70px';

export function DashboardPage() {
  return <MenuScreen menu="dashboard">{() => <DashboardBody />}</MenuScreen>;
}

function DashboardBody() {
  const dash = useApiQuery('getDashboard', {}, { topics: TOPICS });
  const alerts = useApiQuery('listAlerts', {}, { topics: ['alert'] });
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  const skeleton = useDelayedFlag(dash.isPending && dash.fetchStatus === 'fetching');
  const dashRevisit = useRevisitFetching(dash);
  const alertsRevisit = useRevisitFetching(alerts);
  useTopBar(dashRevisit || alertsRevisit);
  useRefreshError(dash, '대시보드 최신 내용 불러오기');
  useRefreshError(alerts, '대시보드 알림 최신 내용 불러오기');

  if (dash.data === undefined && dash.isError) {
    return <LoadError title="대시보드" error={dash.error} retrying={dash.isFetching} onRetry={() => { void dash.refetch(); }} />;
  }
  if (dash.data === undefined) return <div className="page scroll">{skeleton && <PageSkeleton menu="dashboard" />}</div>;
  return (
    <DashboardView
      d={dash.data}
      alerts={alerts.data?.items}
      alertsFailed={alerts.data === undefined && alerts.isError}
      onRetryAlerts={() => { void alerts.refetch(); }}
      note={schedNote(dash.data.schedule, runner.data)}
    />
  );
}

function DashboardView({ d, alerts, alertsFailed, onRetryAlerts, note }: {
  d: Dashboard; alerts: AlertItem[] | undefined; alertsFailed: boolean; onRetryAlerts: () => void; note: string;
}) {
  const sched = schedCards(d.schedule);
  const grades = gradeRows(d.grades);
  const recent = recentRows(d.recent);
  return (
    <Page
      title="대시보드"
      sub="다음 행동을 결정하는 데 필요한 항목만 표시합니다 · 모든 항목은 관련 Task 목록이나 화면으로 연결됩니다"
      actions={<span className="muted mono">기준 {formatDateTime(d.at)}</span>}
    >
      <h2 className="sh" style={{ marginTop: 0 }}>일정 · 진행 <span className="muted">{note}</span></h2>
      {sched.length > 0 ? (
        <div className="kpis">
          {sched.map((k) => (
            <Link key={k.l} className="kpi" to={k.to} aria-label={k.aria}>
              <span className="kpi-l">{k.l}</span>
              <span className="kpi-v">{k.v}</span>
              {k.bar !== null && <span className="bar wide" style={{ margin: '4px 0' }}><span className="bar-f" style={{ width: `${String(Math.max(0, k.bar))}%` }} /></span>}
              <span className={k.subC} style={{ fontSize: '11.5px' }}>{k.sub}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="empty" style={{ margin: '0 0 16px' }}>아직 일정이 계산되지 않았습니다. 초기 WBS 승인 뒤 일정 재조정이 실행되면 여기에 진행률과 예상 완료일이 표시됩니다.</p>
      )}
      {alertsFailed && (
        <div className="banner warn" role="status">
          <div className="banner-b"><b>팀장 확인 필요</b> — 알림을 불러오지 못했습니다. <button type="button" className="btn ghost sm" onClick={onRetryAlerts}>다시 시도</button></div>
        </div>
      )}
      {alerts && alerts.length > 0 && (
        <div className="banner warn" role="region" aria-label="팀장 확인 필요">
          <div className="banner-b">
            <b>팀장 확인 필요</b>
            {alerts.map((al) => {
              const link = alertLink(al);
              return (
                <div key={al.id} className="al-row">
                  <span className="mono muted">{formatDateTime(al.at)}</span>
                  <span className="al-t">{al.text}</span>
                  <Link className="btn ghost sm" to={link.to}>{link.label}</Link>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <h2 className="sh">Task 현황</h2>
      <div className="kpis">
        {taskKpis(d.tasks).map((k) => (
          <Link key={k.l} className={`kpi ${k.cls}`.trim()} to={k.to} aria-label={k.aria}>
            <span className="kpi-l">{k.l}</span><span className="kpi-v">{k.v}</span><span className="kpi-s">{k.sub}</span>
          </Link>
        ))}
      </div>
      <div className="dgrid">
        {panels(d.panels).map((pn) => (
          <section key={pn.title} className="card dpanel" aria-label={pn.title}>
            <div className="dp-h"><h3>{pn.title}</h3><span className={`dp-n ${pn.nCls}`.trim()}>{pn.n}</span></div>
            <p className="fhint" style={{ margin: '0 0 8px' }}>{pn.sub}</p>
            {pn.items.length === 0 && <p className="empty" style={{ margin: 0 }}>{pn.emptyT}</p>}
            {pn.items.map((it) => (
              <Link key={it.key} className="dl-i" to={it.to}>
                <span className="mono muted">{it.id}</span><span className="dl-t">{it.t}</span><span className={it.tagC}>{it.tag}</span>
              </Link>
            ))}
          </section>
        ))}
      </div>
      <div className="cmp">
        <section className="card" aria-label="작업 유형별 분포">
          <div className="dp-h"><h3>작업 유형별 분포</h3><span className="fhint">클릭하면 WBS에 필터 적용</span></div>
          {typeBars(d.byWorkType).map((b) => (
            <Link key={b.key} className={b.cls} to={b.to} aria-label={b.aria}>
              <span className="bar-l">{b.l} <span className="mono muted">{b.en}</span></span>
              <span className="bar-t"><span className="bar-x" style={{ width: `${String(b.pct)}%` }} /></span>
              <span className="bar-n mono">{b.n}</span>
            </Link>
          ))}
        </section>
        <section className="card" aria-label="기술 영역별 분포">
          <div className="dp-h"><h3>기술 영역별 분포</h3><span className="fhint">주 기술 영역 기준 · 클릭하면 WBS에 필터 적용</span></div>
          {domainBars(d.byDomain).map((b) => (
            <Link key={b.key} className={b.cls} to={b.to} aria-label={b.aria}>
              <span className="bar-l"><span className="mono">{b.l}</span> <span className="muted">{b.en}</span></span>
              <span className="bar-t"><span className="bar-x" style={{ width: `${String(b.pct)}%` }} /></span>
              <span className="bar-n mono">{b.n}</span>
            </Link>
          ))}
        </section>
      </div>
      <section className="card" style={{ marginTop: 16 }} aria-label="실행 등급별 결과">
        <div className="dp-h"><h3>실행 등급별 결과</h3><span className="fhint">개발 · 재작업 시도 기준 · 재작업률 = 다음 QA FAIL / 판정 — Planning Agent가 등급 판단을 보정하는 근거</span></div>
        {grades.length === 0 && <p className="empty" style={{ margin: 0 }}>등급이 기록된 실행 시도가 없습니다. 개발 · 재작업 시도가 등급과 함께 기록되면 여기에 표시됩니다.</p>}
        <TableScroll minWidth={700} label="실행 등급별 결과 표">
          <div className="gtb" style={{ margin: 0 }} role="table" aria-label="실행 등급별 결과">
            <div className="gtr h" role="row" style={{ gridTemplateColumns: G_GRID }}>
              {['Agent', '모델 · Effort', '시도', '판정', 'FAIL', '재작업률', '상향', '토큰'].map((h) => <span key={h} className="gc" role="columnheader">{h}</span>)}
            </div>
            {grades.map((g) => (
              <div key={g.key} className="gtr" role="row" style={{ gridTemplateColumns: G_GRID }}>
                <span className="gc" role="cell"><span className="agent"><span className={`ag-mk ${agentClass(g.agent)}`} aria-hidden="true">{agentInitial(g.agent)}</span>{g.agent}</span></span>
                <span className="gc" role="cell">{g.grade}</span>
                <span className="gc mono" role="cell">{g.n}</span>
                <span className="gc mono" role="cell">{g.judged}</span>
                <span className="gc mono" role="cell">{g.fail}</span>
                <span className="gc" role="cell"><span className={g.rateC}>{g.rateL}</span></span>
                <span className="gc mono" role="cell">{g.esc}</span>
                <span className="gc mono" role="cell">{g.tok}</span>
              </div>
            ))}
          </div>
        </TableScroll>
      </section>
      <section className="card" style={{ marginTop: 16 }} aria-label="최근 실행 · 검증 결과">
        <div className="dp-h"><h3>최근 실행 · 검증 결과</h3><span className="fhint">최신 8건</span></div>
        {recent.length === 0 && <p className="empty" style={{ margin: 0 }}>아직 실행 · 검증 결과가 없습니다. Runner가 Task를 실행하면 여기에 최근 결과가 표시됩니다.</p>}
        {recent.length > 0 && (
          <TableScroll minWidth={640} label="최근 실행 · 검증 결과 목록">
            {recent.map((r) => (
              <Link key={r.key} className="dl-i rec" to={r.to}>
                <span className="mono muted">{r.at}</span><span className="tag">{r.kind}</span><span className="mono">{r.taskKey}</span>
                <span className="muted">{r.agent}</span><span className="dl-t">{r.t}</span><span className={r.tagC}>{r.tag}</span>
              </Link>
            ))}
          </TableScroll>
        )}
      </section>
    </Page>
  );
}
