/**
 * 대시보드(UI-01)의 화면 없는 계산. 원본 dashVM(P L6274–6333)의 문구·순서·색을 서버 계약(GET /api/dashboard)에 맞춰 옮겼다.
 * 서버가 숫자와 목록을 계산해 보내고, 여기서는 「어떤 글자·색·이동 주소로 보일지」만 정한다.
 * 모든 항목은 이동 주소(to)를 가진다(원본 page-sub 「모든 항목은 관련 Task 목록이나 화면으로 연결됩니다」).
 */
import type { ResponseOf } from '../../shared/api/contract.ts';
import { formatDateTime, tokensK } from '../../shared/format.ts';
import {
  ATTEMPT_KIND_LABEL, ATTEMPT_STATUS, CP_STATUS, DOMAIN_LABEL, EFFORT_LABEL, GATE_SHORT, LINK, monthDay, verdictClass, WORK_TYPE_LABEL,
} from '../verify/labels.ts';

export type Dashboard = ResponseOf<'getDashboard'>;
export type AlertItem = ResponseOf<'listAlerts'>['items'][number];
type Runner = ResponseOf<'getRunnerState'>;

export interface Kpi { l: string; v: string; sub: string; to: string; cls: string; aria: string }
export function taskKpis(t: Dashboard['tasks']): Kpi[] {
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  return [
    { l: '전체 Task', v: String(t.total), sub: `취소 제외 · 완료율 ${String(pct)}%`, to: LINK.wbs(), cls: '' },
    { l: '완료', v: String(t.done), sub: 'Completion Gate 통과', to: LINK.wbs({ status: 'done' }), cls: 'ok' },
    { l: '진행 중', v: String(t.active), sub: '실행 · QA · 재작업 · 재검증 · Gate 대기', to: LINK.wbs({ status: 'active' }), cls: 'run' },
    { l: '선행 차단', v: String(t.blocked), sub: '선행 조건 미충족 — 실행 불가', to: LINK.wbs({ blocked: 'y' }), cls: t.blocked ? 'bad' : '' },
  ].map((k) => ({ ...k, aria: `${k.l} ${k.v}건 — WBS에서 보기` }));
}

const hours = (h: number) => `${String(Math.round(h * 10) / 10)}h`;

export interface SchedCard { l: string; v: string; bar: number | null; sub: string; subC: string; to: string; aria: string }
/** 일정·진행 카드 4개(P sched L6303–6309). 일정이 아직 계산되지 않았으면(null) 빈 배열 */
export function schedCards(s: Dashboard['schedule']): SchedCard[] {
  if (!s) return [];
  const r0 = Math.round;
  const gap = r0(s.progressPct) - r0(s.plannedPct);
  const slack = s.slackDays;
  const late = s.slipDays > 0 || (slack !== null && slack < 0);
  const cards: Omit<SchedCard, 'aria'>[] = [
    {
      l: '진행률 (공수 가중)', v: `${String(r0(s.progressPct))}%`, bar: r0(s.progressPct),
      sub: `계획 ${String(r0(s.plannedPct))}% 대비 ${gap >= 0 ? '+' : ''}${String(gap)}%p`, subC: gap < 0 ? 'sc sc-bad' : 'sc sc-ok', to: LINK.wbs({ view: 'gantt' }),
    },
    {
      l: '완료율', v: `${String(r0(s.doneRatePct))}%`, bar: r0(s.doneRatePct),
      sub: `Task ${String(s.doneCount)}/${String(s.taskCount)} · 공수 기준 ${String(r0(s.doneHoursRatePct))}% (${hours(s.doneHours)}/${hours(s.totalHours)})`,
      subC: 'muted', to: LINK.wbs({ status: 'done' }),
    },
    {
      l: `예상 완료일 (기준 v${String(s.baselineVersion)})`, v: monthDay(s.end), bar: null,
      sub: `범위 ${monthDay(s.lo)} ~ ${monthDay(s.hi)} · 기준 ${monthDay(s.baselineEnd)}${s.slipDays > 0 ? ` 대비 +${String(s.slipDays)}일` : ' 이내'}`
        + (slack === null ? '' : ` · 목표 ${monthDay(s.target)}${slack >= 0 ? `까지 여유 ${String(slack)}일` : ` 대비 ${String(-slack)}일 초과`}`),
      subC: late ? 'sc sc-bad' : 'sc sc-ok', to: LINK.wbs({ view: 'gantt' }),
    },
    {
      l: 'Agent 작업량 · 가용 용량', v: hours(s.totalHours), bar: null,
      sub: `잔여 ${hours(s.remainHours)} · 관측 가동률 ${String(r0(s.rate * 100))}% · 경과 ${String(s.elapsedDays)}일 · 남은 기간 약 ${String(Math.max(0, s.remainingDays))}일 · 최초 기준 v1 ${monthDay(s.firstBaselineEnd)}`,
      subC: 'muted', to: LINK.settings(),
    },
  ];
  return cards.map((k) => ({ ...k, aria: `${k.l} ${k.v}` }));
}

