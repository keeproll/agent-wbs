/**
 * 보고서 보기(팀장용 int · 보고용 ext)의 화면 없는 계산(P rpVM L6392-6430, G L394-396, §9.6-4 L1048).
 *
 * - 두 보기는 **같은 스냅샷**에서 숫자를 읽는다. 왜: 두 보기의 숫자가 다르면 어느 쪽을 믿어야 할지 모른다(milestones §4.0).
 * - 보고용 문장은 숫자와 같은 스냅샷에서 템플릿으로 만든다. 왜: Agent에게 자유 작성을 맡기면 숫자와 문장이 어긋날 수 있다(G L1048).
 * - 화면(features/report)·메일(M6-03)·PDF(M6-02)가 이 함수를 함께 쓴다. 그래서 같은 문장이 세 곳에 나간다.
 */
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { ReportSnapshot } from '../api/models.ts';
import { daysBetween, seoulDay } from './period.ts';

export type ReportSnapshotData = Static<typeof ReportSnapshot>;
/** 스냅샷 저장 전 검사(data-model §1: jsonb는 쓰기 시 TypeBox 검증)에 쓰는 계약 스키마. */
export { ReportSnapshot as ReportSnapshotSchema };
export interface Kpi { label: string; value: string; sub: string }

/** `2026-11-10` → `11-10`. 없으면 `—` */
export const monthDay = (day: string | null): string => (day ? day.slice(5) : '—');
const fullDay = (day: string | null): string => day ?? '—';

/**
 * 그 시점 상태를 되살릴 수 없는 보고서면 상태 기록 시작일(서울 날짜), 아니면 null(owner 2026-11-27 아이템 13).
 * 이때 상태에서 나온 숫자(완료·작업량·상태 분포 등)는 0이 아니라 「기록 없음」이다. 지어낸 0을 보이지 않는다.
 */
export function stateMissingFrom(s: ReportSnapshotData): string | null {
  if (!s.basis?.missing.includes('state')) return null;
  return s.basis.stateFrom ? seoulDay(s.basis.stateFrom) : '—';
}
export const NO_RECORD = '기록 없음';

/** 두 보기가 함께 쓰는 계산값. 화면 문구는 이 값만 쓴다. */
export function reportFigures(s: ReportSnapshotData) {
  const m = s.summary;
  const forecastDeltaDays = m.forecast !== null && m.forecastBefore !== null ? daysBetween(m.forecastBefore, m.forecast) : null;
  const slackDays = m.forecast !== null && m.target !== null ? daysBetween(m.forecast, m.target) : null;
  const gapMinutes = s.gaps.reduce((sum, g) => sum + g.minutes, 0);
  return {
    doneInPeriod: s.done.length, doneTotal: m.doneCount, taskCount: m.taskCount, workPct: m.workPct, workPctBefore: m.workPctBefore,
    baselineVersion: m.baselineVersion, forecast: m.forecast, lo: m.lo, hi: m.hi, target: m.target, uptimePct: m.uptimePct,
    forecastDeltaDays, slackDays, gapHours: Math.round(gapMinutes / 6) / 10,
    pass: m.attempts.pass, fail: m.attempts.fail, blocked: m.blocked,
  };
}

/** 「기간 시작 대비 +3일 지연」(P L6394). 비교할 값이 없으면 빈 문자열. */
export function forecastDeltaLabel(delta: number | null): string {
  if (delta === null) return '';
  if (delta > 0) return `기간 시작 대비 +${String(delta)}일 지연`;
  if (delta < 0) return `기간 시작 대비 ${String(-delta)}일 단축`;
  return '기간 시작 대비 변동 없음';
}

const pctText = (n: number) => `${String(n)}%`;

