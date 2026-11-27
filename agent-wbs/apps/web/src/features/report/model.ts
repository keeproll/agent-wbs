/**
 * 보고서 화면(UI-11)의 화면 없는 계산. 원본 rpVM(P L6371-6447)과 report 상세 문구(P L3822-3864)를 옮겼다.
 *
 * - 화면은 서버가 저장한 스냅샷만 읽는다. 열 때 다시 계산하지 않는다(G L373).
 *   여기의 함수는 숫자를 바꾸지 않고 「보이는 글자」만 만든다.
 * - 팀장용 핵심 지표와 보고용 문장은 shared(report/view.ts)의 같은 함수를 쓴다. 메일(M6-03)·PDF(M6-02)도 같은 함수를 쓴다.
 *   왜: 화면·메일·PDF의 숫자와 문장이 서로 어긋나지 않게 한다.
 */
import {
  addDays, customPeriodProblem, externalView, scrubInternal, stateMissingFrom, internalKpis, MAX_CUSTOM_DAYS, monthDay, mondayOf, reportFigures, TASK_STATUSES,
  type ExternalView, type Kpi, type ReportSnapshotData,
} from '@awbs/shared';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { formatDateTime, tokensK } from '../../shared/format.ts';
import { END_REASON, EFFORT_LABEL } from '../settings/labels.ts';
import { ATTEMPT_KIND, ATTEMPT_STATUS, DELIVERY, GATE_LABEL, statusOf, TYPE_LABEL, VERIF } from '../task/labels.ts';

export type ReportRow = ResponseOf<'listReports'>['items'][number];
export type ReportDoc = ResponseOf<'getReport'>;
export type ReportKind = ReportRow['kind'];
export type ReportView = 'int' | 'ext';

/** 원본 K(P L6372) */
export const KIND: Record<ReportKind, { l: string; c: string; doc: string }> = {
  daily: { l: '일간', c: 'tag', doc: '일간 보고서' },
  weekly: { l: '주간', c: 'tag rk-w', doc: '주간 보고서' },
  custom: { l: '기간 지정', c: 'tag rk-c', doc: '기간 보고서' },
};
/** 원본 ruleL(P L6446) — 「Mock」 문구만 뺐다. */
export const RULE_TEXT = '일간: 매일 07:00 — 전날 00:00~24:00 (팀장 확인용) · 주간: 매주 월요일 07:00 — 지난주 월~일 (팀장용 + 상급자 보고용) · 보고서는 Agent WBS 서버가 생성(Runner와 무관), 서버가 꺼져 있던 기간은 다음 시작 때 누락분 보충';
export const VIEWS: readonly { key: ReportView; l: string }[] = [{ key: 'int', l: '팀장용 (상세)' }, { key: 'ext', l: '보고용 (요약)' }];

export const periodLabel = (r: { from: string; to: string }) => (r.from === r.to ? r.from : `${r.from} ~ ${r.to}`);
/** 서버가 적은 사유(reports.reason)에 「누락분 보충」이 있으면 늦게 만든 정기 보고서다(apps/api reports/service.ts REASON). */
export const isLate = (r: ReportRow) => r.kind !== 'custom' && (r.reason ?? '').includes('누락분 보충');
/** 「서버 시작 시 누락분 보충 — 예정 2026-11-02 07:00」(G L377) */
export const lateLabel = (r: ReportRow) => (isLate(r) && r.dueAt ? `${r.reason ?? ''} — 예정 ${formatDateTime(r.dueAt)}` : '');

export function rowView(r: ReportRow) {
  return {
    kindL: KIND[r.kind].l, kindC: KIND[r.kind].c, periodL: periodLabel(r), atL: formatDateTime(r.generatedAt),
    byL: r.kind === 'custom' ? '팀장' : '시스템 (정기)', late: isLate(r), audL: r.kind === 'daily' ? '팀장용' : '팀장용 · 보고용',
  };
}

/** 일간은 팀장용만 있다(P canToggle L6416). 나머지는 고른 보기, 없으면 생성 때 정한 기본 보기. */
export const defaultView = (r: ReportRow, picked: ReportView | undefined): ReportView => (r.kind === 'daily' ? 'int' : picked ?? r.view);

/** 기간 입력 검사(P createReport L4991). 문제가 없으면 빈 문자열. 판정은 서버와 같은 shared 함수다. */
export function formProblem(from: string, to: string, today: string): string {
  if (!from || !to) return '시작일과 종료일을 모두 입력하세요.';
  return customPeriodProblem(from, to, today)?.message ?? '';
}
export { MAX_CUSTOM_DAYS };