/** 「일정 · 진행」 제목 옆 설명(P schedNote L6332). 동시 실행 한도는 Runner 상태에서 읽는다. */
export function schedNote(s: Dashboard['schedule'], runner: Runner | undefined): string {
  const c = (runner as Partial<Runner> | undefined)?.concurrency;
  const cap = c?.caps.total;
  const limit = c ? (c.limit === null ? cap : Math.min(c.limit, cap ?? c.limit)) : undefined;
  const conc = cap === undefined || limit === undefined ? '동시 실행 한도 —' : `동시 실행 한도 ${String(limit)} (상한 ${String(cap)}, 하위 Agent 포함)`;
  return `${s ? `프로젝트 ${s.start} 시작 · ` : ''}관측 가동률 · ${conc} · 충돌 묶음 직렬화 · 작업 불가일 반영 · 진행률은 상태 단계 가중치 × 예상 실행 시간`;
}

export interface PanelItem { key: string; id: string; t: string; tag: string; tagC: string; to: string }
export interface Panel { title: string; sub: string; items: PanelItem[]; n: string; nCls: string; emptyT: string }

const panel = (title: string, sub: string, items: PanelItem[], emptyT: string, bad: boolean): Panel =>
  ({ title, sub, items, n: String(items.length), nCls: items.length && bad ? 'bad' : '', emptyT });

