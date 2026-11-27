/**
 * 보고서(UI-11, UI-11A~D) — 원본 P L2089–2249 마크업·클래스(rp-*, rpt-*)를 그대로 옮긴 화면.
 *
 * 주소: `/report`(최신 보고서) · `/report/:reportId`(그 보고서) · `?kind=daily|weekly|custom`(목록 필터) · `?view=int|ext`(보기).
 * - 보고서 내용은 서버 스냅샷 그대로다. 열 때 다시 계산하지 않는다(G L373). 「생성 이후 변경」만 지금 기준이다.
 * - 정기 생성은 서버 worker가 한다(07:00 · 월 07:00 · 시작 때 누락분 보충). 원본의 「정기 생성 점검 (Mock)」 버튼은 두지 않는다.
 * - PDF 다운로드는 M6-02 서버 PDF, 메일 미리보기·보내기·발송 기록은 M6-03이 붙인다.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { seoulDay } from '@awbs/shared';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { useAllPages } from '../../shared/api/allPages.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { MenuScreen, useRefreshError, useRevisitFetching } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { useTopBar } from '../../shared/ui/feedback.tsx';
import { LINK } from '../../shared/links.ts';
import {
  changedLabel, defaultView, docTitle, externalDoc, formProblem, internalDoc, KIND, lateLabel, pdfName, periodLabel, QUICK, quickRange, rowView,
  RULE_TEXT, settingsNote, snapLabel, VIEWS, type Kpi, type ReportDoc, type ReportKind, type ReportRow, type ReportView,
} from './model.ts';
import { formatDateTime } from '../../shared/format.ts';
import './report.css';

const KINDS: readonly ('all' | ReportKind)[] = ['all', 'daily', 'weekly', 'custom'];
const isKind = (v: string | null): v is ReportKind => v === 'daily' || v === 'weekly' || v === 'custom';

export function ReportPage() {
  return <MenuScreen menu="report">{(project) => ('id' in project ? <ReportBody projectId={project.id} projectName={project.name} /> : null)}</MenuScreen>;
}

function ReportBody({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { reportId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const kindParam = params.get('kind');
  const filter = isKind(kindParam) ? kindParam : 'all';
  const viewParam = params.get('view');
  const picked: ReportView | undefined = viewParam === 'int' || viewParam === 'ext' ? viewParam : undefined;

  const list = useAllPages('listReports', { params: { projectId } }, { topics: ['report'] });
  useTopBar(useRevisitFetching(list));
  useRefreshError(list, '보고서 목록 최신 내용 불러오기');
  const all = list.data?.items ?? [];
  const rows = filter === 'all' ? all : all.filter((r) => r.kind === filter);
  const selected = all.find((r) => r.id === reportId) ?? rows[0];

  const setParam = (key: string, value: string | null) => {
    setParams((prev) => { const next = new URLSearchParams(prev); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true });
  };
  const openReport = (id: string, view?: ReportView) => {
    const next = new URLSearchParams(params);
    if (view) next.set('view', view); else next.delete('view');
    void navigate(`/report/${encodeURIComponent(id)}${next.size ? `?${next.toString()}` : ''}`);
  };

  if (list.data === undefined && list.isError) {
    return <LoadError title="보고서" error={list.error} retrying={list.isFetching} onRetry={() => { void list.refetch(); }} />;
  }
  return (
    <Page title="보고서" sub={RULE_TEXT}>
      <CustomForm projectId={projectId} onCreated={(r) => { openReport(r.id, r.view); }} />
      <div className="rp-wrap">
        <div className="rp-side">
          <section className="card" aria-label="보고서 목록">
            <div className="dp-h"><h3>보고서 목록</h3></div>
            <div className="seg" style={{ marginBottom: 8 }} role="group" aria-label="보고서 종류">
              {KINDS.map((k) => (
                <button key={k} type="button" aria-pressed={filter === k} onClick={() => { setParam('kind', k === 'all' ? null : k); }}>
                  {k === 'all' ? '전체' : KIND[k].l} {k === 'all' ? all.length : all.filter((r) => r.kind === k).length}
                </button>
              ))}
            </div>
            {list.data !== undefined && rows.length === 0 && <p className="empty" style={{ margin: 0 }}>해당 종류의 보고서가 없습니다.</p>}
            <div className="rp-list">
              {rows.map((r) => {
                const v = rowView(r);
                return (
                  <button key={r.id} type="button" className={r.id === selected?.id ? 'rp-row on' : 'rp-row'} aria-current={r.id === selected?.id || undefined} onClick={() => { openReport(r.id); }}>
                    <span className="rp-r1"><span className={v.kindC}>{v.kindL}</span><b>{v.periodL}</b>{v.late && <span className="sc sc-warn">누락분 보충</span>}</span>
                    <span className="rp-r2 muted"><span className="mono">{r.reportKey}</span> · 생성 {v.atL} · {v.byL} · {v.audL}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
        <div className="rp-main">
          {list.data === undefined && <section className="card area-load" role="status"><span className="bspin lg" /><span>보고서를 불러오는 중…</span></section>}
          {list.data !== undefined && !selected && (
            <section className="card">
              <p className="empty" style={{ margin: '0 0 6px' }}>아직 보고서가 없습니다.</p>
              <p className="fhint" style={{ margin: 0 }}>일간 보고서는 매일 07:00, 주간 보고서는 매주 월요일 07:00에 자동으로 생성됩니다. 위에서 기간을 지정해 지금 바로 만들 수도 있습니다.</p>
            </section>
          )}
          {selected && <ReportDocument key={selected.id} row={selected} projectName={projectName} view={defaultView(selected, picked)} onView={(v) => { setParam('view', v); }} />}
        </div>
      </div>
    </Page>
  );
}

/** 기간 지정 보고서(UI-11A, P L2093–2102) */
function CustomForm({ projectId, onCreated }: { projectId: string; onCreated: (r: ReportRow) => void }) {
  const { client } = useApi();
  const today = seoulDay(new Date());
  const [form, setForm] = useState<{ from: string; to: string; view: ReportView; err: string }>({ from: '', to: '', view: 'int', err: '' });
  const patch = (p: Partial<typeof form>) => { setForm((f) => ({ ...f, ...p, err: '' })); };
  const { save, busy } = useSave({
    target: '기간 지정 보고서 생성',
    request: () => ({ from: form.from, to: form.to, view: form.view }),
    run: ({ payload, idempotencyKey }) => client.call('createReport', { params: { projectId }, body: payload, idempotencyKey }),
    onSuccess: (r) => { onCreated(r); },
    successNotice: '기간 보고서를 생성했습니다.',
  });
  const create = () => {
    const err = formProblem(form.from, form.to, today);
    if (err) { setForm((f) => ({ ...f, err })); return; }
    void save();
  };
  return (
    <section className="card rp-gen" aria-label="기간 지정 보고서">
      <div className="rp-gen-row">
        <h3 style={{ margin: 0 }}>기간 지정 보고서</h3>
        <span className="rp-gen-f">
          <span className="flabel">기간</span>
          <input className="inp" type="date" value={form.from} max={today} onChange={(e) => { patch({ from: e.target.value }); }} aria-label="시작일" aria-invalid={!!form.err || undefined} />
          <span>~</span>
          <input className="inp" type="date" value={form.to} max={today} onChange={(e) => { patch({ to: e.target.value }); }} aria-label="종료일" aria-invalid={!!form.err || undefined} />
        </span>
        <span className="rp-gen-f">{QUICK.map((q) => <button key={q.key} type="button" className="btn ghost sm" onClick={() => { patch(quickRange(q.key, today)); }}>{q.l}</button>)}</span>
        <span className="rp-gen-f">
          <span className="flabel">기본 보기</span>
          <span className="seg" role="group" aria-label="기본 보기">
            {VIEWS.map((o) => <button key={o.key} type="button" aria-pressed={form.view === o.key} onClick={() => { patch({ view: o.key }); }}>{o.l}</button>)}
          </span>
        </span>
        <BusyButton busy={busy} busyLabel="생성 중…" style={{ marginLeft: 'auto' }} onClick={create}>보고서 생성</BusyButton>
      </div>
      <p className="fhint" style={{ margin: '6px 0 0' }}>지정한 기간의 기록으로 지금 시점 스냅샷을 만듭니다 (최대 93일). 생성 후에도 팀장용 · 보고용 보기를 전환할 수 있습니다.</p>
      {form.err && <div className="banner danger" role="alert" style={{ margin: '8px 0 0' }}><div className="banner-b">{form.err}</div></div>}
    </section>
  );
}