/** 단축 기간(P quick L6382): 이번 주(월~오늘), 지난 주(월~일), 최근 30일(오늘 포함 30일) */
export function quickRange(kind: 'thisWeek' | 'lastWeek' | 'last30', today: string): { from: string; to: string } {
  const mon = mondayOf(today);
  if (kind === 'thisWeek') return { from: mon, to: today };
  if (kind === 'lastWeek') return { from: addDays(mon, -7), to: addDays(mon, -1) };
  return { from: addDays(today, -29), to: today };
}
export const QUICK: readonly { key: 'thisWeek' | 'lastWeek' | 'last30'; l: string }[] = [
  { key: 'thisWeek', l: '이번 주' }, { key: 'lastWeek', l: '지난 주' }, { key: 'last30', l: '최근 30일' },
];

/** 「생성 이후 일정 재조정 N회 — 현재 완료 예상 X (보고서 기준 Y)」(G L374). 재조정이 없으면 null. */
export function changedLabel(c: ReportDoc['changesSince']): string | null {
  return c.replans > 0 ? `생성 이후 일정 재조정 ${String(c.replans)}회 — 현재 완료 예상 ${c.currentEnd ?? '—'} (보고서 기준 ${c.reportEnd ?? '—'})` : null;
}
export const snapLabel = (generatedAt: string) => `이 보고서는 ${formatDateTime(generatedAt)} 시점의 스냅샷입니다. 이후 데이터가 바뀌어도 내용은 바뀌지 않습니다.`;
/** 보고용 제목의 프로젝트 이름도 자유 입력이라 내부 용어를 뺀다(리뷰 M6-01 3). */
export const docTitle = (projectName: string, kind: ReportKind, view: ReportView) =>
  `${view === 'ext' ? scrubInternal(projectName) : projectName} — ${KIND[kind].doc}${view === 'ext' ? ' (보고용)' : ''}`;
/** PDF 파일 이름(G L405 예: `RPT-W-261027_보고용.pdf`) */
export const pdfName = (reportKey: string, view: ReportView) => `${reportKey}_${view === 'int' ? '팀장용' : '보고용'}.pdf`;

/* ---- 팀장용 상세(P doneDet·actDet·failDet·attTab·rpDet·msgDet·nextDet·allTab L3822-3862) ---- */
type S = ReportSnapshotData;
const hours = (n: number) => `${String(n)}h`;
const mdhm = (iso: string) => formatDateTime(iso).slice(5);
const hm = (iso: string) => formatDateTime(iso).slice(11);
const day = (iso: string) => formatDateTime(iso).slice(0, 10);
const gradeL = (g: { modelId: string; effort: string } | null) => (g ? `${g.modelId} · ${EFFORT_LABEL[g.effort] ?? g.effort}` : '—');
const who = (t: { assignee: string | null; verifier: string | null }) => `${t.assignee ?? '—'} 개발 · ${t.verifier ?? '—'} 검증`;
const clL = (c: { done: number; total: number; requiredLeft: number }) =>
  (c.total ? `${String(c.done)} / ${String(c.total)}${c.requiredLeft ? ` (필수 ${String(c.requiredLeft)}건 남음)` : ' (필수 완료)'}` : '미등록');
const blockL = (bs: S['active'][number]['blockers']) => bs.map((b) => `${b.pred}(${b.type}, ${statusOf(b.status).l})`).join(', ');
const slipL = (slip: number | null, done: boolean) => {
  if (slip === null) return done ? '—' : '신규';
  if (slip > 0) return `기준 대비 +${String(slip)}일`;
  if (slip < 0) return done ? '기준 내' : `기준보다 ${String(-slip)}일 빠름`;
  return done ? '기준 내' : '기준 일정';
};
const MOVE: Record<string, string> = { delayed: '지연', advanced: '앞당김', new: '신규 편입', excluded: '제외' };
const ISSUE: Record<string, { cls: string; label: string }> = {
  bad: { cls: 'sc sc-bad', label: '조치 필요' }, warn: { cls: 'sc sc-warn', label: '확인' }, info: { cls: 'sc sc-none', label: '참고' },
};