export function panels(p: Dashboard['panels']): Panel[] {
  const late = p.late.map((x): PanelItem => ({
    key: x.taskKey, id: x.taskKey, t: `${x.title} — 계획 완료 ${monthDay(x.baselineEnd)} → 전망 ${monthDay(x.end)}`,
    ...(x.paused ? { tag: '중단 · 재개 대기', tagC: 'sc sc-warn' }
      : x.slipDays !== null && x.slipDays > 0 ? { tag: `기준 대비 +${String(x.slipDays)}일`, tagC: 'sc sc-bad' }
        : { tag: '착수 지연', tagC: 'sc sc-warn' }),
    to: LINK.task(x.taskKey, 'overview'),
  }));
  const approvals = p.approvals.map((x): PanelItem => (x.kind === 'planning'
    ? { key: `pl-${x.id}`, id: x.planningKey ?? 'Planning', t: x.title, tag: `이견 ${String(x.unresolved)}건 미조정`, tagC: 'kb k-diff', to: LINK.planning(x.id) }
    : { key: `cp-${x.id}`, id: x.cpKey ?? 'CP', t: x.title, tag: CP_STATUS[String(x.status)]?.l ?? String(x.status), tagC: `cps ${CP_STATUS[String(x.status)]?.c ?? ''}`, to: LINK.change(x.id) }));
  const executions = p.executions.map((x): PanelItem => (x.kind === 'running'
    ? { key: `run-${x.attemptId}`, id: x.attemptKey ?? x.taskKey, t: x.title, tag: `${ATTEMPT_KIND_LABEL[String(x.attemptKind)] ?? String(x.attemptKind)} · ${String(x.agent)}`, tagC: 'st s-run', to: LINK.exec(x.taskKey, x.attemptId) }
    : { key: `ready-${x.taskKey}`, id: x.taskKey, t: x.title, tag: '실행 대기', tagC: 'st s-ready', to: LINK.exec(x.taskKey) }));
  const rework = p.rework.map((x): PanelItem => ({
    key: x.taskKey, id: x.taskKey, t: x.title,
    tag: `${x.result === null ? '검증 실패' : String(x.result)}${x.defects ? ` · 결함 ${String(x.defects)}` : ''}`,
    tagC: x.result === null ? 'vf v-fail' : verdictClass(String(x.result)), to: LINK.exec(x.taskKey),
  }));
  const gate = p.gate.map((x): PanelItem => ({
    key: x.taskKey, id: x.taskKey, t: x.title,
    tag: x.unmet.length ? `미충족 ${String(x.unmet.length)} — ${x.unmet.map((k) => GATE_SHORT[String(k)] ?? String(k)).join(', ')}` : '완료 처리 가능',
    tagC: x.unmet.length ? 'vf v-fail' : 'vf v-pass', to: LINK.task(x.taskKey, 'checklist'),
  }));
  const messages = p.messages.map((m): PanelItem => {
    const incoming = m.dir === 'in';
    const tag = incoming ? '새 응답' : m.delivery === 'Failed' ? '전달 실패' : m.pendingNext ? '다음 실행 대기' : '전달 대기';
    return {
      key: m.id, id: m.msgKey, t: `${m.taskKey} · ${incoming ? `${String(m.toAgent ?? 'Agent')} 응답` : `${String(m.type)} → ${String(m.toAgent ?? '')}`}`,
      tag, tagC: incoming ? 'dl d-r' : m.delivery === 'Failed' ? 'dl d-f' : 'dl d-q', to: LINK.task(m.taskKey, 'msg'),
    };
  });
  return [
    panel('일정 지연', '계획 완료일보다 늦어질 것으로 예상되거나 착수가 늦은 Task', late, '지연 예상 Task가 없습니다.', true),
    panel('Planning · 승인 대기', '이견 조정이 필요한 Planning과 승인 · 반영 대기 Change Proposal', approvals, '승인 대기 항목이 없습니다.', true),
    panel('실행 진행 · 대기', 'Runner에서 실행 중인 시도와 바로 실행할 수 있는 Task', executions, '실행 중이거나 대기 중인 Task가 없습니다.', false),
    panel('QA 실패 · 재작업', '최근 검증이 FAIL 또는 BLOCKED인 Task', rework, 'QA 실패 Task가 없습니다.', true),
    panel('Completion Gate 미통과', '검증 PASS 이후 완료 처리 전인 Task와 미충족 조건', gate, 'Gate 대기 Task가 없습니다.', true),
    panel('메시지 확인 필요', '전달 실패 · 전달 대기 · 미확인 Agent 응답', messages, '확인할 메시지가 없습니다.', true),
  ];
}

export interface BarRow { key: string; l: string; en: string; n: number; pct: number; cls: string; to: string; aria: string }
function bars(counts: readonly { key: unknown; count: number }[], lab: (k: string) => string, en: (k: string) => string, field: string): BarRow[] {
  const max = Math.max(1, ...counts.map((c) => c.count));
  return counts.map(({ key, count }) => {
    const k = String(key);
    return { key: k, l: lab(k), en: en(k), n: count, pct: Math.round((count / max) * 100), cls: count ? 'bar-r' : 'bar-r dim', to: LINK.wbs({ [field]: k }), aria: `${lab(k)} ${String(count)}건 — WBS에서 보기` };
  });
}
export const typeBars = (c: Dashboard['byWorkType']) => bars(c, (k) => WORK_TYPE_LABEL[k] ?? k, (k) => k, 'type');
export const domainBars = (c: Dashboard['byDomain']) => bars(c, (k) => k, (k) => DOMAIN_LABEL[k] ?? k, 'domain');