function Kpis({ items }: { items: Kpi[] }) {
  return (
    <div className="rpt-kpis">
      {items.map((k) => <div key={k.label} className="rpt-kpi"><span className="rpt-kl">{k.label}</span><b className="rpt-kv">{k.value}</b><span className="rpt-ks">{k.sub}</span></div>)}
    </div>
  );
}

function ReportDocument({ row, projectName, view, onView }: { row: ReportRow; projectName: string; view: ReportView; onView: (v: ReportView) => void }) {
  const doc = useApiQuery('getReport', { params: { reportId: row.id } }, { topics: ['report', 'schedule'], keepPrevious: false });
  useRefreshError(doc, '보고서 최신 내용 불러오기');
  if (doc.data === undefined && doc.isError) return <LoadError title="보고서" error={doc.error} retrying={doc.isFetching} onRetry={() => { void doc.refetch(); }} />;
  if (doc.data === undefined) return <section className="card area-load" role="status"><span className="bspin lg" /><span>보고서를 불러오는 중…</span></section>;
  const d: ReportDoc = doc.data;
  const changed = changedLabel(d.changesSince);
  const late = lateLabel(row);
  const weekly = row.kind !== 'daily' && d.snapshot.series.length > 1;
  return (
    <>
      <div className="rp-bar">
        {row.kind !== 'daily' && (
          <div className="seg" role="group" aria-label="보고서 보기">
            {VIEWS.map((o) => <button key={o.key} type="button" aria-pressed={view === o.key} onClick={() => { onView(o.key); }}>{o.l}</button>)}
          </div>
        )}
        <span className="muted" style={{ marginRight: 'auto' }} />
        {/* 서버 PDF(M6-02). 파일 이름은 G L405 예시 형식이다. */}
        <a className="btn primary" href={`/api/reports/${encodeURIComponent(row.id)}/pdf?view=${view}`} download={pdfName(row.reportKey, view)}>PDF 다운로드</a>
      </div>
      {changed && <div className="banner warn rp-noprint" role="status"><div className="banner-b">{changed}</div></div>}
      <article className="rpt-doc" aria-label={`${row.reportKey} 보고서`}>
        <header className="rpt-h">
          <div className="rpt-kind">{KIND[row.kind].doc}</div>
          <h2>{docTitle(projectName, row.kind, view)}</h2>
          <div className="rpt-meta">
            <span>기간 <b className="mono">{periodLabel(row)}</b></span>
            <span>생성 <span className="mono">{formatDateTime(row.generatedAt)}</span> · {rowView(row).byL}</span>
            <span className="mono">{row.reportKey}</span>
          </div>
          <p className="rpt-snap">{snapLabel(row.generatedAt)}{late && ` · ${late}`}</p>
          {settingsNote(d.snapshot) && <p className="rpt-snap" role="note">{settingsNote(d.snapshot)}</p>}
        </header>
        {view === 'int' ? <InternalView d={d} kind={row.kind} weekly={weekly} /> : <ExternalSections d={d} kind={row.kind} weekly={weekly} />}
        <footer className="rpt-f">Agent WBS 자동 생성 · {row.reportKey} · {formatDateTime(row.generatedAt)}</footer>
      </article>
    </>
  );
}