/** 팀장용 핵심 지표 4개(P kpis L6418-6419). */
export function internalKpis(s: ReportSnapshotData): Kpi[] {
  const f = reportFigures(s);
  const delta = forecastDeltaLabel(f.forecastDeltaDays);
  const none = stateMissingFrom(s);
  const noneSub = `상태 기록 시작(${none ?? ''}) 전 시점`;
  return [
    none ? { label: '완료 (기간)', value: NO_RECORD, sub: noneSub } : { label: '완료 (기간)', value: `${String(f.doneInPeriod)}건`, sub: `누적 ${String(f.doneTotal)} / ${String(f.taskCount)}건` },
    none ? { label: '작업량 기준 완료율', value: NO_RECORD, sub: noneSub } : { label: '작업량 기준 완료율', value: pctText(f.workPct), sub: `기간 시작 ${pctText(f.workPctBefore)}` },
    { label: `완료 예상 (기준 v${String(f.baselineVersion)})`, value: monthDay(f.forecast), sub: `범위 ${monthDay(f.lo)} ~ ${monthDay(f.hi)}${delta ? ` · ${delta}` : ''}` },
    { label: '가동률 (기간)', value: pctText(f.uptimePct), sub: f.gapHours ? `중단 ${String(f.gapHours)}시간` : '중단 없음' },
  ];
}

export interface ExternalView {
  kpis: Kpi[];
  summary: string[];
  trend: { day: string; uptimePct: number; done: number; forecast: string | null }[];
  highlights: string[];
  risks: string[];
  plan: string[];
}

/** 보고용(요약) 보기(P summ·risksExt·kpisExt·plan L6400-6412·L6420·L6430). 일간은 보고용이 없지만 같은 함수로 만들 수 있다. */
export function externalView(s: ReportSnapshotData, kind: 'daily' | 'weekly' | 'custom', appUrl?: string | null): ExternalView {
  const f = reportFigures(s);
  const delta = forecastDeltaLabel(f.forecastDeltaDays);
  const slack = f.slackDays;
  const target = fullDay(f.target);
  const none = stateMissingFrom(s);
  const summary = [
    none ? `이 기간 끝 시점의 진행 현황은 기록이 없어 산정하지 않았습니다(상태 기록 시작 ${none}).` : `기간 중 ${String(f.doneInPeriod)}건 완료, 누적 ${String(f.doneTotal)} / ${String(f.taskCount)}건 (작업량 기준 ${pctText(f.workPct)}${f.workPct !== f.workPctBefore ? `, 기간 시작 ${pctText(f.workPctBefore)}` : ''}).`,
    f.forecast !== null
      ? `완료 예상일은 ${f.forecast} (범위 ${monthDay(f.lo)} ~ ${monthDay(f.hi)})${delta ? `, ${delta}` : ''}${slack === null ? '.' : slack >= 0 ? ` — 목표일(${target})까지 여유 ${String(slack)}일.` : ` — 목표일(${target}) 대비 ${String(-slack)}일 초과 예상.`}`
      : '완료 예상일을 아직 산정하지 않았습니다.',
    f.fail
      ? `품질 검증에서 ${String(f.fail)}건이 기준을 통과하지 못해 보완 작업을 진행${f.pass ? `했고, ${String(f.pass)}건은 통과했습니다.` : '하고 있습니다.'}`
      : f.pass ? `품질 검증 ${String(f.pass)}건 모두 통과했습니다.` : '기간 중 품질 검증 결과는 없습니다.',
    f.gapHours ? `작업 환경 중단이 총 ${String(f.gapHours)}시간 있었으며(재부팅 · 전원 꺼짐 등), 일정에 자동 반영했습니다.` : '작업 환경 중단 없이 진행했습니다.',
  ];
  const risks: string[] = [];
  if (slack !== null && slack < 0) risks.push('목표일 초과 예상 — 범위 조정 또는 일정 협의 필요');
  if (f.fail) risks.push(`품질 보완 작업 ${String(f.fail)}건 — 보완 후 재검증 예정`);
  if (f.blocked) risks.push(`선행 작업 대기 ${String(f.blocked)}건 — 선행 완료 후 순차 진행`);
  if (f.gapHours >= 12) risks.push('작업 환경 가동 중단이 길어 진행 속도 저하');
  if (none) risks.push(`진행 현황 기록 없음 — 상태 기록 시작(${none}) 전 기간`);
  if (!risks.length) risks.push('특이 위험 없음');
  return {
    kpis: [
      none ? { label: '완료', value: NO_RECORD, sub: `상태 기록 시작(${none}) 전 시점` } : { label: '완료', value: `${String(f.doneInPeriod)}건`, sub: `누적 ${String(f.doneTotal)} / ${String(f.taskCount)}건` },
      none ? { label: '진척률 (작업량)', value: NO_RECORD, sub: `상태 기록 시작(${none}) 전 시점` } : { label: '진척률 (작업량)', value: pctText(f.workPct), sub: `기간 시작 ${pctText(f.workPctBefore)}` },
      { label: '완료 예상일', value: fullDay(f.forecast), sub: `범위 ${monthDay(f.lo)} ~ ${monthDay(f.hi)}` },
      { label: '목표일 대비', value: slack === null ? '—' : slack >= 0 ? `여유 ${String(slack)}일` : `${String(-slack)}일 초과`, sub: `목표 ${target}` },
    ],
    summary,
    // 일간은 추이를 보이지 않는다(P isWeekly L6413).
    trend: kind === 'daily' ? [] : s.series.map((x) => ({ day: x.day, uptimePct: x.uptimePct, done: x.done, forecast: x.forecast })),
    highlights: s.done.map((x) => externalText(x.title, appUrl)),
    risks,
    plan: s.next.map((x) => `${externalText(x.title, appUrl)} (${monthDay(x.start)} ~ ${monthDay(x.end)})`),
  };
}

