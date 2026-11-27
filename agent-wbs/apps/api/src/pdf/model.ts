/**
 * 보고서 PDF의 보기 계산(팀장용·보고용 글자). 화면 계산 apps/web/src/features/report/model.ts를 그대로 옮긴 것이다.
 *
 * 왜 옮겼나:
 * - G L410은 「화면용 HTML 하나로 만들고, 서버가 같은 HTML을 PDF로 바꾼다」고 한다. 서버(api)는 웹 소스를 빌드에 넣을 수 없다(빌드 범위가 apps/api/src).
 * - 그래서 같은 계산을 여기 두고, 시나리오 시험(e2e/fakes/test/pdf.scenario.test.ts)이 **모든 보고서에서 두 계산의 결과가 같은지** 비교한다.
 *   화면 쪽이 바뀌면 그 시험이 실패해 여기도 고치게 된다.
 * - 숫자 자체는 바꾸지 않는다. 핵심 지표·보고용 문장은 shared(report/view.ts)의 같은 함수를 쓴다.
 *
 * 문구 상수는 원본(P)에서 웹이 옮긴 값과 같다. 출처: apps/web/src/features/task/labels.ts·settings/labels.ts.
 */
import {
  externalView, scrubInternal, stateMissingFrom, toMicro, internalKpis, monthDay, reportFigures, TASK_STATUSES, type ExternalView, type ReportKind, type ReportSnapshotData,
} from '@awbs/shared';

export type ReportView = 'int' | 'ext';

/* ---- 표시 형식(apps/web/src/shared/format.ts) ---- */
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** 서울 시각 `YYYY-MM-DD HH:mm`(원본 nowStr P L3390과 같은 모양) */
export function formatDateTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  const p = Object.fromEntries(parts.formatToParts(date).map((part) => [part.type, part.value]));
  return `${p.year ?? ''}-${p.month ?? ''}-${p.day ?? ''} ${p.hour ?? ''}:${p.minute ?? ''}`;
}
const tokensK = (n: number) => `${String(Math.round(n / 1000))}K`;

/* ---- 문구(apps/web/src/features/task/labels.ts, settings/labels.ts — 원본 P 값) ---- */
/** P L2911 */
const TYPE_LABEL: Record<string, string> = {
  Analysis: '분석', Design: '설계', Implementation: '구현', Configuration: '구성', Test: '테스트', Verification: '검증', Documentation: '문서화', Integration: '통합',
};
/** P L2912–2925(상태 이름만) */
const STATUS: Record<string, string> = {
  planning: '계획 중',
  approval: '승인 대기',
  ready: '실행 대기',
  running: '실행 중',
  qa: 'QA 진행',
  rework: '재작업 필요',
  verifying: '검증 진행',
  gate: 'Gate 대기',
  paused: '중단 · 재개 대기',
  done: '완료',
  failed: '실패',
  cancelled: '취소됨',
};
const statusOf = (s: string) => ({ l: STATUS[s] ?? s });
/** P L2928 */
const VERIF: Record<string, { l: string }> = { none: { l: '미실시' }, running: { l: '검증 중' }, pass: { l: 'PASS' }, fail: { l: 'FAIL' }, blocked: { l: 'BLOCKED' } };
const DELIVERY: Record<string, string> = { Draft: '작성 중', Queued: '전달 대기', Sent: '전달 완료', Acknowledged: '수신 확인', Failed: '전달 실패', Cancelled: '전송 취소' };
const ATTEMPT_STATUS: Record<string, { l: string }> = { completed: { l: '완료' }, failed: { l: '실패' }, running: { l: '실행 중' }, interrupted: { l: '중단' } };
const ATTEMPT_KIND: Record<string, string> = { dev: '개발', qa: 'QA', rework: '재작업', reverify: '재검증' };
/** Completion Gate 5조건 이름(P L3693–3697) */
const GATE_LABEL: Record<string, string> = {
  checklist: '필수 Checklist 완료', outputs: '필수 산출물 존재', verification: '필요한 Verification 통과', defects: '미해결 차단 결함 없음', approval: '필요한 승인 완료',
};
const END_REASON: Record<string, string> = { reboot: '재부팅', power_off: 'PC 꺼짐', error: '오류', manual: '수동 중지', unknown: 'heartbeat 끊김' };
const EFFORT_LABEL: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };

/* ---- 머리말(apps/web report/model.ts KIND·periodLabel·lateLabel·snapLabel·docTitle·pdfName) ---- */
export interface ReportHead { reportKey: string; kind: ReportKind; from: string; to: string; generatedAt: string; dueAt: string | null; reason: string | null }
/** 원본 K(P L6372) */
export const KIND: Record<ReportKind, { l: string; doc: string }> = {
  daily: { l: '일간', doc: '일간 보고서' }, weekly: { l: '주간', doc: '주간 보고서' }, custom: { l: '기간 지정', doc: '기간 보고서' },
};
export const periodLabel = (r: { from: string; to: string }) => (r.from === r.to ? r.from : `${r.from} ~ ${r.to}`);
const isLate = (r: ReportHead) => r.kind !== 'custom' && (r.reason ?? '').includes('누락분 보충');
/** 「서버 시작 시 누락분 보충 — 예정 2026-11-02 07:00」(G L377) */
export const lateLabel = (r: ReportHead) => (isLate(r) && r.dueAt ? `${r.reason ?? ''} — 예정 ${formatDateTime(r.dueAt)}` : '');
export const byLabel = (kind: ReportKind) => (kind === 'custom' ? '팀장' : '시스템 (정기)');
/* M6 통합: M6-01 기간 말 재구성(fb9d537)의 머리말 안내를 화면과 같게 옮긴다(snapLabel·settingsNote·uncertainNote·appendixTitle). */
/** 설정 묶음 이름(스냅샷 basis.currentSettings 값) */
const SETTING_GROUP: Record<string, string> = { schedule: '일정 정책', blackouts: '작업 불가일', heartbeat: '연결 확인 주기', concurrency: '동시 실행 한도' };
/** 「설정은 현재 값」 안내. 그 시점 설정을 알 수 없어 지금 값으로 계산한 묶음이 있으면 문구, 없으면 null. */
export function settingsNote(s: ReportSnapshotData): string | null {
  const groups = s.basis?.currentSettings ?? [];
  return groups.length ? `설정은 현재 값 — ${groups.map((g) => SETTING_GROUP[g] ?? g).join(' · ')}은 이 시점의 값을 알 수 없어 보고서를 만든 때의 값으로 계산했습니다.` : null;
}
/** 스냅샷 안내. 생성 시각과 상태 기준 시각(basis.asOf)을 따로 쓴다. basis가 없는 예전 보고서는 예전 문구. */
export function snapLabel(generatedAt: string, s: ReportSnapshotData): string {
  const asOf = s.basis?.asOf;
  if (!asOf) return `이 보고서는 ${formatDateTime(generatedAt)} 시점의 스냅샷입니다. 이후 데이터가 바뀌어도 내용은 바뀌지 않습니다.`;
  const end = toMicro(asOf) < toMicro(generatedAt) ? '(기간 끝)' : '(생성 시각)';
  return `이 보고서는 ${formatDateTime(generatedAt)}에 만들었습니다. 상태 값은 ${formatDateTime(asOf)} 직전${end} 기준입니다. 이후 데이터가 바뀌어도 내용은 바뀌지 않습니다.`;
}
/** 「경계 불확실 n건」 안내. 실제 커밋 시각을 몰라 이 시점 상태에 넣지 않은 변경이 있으면 문구, 없으면 null. */
export function uncertainNote(s: ReportSnapshotData): string | null {
  const n = s.basis?.uncertain ?? 0;
  return n > 0 ? `경계 불확실 ${String(n)}건 — 실제 커밋 시각을 알 수 없어 이 시점 상태에 넣지 않았습니다. 커밋 시계 값으로는 기준 전이지만 실제로 확정됐는지 확인되지 않은 변경입니다.` : null;
}
export const appendixTitle = (s: ReportSnapshotData) => `부록. 전체 Task 현황 (${s.basis ? '기간 끝 시점' : '보고서 생성 시점'})`;
/** 보고용 제목의 프로젝트 이름도 자유 입력이라 내부 용어를 뺀다(리뷰 M6-01 3). */
export const docTitle = (projectName: string, kind: ReportKind, view: ReportView) =>
  `${view === 'ext' ? scrubInternal(projectName) : projectName} — ${KIND[kind].doc}${view === 'ext' ? ' (보고용)' : ''}`;
/** PDF 파일 이름(G L410 예: `RPT-W-261027_보고용.pdf`) */
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
