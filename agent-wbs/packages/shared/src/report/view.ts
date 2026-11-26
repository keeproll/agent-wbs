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
import { daysBetween } from './period.ts';

export type ReportSnapshotData = Static<typeof ReportSnapshot>;
/** 스냅샷 저장 전 검사(data-model §1: jsonb는 쓰기 시 TypeBox 검증)에 쓰는 계약 스키마. */
export { ReportSnapshot as ReportSnapshotSchema };
export interface Kpi { label: string; value: string; sub: string }

/** `2026-11-10` → `11-10`. 없으면 `—` */
export const monthDay = (day: string | null): string => (day ? day.slice(5) : '—');
const fullDay = (day: string | null): string => day ?? '—';

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
  return [
    { label: '완료 (기간)', value: `${String(f.doneInPeriod)}건`, sub: `누적 ${String(f.doneTotal)} / ${String(f.taskCount)}건` },
    { label: '작업량 기준 완료율', value: pctText(f.workPct), sub: `기간 시작 ${pctText(f.workPctBefore)}` },
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
export function externalView(s: ReportSnapshotData, kind: 'daily' | 'weekly' | 'custom'): ExternalView {
  const f = reportFigures(s);
  const delta = forecastDeltaLabel(f.forecastDeltaDays);
  const slack = f.slackDays;
  const target = fullDay(f.target);
  const summary = [
    `기간 중 ${String(f.doneInPeriod)}건 완료, 누적 ${String(f.doneTotal)} / ${String(f.taskCount)}건 (작업량 기준 ${pctText(f.workPct)}${f.workPct !== f.workPctBefore ? `, 기간 시작 ${pctText(f.workPctBefore)}` : ''}).`,
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
  if (!risks.length) risks.push('특이 위험 없음');
  return {
    kpis: [
      { label: '완료', value: `${String(f.doneInPeriod)}건`, sub: `누적 ${String(f.doneTotal)} / ${String(f.taskCount)}건` },
      { label: '진척률 (작업량)', value: pctText(f.workPct), sub: `기간 시작 ${pctText(f.workPctBefore)}` },
      { label: '완료 예상일', value: fullDay(f.forecast), sub: `범위 ${monthDay(f.lo)} ~ ${monthDay(f.hi)}` },
      { label: '목표일 대비', value: slack === null ? '—' : slack >= 0 ? `여유 ${String(slack)}일` : `${String(-slack)}일 초과`, sub: `목표 ${target}` },
    ],
    summary,
    // 일간은 추이를 보이지 않는다(P isWeekly L6413).
    trend: kind === 'daily' ? [] : s.series.map((x) => ({ day: x.day, uptimePct: x.uptimePct, done: x.done, forecast: x.forecast })),
    highlights: s.done.map((x) => x.title),
    risks,
    plan: s.next.map((x) => `${x.title} (${monthDay(x.start)} ~ ${monthDay(x.end)})`),
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

/** 스냅샷이 계약(ReportSnapshot)에 맞는지. 맞지 않으면 첫 위반 위치를 돌려준다. */
export function snapshotProblem(value: unknown): string | null {
  if (Value.Check(ReportSnapshot, value)) return null;
  const first = [...Value.Errors(ReportSnapshot, value)][0];
  return `${first?.instancePath ?? ''} ${first?.message ?? ''}`.trim() || '형식 위반';
}