/**
 * 보고용에 들어가면 안 되는 내부 용어(G L396: Task ID, 실행 시도, 모델 · Effort, 토큰, RP 번호)를 찾는다.
 * 보고용 문장·메일 본문 검사(M6-01·M6-03)가 함께 쓴다.
 */
const INTERNAL_TERMS: readonly RegExp[] = [
  /TASK-\d{4,}/g, /RP-\d{3,}/g, /ATT-\d{4,}-\d+/g, /\bclaude-[a-z0-9.-]+/gi, /\bgpt-[a-z0-9.-]+/gi, /Effort/gi, /토큰/g, /\btokens?\b/gi, /실행 시도/g,
];
export function internalTerms(text: string): string[] {
  return INTERNAL_TERMS.flatMap((re) => text.match(re) ?? []);
}

/**
 * 앱 화면의 첫 경로(apps/web 메뉴 · 로그인 · API). 「/report/…」처럼 글에 적힌 앱 안 경로를 찾을 때 쓴다.
 * 메뉴를 늘리면 여기에도 더한다(shared 시험이 web 메뉴와 같은지 확인한다).
 */
export const APP_PATHS = ['dashboard', 'project', 'wbs', 'design', 'planning', 'exec', 'verify', 'ci', 'change', 'history', 'report', 'settings', 'api', 'login'] as const;
/** 같은 PC · 같은 네트워크에서만 열리는 주소(로컬 · 사설 IP · .local). 외부 사람에게는 열리지 않는 앱 주소로 본다. */
const LOCAL_HOST = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[\w-]+\.local)`;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hostOf = (appUrl: string | null | undefined) => { try { return appUrl ? new URL(appUrl.trim()).host : null; } catch { return null; } };

/**
 * 앱 링크 · 앱 안 경로 · 앱 메뉴 안내를 찾는 정규식(Q-13 결정 A, Codex 리뷰 fix1 2).
 * - 앱 접속 주소(설정 → 알림의 `app_url`)의 호스트가 들어간 주소(`http://` 생략 포함)
 * - 로컬 · 사설 주소(위 LOCAL_HOST)
 * - 공백 · 괄호 뒤에 오는 앱 경로(`/report/…`, `/settings/report` 등 APP_PATHS)
 * - 「설정 → 보고서 · 메일」 같은 앱 메뉴 안내
 * 일반 외부 참고 주소(예: `https://example.org/spec`)는 지우지 않는다. 왜: 업무 문장의 참고 자료까지 없애면 보고 내용이 상한다.
 */