export interface GradeRow { key: string; agent: string; grade: string; n: string; judged: string; fail: string; rateL: string; rateC: string; esc: string; tok: string }
/** 토큰 수를 원본처럼 천 단위(K)로 보인다. 계약 tokens는 개수다. */
/** 토큰 K 표시는 공통 함수(shared/format.ts)를 쓴다. */
export { tokensK };
export function gradeRows(g: Dashboard['grades']): GradeRow[] {
  return g.map((x) => {
    const rate = x.reworkRatePct;
    return {
      key: `${String(x.agent)}|${x.modelId}|${x.effort}`, agent: String(x.agent), grade: `${x.modelId} · ${EFFORT_LABEL[x.effort] ?? x.effort}`,
      n: String(x.attempts), judged: String(x.judged), fail: String(x.fails),
      rateL: rate === null ? '판정 전' : `${String(Math.round(rate))}%`, rateC: rate === null ? 'muted' : rate >= 30 ? 'sc sc-bad' : 'sc sc-ok',
      esc: String(x.escalations), tok: tokensK(x.tokens),
    };
  });
}

/**
 * 최근 결과 한 줄(원본 P L1897: 시각·종류·ID·Task·내용·결과).
 * M3 통합: 서버 후속 3차가 시도 번호(attemptKey)·검증 번호(verificationKey)를 준다. 있으면 원본처럼 3번째 칸이 번호, 4번째가 Task다.
 * 번호가 없는 옛 응답이면 3번째 Task, 4번째 Agent로 보인다(이전 동작).
 */
export interface RecentRow { key: string; at: string; kind: string; id: string; sub: string; t: string; tag: string; tagC: string; to: string }
export function recentRows(r: Dashboard['recent']): RecentRow[] {
  return [...r].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8).map((x) => (x.kind === 'attempt'
    ? {
      key: `a-${x.id}`, at: formatDateTime(x.at), kind: '실행', id: x.attemptKey ?? x.taskKey, sub: x.attemptKey ? x.taskKey : String(x.agent), t: x.text,
      tag: ATTEMPT_STATUS[String(x.status)]?.l ?? String(x.status), tagC: `st ${ATTEMPT_STATUS[String(x.status)]?.c ?? 's-plan'}`, to: LINK.exec(x.taskKey, x.id),
    }
    : {
      key: `v-${x.id}`, at: formatDateTime(x.at), kind: '검증', id: x.verificationKey ?? x.taskKey, sub: x.verificationKey ? x.taskKey : String(x.agent), t: x.text,
      tag: String(x.result), tagC: verdictClass(String(x.result)), to: LINK.verification(x.id),
    }));
}

/**
 * 「팀장 확인 필요」 알림의 이동 주소와 버튼 이름(P alerts L6330의 분기를 서버 알림 key 규칙에 맞춤).
 * - Task가 있는 알림(재작업 한도·재시도 한도·QA 실패 등): 그 Task의 실행 화면. 정책 임계 알림을 해당 Task와 연결한다(UAT-DASH-01 b).
 * - 입력 자료: 프로젝트, 설계 불일치·계약: 설계, CI: 빌드·통합, 메일: 설정 보고서·메일 탭, Telegram: 설정 알림 탭
 * - 그 밖(Runner 연결·준비 상태·외부 쓰기 차단 등): 설정 Runner 탭
 */
export function alertLink(a: AlertItem): { to: string; label: string } {
  const k = a.key.toLowerCase();
  if (a.taskKey) return { to: LINK.exec(a.taskKey), label: `${a.taskKey} 실행 보기` };
  if (k.startsWith('input')) return { to: '/project', label: '프로젝트 보기' };
  if (k.startsWith('drift') || k.startsWith('contract')) return { to: '/design', label: '설계 보기' };
  if (k.startsWith('ci')) return { to: '/ci', label: '빌드 · 통합 보기' };
  if (k.startsWith('mail')) return { to: LINK.settings('report'), label: '설정 보기' };
  if (k.startsWith('tg') || k.startsWith('telegram') || k.startsWith('notify')) return { to: LINK.settings('notify'), label: '설정 보기' };
  return { to: LINK.settings('runner'), label: 'Runner 설정 보기' };
}