/** 팀장용(UI-11B, P L2147–2224). 섹션 번호는 원본 화면 그대로다. */
function InternalView({ d, kind, weekly }: { d: ReportDoc; kind: ReportKind; weekly: boolean }) {
  const x = internalDoc(d.snapshot);
  const task = (key: string, tab?: string) => <Link className="reflink" to={LINK.task(key, tab)}>{key}</Link>;
  return (
    <>
      <Kpis items={x.kpis} />
      <section className="rpt-sec"><h3>팀장 확인 필요</h3>
        {!x.issues.length && <p className="muted">확인할 항목이 없습니다.</p>}
        {x.issues.map((i, n) => <div key={n} className="rpt-li"><span className={i.cls}>{i.label}</span><span>{i.text}</span></div>)}
      </section>
      {weekly && (
        <section className="rpt-sec"><h3>일별 추세</h3>
          <div className="rpt-trend" role="table" aria-label="일별 추세">
            <div className="rpt-tr h" role="row">{['날짜', '가동률', '실행 시도', '완료', 'QA FAIL', '완료 예상'].map((h) => <span key={h} role="columnheader">{h}</span>)}</div>
            {x.series.map((s) => (
              <div key={s.day} className="rpt-tr" role="row">
                <span className="mono" role="cell">{s.day}</span>
                <span className="rpt-bc" role="cell"><span className="rpt-b up" style={{ height: s.upBar }} /><span className="mono">{s.up}</span></span>
                <span className="rpt-bc" role="cell"><span className="rpt-b at" style={{ height: s.aBar }} /><span className="mono">{s.atts}</span></span>
                <span className="mono" role="cell">{s.done}</span><span className="mono" role="cell">{s.fails}</span><span className="mono" role="cell">{s.fc}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="rpt-note">현재 상태 분포 — {x.statusLine}</p>
      <section className="rpt-sec"><h3>1. 완료한 Task</h3>
        {x.noRecord ? <p className="muted" role="note">{x.noRecord}</p> : !x.done.length && <p className="muted">기간 중 완료한 Task가 없습니다.</p>}
        {x.done.map((t) => (
          <div key={t.id} className="rpt-card">
            <div className="rpt-ch"><span className="sc sc-ok">완료</span>{task(t.id)}<span className="mono muted">{t.wbs}</span><b>{t.title}</b><span className="muted" style={{ marginLeft: 'auto' }}>{t.cls}</span></div>
            <div className="rpt-kv">
              <span>담당</span><span>{t.who}</span><span>실제 기간</span><span className="mono">{t.act}</span><span>작업량</span><span>{t.est}</span><span>기준 대비</span><span>{t.slip}</span>
              <span>최종 검증</span><span>{t.verif}</span><span>체크리스트</span><span>{t.cl}</span><span>산출물</span><span>{t.out}</span><span>완료 조건</span><span>{t.cond}</span>
            </div>
          </div>
        ))}
      </section>
      <section className="rpt-sec"><h3>2. 진행 중 · 확인 필요 Task</h3>
        {x.noRecord ? <p className="muted" role="note">{x.noRecord}</p> : !x.active.length && <p className="muted">진행 중인 Task가 없습니다.</p>}
        {x.active.map((t) => (
          <div key={t.id} className="rpt-card">
            <div className="rpt-ch"><span className="tag">{t.st}</span>{task(t.id)}<span className="mono muted">{t.wbs}</span><b>{t.title}</b><span className="muted" style={{ marginLeft: 'auto' }}>{t.cls} · 진행률 {t.pct}</span></div>
            <div className="rpt-kv">
              <span>담당</span><span>{t.who}</span><span>실제 시작</span><span className="mono">{t.start}</span>
              <span>완료 예상</span><span><span className="mono">{t.fc}</span> · {t.slip} · 남은 작업량 {t.remain}</span>
              <span>최근 실행</span><span>{t.last}</span><span>검증</span><span>{t.verif}</span><span>체크리스트</span><span>{t.cl}</span>
              <span>Completion Gate</span><span>{t.gate}</span><span>이슈</span><span>{t.issue}</span><span>다음 작업</span><span><b>{t.next}</b></span>
            </div>
          </div>
        ))}
      </section>
      {x.failures.length > 0 && (
        <section className="rpt-sec"><h3>3. QA 실패 · 결함 상세</h3>
          {x.failures.map((f) => (
            <div key={f.id} className="rpt-card bad">
              <div className="rpt-ch"><span className="sc sc-bad">FAIL</span>{task(f.task, 'verif')}<b>{f.title}</b><span className="mono muted" style={{ marginLeft: 'auto' }}>{f.agent} · {f.at}</span></div>
              <div className="rpt-kv">
                <span>검증 명령</span><span className="mono">{f.cmd}</span><span>기대 결과</span><span>{f.exp}</span><span>실제 결과</span><span>{f.act}</span>
                <span>결함</span><span>{f.defects}</span><span>Evidence</span><span className="mono">{f.ev}</span><span>후속 조치</span><span>{f.follow}</span>
              </div>
            </div>
          ))}
        </section>
      )}
      <section className="rpt-sec"><h3>4. 실행 기록</h3>
        <p>{x.execLine}</p>
        {!x.attempts.length && <p className="muted">기간 중 실행 시도가 없습니다.</p>}
        {x.attempts.length > 0 && (
          <div className="rpt-tbl" role="table" aria-label="실행 기록">
            <div className="rpt-trw h at" role="row">{['시도', 'Task · 종류', 'Agent · 등급', '시간', '결과', '요약', '파일 · 토큰'].map((h) => <span key={h} role="columnheader">{h}</span>)}</div>
            {x.attempts.map((a) => (
              <div key={a.id} className="rpt-trw at" role="row">
                <span className="mono" role="cell">{a.id}</span><span role="cell">{a.task}</span><span role="cell">{a.grade}</span><span className="mono" role="cell">{a.time}</span>
                <span role="cell">{a.st}</span><span role="cell">{a.sum}{a.esc && <><br /><span className="muted">등급 조정: {a.esc}</span></>}</span><span className="mono" role="cell">{a.files} · {a.tok}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="rpt-sec"><h3>5. 일정 재조정</h3>
        {!x.replans.length && <p className="muted">기간 중 재조정이 없습니다.</p>}
        {x.replans.map((r) => (
          <div key={r.id} className="rpt-card">
            <div className="rpt-ch"><span className="mono">{r.id}</span><span className="mono muted">{r.at}</span><b>{r.trigger}</b><span className="mono" style={{ marginLeft: 'auto' }}>완료 예상 {r.ch} (범위 {r.range})</span></div>
            {r.moved.length > 0 && <div className="rpt-moved">{r.moved.map((m) => <div key={m.task}><span className="mono">{m.task}</span> {m.title} — {m.kind} <span className="mono">{m.ch}</span></div>)}</div>}
          </div>
        ))}
      </section>
      <section className="rpt-sec"><h3>6. 작업 환경 중단</h3>
        {!x.gaps.length && <p className="muted">기간 중 중단이 없습니다.</p>}
        {x.gaps.map((g) => <div key={g.from} className="rpt-li"><span className="mono">{g.from} ~ {g.to}</span><span className="mono">{g.dur}</span><span>{g.reason}</span></div>)}
      </section>
      <section className="rpt-sec"><h3>7. 팀장 지시 · Runner 응답</h3>
        {!x.messages.length && <p className="muted">기간 중 메시지가 없습니다.</p>}
        {x.messages.map((m, n) => (
          <div key={n} className="rpt-li"><span className="mono muted">{m.at}</span><span className="mono">{m.task}</span><span>{m.dir}</span><span className="tag">{m.type}</span><span className="muted">{m.st}</span><span style={{ flexBasis: '100%' }}>{m.body}</span></div>
        ))}
      </section>
      <section className="rpt-sec"><h3>8. {kind === 'daily' ? '다음 날 예정' : '다음 주 예정'}</h3>
        {x.noRecord ? <p className="muted" role="note">{x.noRecord}</p> : !x.next.length && <p className="muted">예정된 Task가 없습니다.</p>}
        {x.next.length > 0 && (
          <div className="rpt-tbl" role="table" aria-label="예정">
            <div className="rpt-trw h nx" role="row">{['Task', '제목', '상태', '예상 기간', '담당 · 등급', '선행 조건 · 충돌 묶음'].map((h) => <span key={h} role="columnheader">{h}</span>)}</div>
            {x.next.map((t) => (
              <div key={t.id} className="rpt-trw nx" role="row">
                <span role="cell">{task(t.id)}</span><span role="cell">{t.title} <span className="muted">({t.est})</span></span><span role="cell">{t.st}</span>
                <span className="mono" role="cell">{t.per}</span><span role="cell">{t.who}<br /><span className="muted">{t.grade}</span></span><span role="cell">{t.pre}<br /><span className="muted">{t.cg}</span></span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="rpt-sec rpt-appx"><h3>부록. 전체 Task 현황 (보고서 생성 시점)</h3>
        {x.noRecord ? <p className="muted" role="note">{x.noRecord}</p> : !x.all.length && <p className="muted">Task가 없습니다.</p>}
        <div className="rpt-tbl" role="table" aria-label="전체 Task 현황">
          <div className="rpt-trw h al" role="row">{['WBS', 'Task', '제목', '상태', '개발/검증', '진행률', '체크리스트', '검증', '완료 예상', '기준 대비'].map((h) => <span key={h} role="columnheader">{h}</span>)}</div>
          {x.all.map((t) => (
            <div key={t.id} className="rpt-trw al" role="row">
              <span className="mono" role="cell">{t.wbs}</span><span role="cell">{task(t.id)}</span><span role="cell">{t.title} {t.blocked && <span className="sc sc-bad">차단</span>}</span>
              <span role="cell">{t.st}</span><span role="cell">{t.who}</span><span className="mono" role="cell">{t.pct}</span><span className="mono" role="cell">{t.cl}</span>
              <span role="cell">{t.verif}</span><span className="mono" role="cell">{t.fc}</span><span className="mono" role="cell">{t.slip}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** 보고용(UI-11C, P L2228–2242). 내부 용어 없이 같은 스냅샷 숫자를 쓴다. */
function ExternalSections({ d, kind, weekly }: { d: ReportDoc; kind: ReportKind; weekly: boolean }) {
  const e = externalDoc(d.snapshot, kind);
  return (
    <>
      <Kpis items={e.kpis} />
      <section className="rpt-sec"><h3>요약</h3><ul className="rpt-ul">{e.summary.map((t) => <li key={t}>{t}</li>)}</ul></section>
      {weekly && (
        <section className="rpt-sec"><h3>주간 추이</h3>
          <div className="rpt-trend" role="table" aria-label="주간 추이">
            <div className="rpt-tr h ext" role="row">{['날짜', '작업 환경 가동', '완료', '완료 예상일'].map((h) => <span key={h} role="columnheader">{h}</span>)}</div>
            {e.trendRows.map((s) => (
              <div key={s.day} className="rpt-tr ext" role="row">
                <span className="mono" role="cell">{s.day}</span><span className="rpt-bc" role="cell"><span className="rpt-b up" style={{ height: s.upBar }} /><span className="mono">{s.up}</span></span>
                <span className="mono" role="cell">{s.done}</span><span className="mono" role="cell">{s.fc}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="rpt-sec"><h3>주요 완료 항목</h3>{!e.highlights.length && <p className="muted">기간 중 완료 항목이 없습니다.</p>}<ul className="rpt-ul">{e.highlights.map((t, n) => <li key={n}>{t}</li>)}</ul></section>
      <section className="rpt-sec"><h3>위험 · 이슈</h3><ul className="rpt-ul">{e.risks.map((t) => <li key={t}>{t}</li>)}</ul></section>
      <section className="rpt-sec"><h3>다음 계획</h3>{!e.plan.length && <p className="muted">예정 항목이 없습니다.</p>}<ul className="rpt-ul">{e.plan.map((t, n) => <li key={n}>{t}</li>)}</ul></section>
    </>
  );
}