export function internalDoc(s: S) {
  const f = reportFigures(s);
  const a = s.summary.attempts;
  const maxS = Math.max(1, ...s.series.map((x) => Math.max(x.attempts, x.done)));
  const order = (st: string) => TASK_STATUSES.indexOf(st as never);
  const missingFrom = stateMissingFrom(s);
  return {
    kpis: internalKpis(s),
    /** 그 시점 상태를 되살릴 수 없으면 안내 문구(상태 칸 대신 보인다), 아니면 null */
    noRecord: missingFrom ? `기록 없음 — 이 기간 끝 시점의 상태는 상태 기록 시작(${missingFrom}) 전이라 되살릴 수 없습니다.` : null,
    statusLine: missingFrom ? '기록 없음' : s.summary.statuses.length ? [...s.summary.statuses].sort((x, y) => order(x.status) - order(y.status)).map((x) => `${statusOf(x.status).l} ${String(x.count)}`).join(' · ') : 'Task 없음',
    execLine: `실행 시도 ${String(a.total)}건 (개발 · 재작업 ${String(a.dev)} / QA · 재검증 ${String(a.qa)}) · 검증 PASS ${String(a.pass)} · FAIL ${String(a.fail)} · 등급 자동 상향 ${String(a.escalated)} · 중단 ${String(a.interrupted)} · 토큰 ${tokensK(a.tokens)}`,
    issues: s.issues.map((x) => ({ ...(ISSUE[x.level] ?? { cls: 'sc sc-none', label: '참고' }), text: x.text, taskKey: x.taskKey })),
    series: s.series.map((x) => ({
      day: monthDay(x.day), up: `${String(x.uptimePct)}%`, atts: String(x.attempts), done: String(x.done), fails: String(x.fails), fc: monthDay(x.forecast),
      upBar: Math.max(2, x.uptimePct * 0.4), aBar: Math.max(2, (x.attempts / maxS) * 40),
    })),
    done: s.done.map((t) => ({
      id: t.taskKey, wbs: t.wbsPath, title: t.title, cls: `${TYPE_LABEL[t.workType] ?? t.workType} / ${t.domain}`, who: who(t),
      act: `${t.actStart ? formatDateTime(t.actStart) : '—'} ~ ${formatDateTime(t.actEnd)}`,
      est: `${hours(t.estHours)} → 실제 ${hours(t.actualHours)} (시도 ${String(t.attempts)}회)`,
      verif: t.verification ? `${t.verification.result} · ${t.verification.cmd} → ${t.verification.actual}` : '검증 기록 없음',
      cl: clL(t.checklist), out: t.outputs.names.length ? `${String(t.outputs.delivered)} / ${String(t.outputs.names.length)} 제출 — ${t.outputs.names.join(', ')}` : '미정의',
      cond: t.doneCond || '—', slip: slipL(t.slipDays, true),
    })),
    active: s.active.map((t) => {
      const la = t.lastAttempt;
      return {
        id: t.taskKey, wbs: t.wbsPath, title: t.title, cls: `${TYPE_LABEL[t.workType] ?? t.workType} / ${t.domain}`, st: statusOf(t.status).l, who: who(t), pct: `${String(t.progressPct)}%`,
        start: t.actStart ? formatDateTime(t.actStart) : '—', fc: t.end ? `${t.end} (범위 ${monthDay(t.lo)} ~ ${monthDay(t.hi)})` : '—',
        remain: t.remainHours === null ? '—' : hours(t.remainHours), slip: slipL(t.slipDays, false),
        last: la ? `${la.attemptKey} ${ATTEMPT_KIND[la.kind] ?? la.kind} (${la.agent}${la.grade ? ` · ${gradeL(la.grade)}` : ''}, ${ATTEMPT_STATUS[la.status]?.l ?? la.status}) — ${la.summary}` : '실행 기록 없음',
        verif: t.verification ? `${t.verification.result} — ${t.verification.actual}` : '—', cl: clL(t.checklist),
        gate: `${String(t.gate.passed)} / 5${t.gate.unmet.length ? ` — 미충족: ${t.gate.unmet.map((k) => GATE_LABEL[k] ?? k).join(', ')}` : ''}`,
        issue: [t.blockingDefects ? `차단 결함 ${String(t.blockingDefects)}건` : '', t.blockers.length ? `선행 미충족: ${blockL(t.blockers)}` : ''].filter(Boolean).join(' · ') || '없음',
        next: t.next,
      };
    }),
    failures: s.failures.map((v) => ({
      id: v.verificationId, task: v.taskKey, title: v.title, agent: v.agent, at: mdhm(v.at), cmd: v.cmd, exp: v.expected || '—', act: v.actual || '—',
      defects: v.defects.join(' / ') || '—', ev: v.evidence.join(', ') || '—',
      follow: `${v.messages.length ? `수정 지시 ${v.messages.map((m) => `${m.msgKey}(${DELIVERY[m.delivery] ?? (m.delivery || '—')})`).join(', ')}` : '수정 지시 없음'} · ${v.reworks.length ? `재작업 ${v.reworks.map((r) => `${r.attemptKey} ${ATTEMPT_STATUS[r.status]?.l ?? r.status}`).join(', ')}` : '재작업 시작 전'}`,
    })),
    attempts: s.attempts.map((x) => ({
      id: x.attemptKey, task: `${x.taskKey} · ${ATTEMPT_KIND[x.kind] ?? x.kind}`, grade: `${x.agent} · ${gradeL(x.grade)}`,
      time: `${mdhm(x.startedAt)} ~ ${x.endedAt ? (day(x.endedAt) === day(x.startedAt) ? hm(x.endedAt) : mdhm(x.endedAt)) : '진행 중'}`,
      st: ATTEMPT_STATUS[x.status]?.l ?? x.status, sum: x.summary, esc: x.adjust ? `${x.adjust.from.model} ${x.adjust.from.effort} → ${x.adjust.to.model} ${x.adjust.to.effort} — ${x.adjust.reason}` : '',
      files: x.files ? `${String(x.files)}개` : '—', tok: x.tokens ? tokensK(x.tokens) : '—',
    })),
    replans: s.replans.map((r) => ({
      id: r.replanId, at: mdhm(r.at), trigger: r.trigger, ch: `${r.before ?? '최초'} → ${r.after}`, range: `${monthDay(r.lo)} ~ ${monthDay(r.hi)}`,
      moved: r.moved.map((m) => ({ task: m.taskKey, title: m.title, kind: MOVE[m.kind] ?? m.kind,
        ch: `${monthDay(m.before)} → ${monthDay(m.after)}${m.deltaDays ? ` (${m.deltaDays > 0 ? '+' : ''}${String(m.deltaDays)}일)` : ''}` })),
    })),
    gaps: s.gaps.map((g) => ({ from: mdhm(g.from), to: g.to ? mdhm(g.to) : '진행 중', dur: `${String(Math.round(g.minutes / 6) / 10)}시간`, reason: END_REASON[g.reason] ?? g.reason })),
    messages: s.messages.map((m) => ({
      at: mdhm(m.at), task: m.taskKey, dir: m.dir === 'out' ? `팀장 → ${m.agent ?? '—'}` : `${m.agent ?? '—'} → 팀장`, type: m.type,
      st: m.dir === 'out' ? `${m.delivery ? DELIVERY[m.delivery] ?? m.delivery : '—'}${m.pendingNext ? ' · 다음 실행 대기' : ''}` : '응답', body: m.firstLine,
    })),
    next: s.next.map((t) => ({
      id: t.taskKey, title: t.title, est: hours(t.estHours), st: statusOf(t.status).l, per: `${monthDay(t.start)} ~ ${monthDay(t.end)}`, who: who(t), grade: gradeL(t.grade),
      pre: t.blockers.length ? `선행 미충족 — ${blockL(t.blockers)}` : '선행 충족', cg: t.conflictGroup ?? '—',
    })),
    all: s.all.map((t) => ({
      wbs: t.wbsPath, id: t.taskKey, title: t.title, st: statusOf(t.status).l, who: `${t.assignee ?? '—'}/${t.verifier ?? '—'}`, pct: `${String(t.progressPct)}%`,
      cl: t.checklist.total ? `${String(t.checklist.done)}/${String(t.checklist.total)}` : '—', verif: VERIF[t.verifState]?.l ?? '—',
      fc: t.status === 'done' ? `완료 ${monthDay(t.end)}` : monthDay(t.end),
      slip: t.slipDays === null || t.status === 'done' ? '' : t.slipDays > 0 ? `+${String(t.slipDays)}일` : t.slipDays < 0 ? `${String(t.slipDays)}일` : '0', blocked: t.blocked,
    })),
    gapHours: f.gapHours,
  };
}
export type InternalDoc = ReturnType<typeof internalDoc>;

/** 보고용(P kpisExt·summ·risksExt·plan). 계산은 shared externalView 하나다. */
export function externalDoc(s: S, kind: ReportKind): ExternalView & { trendRows: { day: string; up: string; upBar: number; done: string; fc: string }[] } {
  const e = externalView(s, kind);
  return { ...e, trendRows: e.trend.map((x) => ({ day: monthDay(x.day), up: `${String(x.uptimePct)}%`, upBar: Math.max(2, x.uptimePct * 0.4), done: String(x.done), fc: monthDay(x.forecast) })) };
}
export type { Kpi };