function linkPatterns(appUrl?: string | null): RegExp[] {
  const host = hostOf(appUrl);
  return [
    ...(host ? [new RegExp(String.raw`(?:https?:\/\/)?${escapeRe(host)}[^\s<>"'()[\]」』]*`, 'gi')] : []),
    new RegExp(String.raw`(?:https?:\/\/)?${LOCAL_HOST}(?::\d+)?(?:\/[^\s<>"'()[\]」』]*)?`, 'gi'),
    new RegExp(String.raw`(?<![\w.:/-])\/(?:${APP_PATHS.join('|')})(?:\/[^\s<>"'()[\]」』]*)?(?![\w-])`, 'g'),
    /설정\s*→\s*[^\s,.)」』]+(?:\s*·\s*[^\s,.)」』]+)?/g,
    // 링크 속성 글자. 제목에 「<a href=…>」가 적혀 와도 메일 HTML에서 링크처럼 보이지 않게 지운다.
    /href\s*=/gi,
  ];
}

/**
 * 외부로 나가는 글을 보고용으로 바꾸는 **하나뿐인** 변환 함수(G L396 · L1052, Q-13 결정 A).
 * 메일 제목 · 본문(HTML · text/plain) · 보고용 화면 · 보고용 PDF가 모두 이 함수를 지난다.
 * - 내부 용어(Task ID · RP · 시도 · 모델 · Effort · 토큰)를 뺀다.
 * - 앱 링크 · 앱 안 경로 · 앱 메뉴 안내를 뺀다(linkPatterns).
 * 왜: 제목 · 이름은 팀장이 자유롭게 쓰므로 「TASK-0007 개선 http://127.0.0.1:5173/settings/report」처럼 섞일 수 있다.
 *   HTML의 `<a>`가 없어도 메일 앱은 글로 적힌 주소를 링크로 바꿔 준다.
 * 예: 「TASK-0007 RP-002 개선」 → 「개선」. 모두 지워져 빈 글이 되면 「(제목 비공개)」.
 */
export function externalText(text: string, appUrl?: string | null): string {
  const patterns = [...linkPatterns(appUrl), ...INTERNAL_TERMS];
  const cleaned = patterns.reduce((acc, re) => acc.replace(new RegExp(re.source, re.flags), ''), text).replace(/\s+/g, ' ').trim();
  return cleaned || '(제목 비공개)';
}
/** 옛 이름. externalText와 같은 함수다(앱 접속 주소를 모를 때). */
export const scrubInternal = (text: string): string => externalText(text);

/**
 * 외부로 나가는 글 검사기(Q-13 결정 A). 남은 내부 용어 · 앱 링크 · 앱 경로 · 메뉴 안내를 모두 돌려준다. 빈 목록이면 통과.
 * 시험과 발송 직전(메일 worker · 보고용 PDF 생성) 둘 다 이 함수를 쓴다.
 * HTML이면 `href=`도 찾는다(linkPatterns). 왜: 보이는 글자에 주소가 없어도 링크 태그가 남으면 누를 수 있다.
 */
export function externalLeaks(text: string, appUrl?: string | null): string[] {
  return [...linkPatterns(appUrl), ...INTERNAL_TERMS].flatMap((re) => text.match(new RegExp(re.source, re.flags)) ?? []);
}

/** 스냅샷이 계약(ReportSnapshot)에 맞는지. 맞지 않으면 첫 위반 위치를 돌려준다. */
export function snapshotProblem(value: unknown): string | null {
  if (Value.Check(ReportSnapshot, value)) return projectNameProblem(value);
  const first = [...Value.Errors(ReportSnapshot, value)][0];
  return `${first?.instancePath ?? ''} ${first?.message ?? ''}`.trim() || '형식 위반';
}

/**
 * 이름 출처와 이름이 맞는지(M6-02, Codex 리뷰 4차 P2-2). 형식 검사만으로는 표현하기 어려워 여기서 본다.
 * - snapshot(새 보고서): 이름이 빈 글이 아니어야 한다. 왜: 새 보고서는 생성할 때 이름을 반드시 기록한다.
 * - filled: 이름이 있어야 한다. unknown: 이름이 null이어야 한다.
 */
function projectNameProblem(s: ReportSnapshotData): string | null {
  if (s.projectNameStatus === 'unknown') return s.projectName === null ? null : '/projectName 이름 미상(unknown)이면 null이어야 합니다';
  if (s.projectName === null || (s.projectNameStatus === 'snapshot' && !s.projectName.trim())) return `/projectName ${s.projectNameStatus}이면 이름이 있어야 합니다`;
  return null;
}
