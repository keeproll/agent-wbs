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
/**
 * audience: 누가 읽는가(Q-13 fix4).
 * - 'internal'(기본): 팀장 화면 · 내부 수신자. 작업 제목에서 내부 용어만 뺀다(scrubInternal, M6-01 규칙 그대로).
 * - 'external': 외부 수신자. 주소 · 이메일까지 지우는 외부 변환(externalText)을 쓴다.
 * 왜 나누나: 외부 변환의 정보 손실(파일 이름 · 제품 이름 · 버전 번호 생략)은 외부 수신자 보호를 위한 것이다. 내부 사람에게는 필요 없다.
 */
export function externalView(s: ReportSnapshotData, kind: 'daily' | 'weekly' | 'custom', audience: 'internal' | 'external' = 'internal'): ExternalView {
  const title = audience === 'external' ? (t: string) => externalText(t) : scrubInternal;
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
    highlights: s.done.map((x) => title(x.title)),
    risks,
    plan: s.next.map((x) => `${title(x.title)} (${monthDay(x.start)} ~ ${monthDay(x.end)})`),
  };
}

/**
 * 보고용에 들어가면 안 되는 내부 용어(G L396: Task ID, 실행 시도, 모델 · Effort, 토큰, RP 번호)를 찾는다.
 * 보고용 문장·메일 본문 검사(M6-01·M6-03)가 함께 쓴다.
 */
const INTERNAL_TERMS: readonly RegExp[] = [
  // 번호 셋은 대소문자를 가리지 않는다(Q-13 fix4). 왜: `task-0007`처럼 적어도 같은 작업 번호라는 정보가 전달된다.
  /TASK-\d{4,}/gi, /RP-\d{3,}/gi, /ATT-\d{4,}-\d+/gi, /\bclaude-[a-z0-9.-]+/gi, /\bgpt-[a-z0-9.-]+/gi, /Effort/gi, /토큰/g, /\btokens?\b/gi, /실행 시도/g,
];
export function internalTerms(text: string): string[] {
  return INTERNAL_TERMS.flatMap((re) => text.match(re) ?? []);
}

/**
 * 앱 화면의 첫 경로(apps/web 메뉴 · 로그인 · API). 경로 모양 규칙이 이 경로들을 모두 잡는지 시험이 확인한다.
 * 메뉴를 늘리면 여기에도 더한다(web 시험이 메뉴와 같은지 확인한다).
 */
export const APP_PATHS = ['dashboard', 'project', 'wbs', 'design', 'planning', 'exec', 'verify', 'ci', 'change', 'history', 'report', 'settings', 'api', 'login'] as const;

/** 외부 글에서 주소를 지운 자리에 넣는 말(Q-13 fix2) */
export const LINK_OMITTED = '(링크 생략)';
/** 외부 글에서 이메일 주소를 지운 자리에 넣는 말(Q-13 fix4) */
export const EMAIL_OMITTED = '(주소 생략)';
/**
 * **마지막 규칙**(Q-13 fix5 · 후속). 정규화한 글을 공백으로 나눈 토큰 가운데 아래에 해당하면 통째로 「(주소 생략)」이다.
 * (a) `@`가 있다(이메일 · 따옴표 이메일).
 * (b) 점(`.`)이 두 글자 사이에 있고, 그 바로 앞이나 바로 뒤가 **글자**(숫자 · 공백 · 문장부호 · 기호가 아닌 것 — \p{L} 글자와 \p{M} 결합 문자 포함)다(`wbs.corp.example`, `내부.xn--…`, `कंपनी.example`, `file.txt`).
 * (c) 숫자만 점으로 4덩이 이상 이어진다(IPv4 모양, `10.0.0.1`).
 * 숫자 사이 점(`2.5일`, `1.2.3`, `12.34%`)은 유지한다. 왜: 기간 · 수치 · 버전은 보고 내용 자체다.
 * 내부 호스트는 이름이 글자로 끝나므로(최상위 이름은 숫자만일 수 없다) 점 옆에 늘 글자가 있어 (b)에 걸린다. 숫자뿐인 호스트는 (c)가 잡는다.
 * 문장 끝 점(「완료했습니다.」, 「전.)」)은 두 글자 · 숫자 사이가 아니라 해당하지 않는다.
 * 정보 손실(조정자 판단으로 수용): 점으로 이은 단어(「프로젝트.완료」, `e.g.`) · 파일 이름(`file.txt`) · 제품 이름(`Node.js`)은 생략된다.
 */
/**
 * 점 옆 글자 분류(Q-13 fix5 후속 2, Codex 재리뷰 6).
 * - WORD: 공백도 문장부호(\p{P})도 기호(\p{S})도 아닌 글자. 점은 두 WORD 사이에 있을 때만 본다(문장 끝 점 · 「전.)」 제외).
 * - LETTERISH: WORD 가운데 십진 숫자(\p{Nd})가 아닌 것. 글자(\p{L})와 결합 문자(\p{M})를 모두 포함한다.
 *   왜 결합 문자까지: 「कंपनी」의 모음 기호(U+0940)나 「a̸」의 덧붙는 획(U+0338)처럼, 한 글자로 보이는 이름의 끝이 결합 문자일 수 있다.
 *   글자 · 결합 문자만 나열하지 않고 「숫자 · 공백 · 문장부호 · 기호가 아닌 것」으로 정의해 같은 부류의 빠짐을 막는다(시험이 무작위 유니코드로 교차 확인).
 */
const WORD = String.raw`[^\s\p{P}\p{S}]`;
const LETTERISH = String.raw`[^\s\p{P}\p{S}\p{Nd}]`;
const LETTER_DOT = new RegExp(`${LETTERISH}\\.${WORD}|${WORD}\\.${LETTERISH}`, 'u');
/** 주소 토큰인지(변환 · 검사기 · 시험이 같은 함수를 쓴다). */
export function isAddressToken(token: string): boolean {
  if (token.includes('@')) return true;
  if (LETTER_DOT.test(token)) return true;
  return /(?<![\d.])\d+(?:\.\d+){3,}/.test(token);
}
/** 토큰 규칙을 적용한다. 공백은 그대로 두고 해당 토큰만 바꾼다. */
const omitAddressTokens = (text: string) => text.split(/(\s+)/).map((part) => (/\s/.test(part) || !isAddressToken(part) ? part : EMAIL_OMITTED)).join('');
/** 검사기용: 토큰 규칙에 걸리는 토큰 목록 */
const addressTokens = (text: string) => text.split(/\s+/).filter((part) => part && isAddressToken(part));
/** 주소 조각이 끝나는 글자(공백 · 따옴표 · 괄호 · 꺾쇠) */
const TAIL = String.raw`[^\s<>"'()[\]{}「」『』]*`;
/**
 * **주소처럼 보이는 것**의 모양(Q-13 fix2). 어느 서버를 가리키는지 따지지 않고 모양만 본다.
 * 왜: 결정 A는 「외부 수신자에게는 링크 없이」다. 같은 주소를 여러 글자로 적을 수 있어(`127.1`, `2130706433`, `%77bs…`)
 *   「우리 앱 주소인가」를 가려내려 하면 빠짐이 생긴다. 그래서 일반 외부 주소도 예외 없이 지운다.
 * - 스킴이 있는 주소: `http://…`, `https://…`, `ftp://…`, `//…`
 * - `www.`로 시작하는 주소
 * - 대괄호 IPv6: `[::1]`, `[0:0:…:1]:5173`
 * - 숫자 IP(숫자 세 덩이 이상 = 점 둘 이상): `127.0.0.1`, `10.0.0.5/x`. 버전 번호 `1.2.3`도 여기에 걸려 생략된다(정보 손실, 조정자 판단으로 받아들임)
 * - 호스트:포트: `localhost:5173`, `127.1:5173`, `wbs.corp.example:443`, `2130706433:5173`
 * - 호스트/경로: `wbs.corp.example/report/1`, `example.org/spec`
 * - 경로형: 공백 · 괄호 뒤의 `/report/abc`, `/settings`(「A/B」, 「0 / 0」은 아니다)
 * - 맨 호스트: `wbs.corp.example`, `intranet.local`, `file.txt`(파일 이름도 지워진다 — 정보 손실 수용)
 * 메일 주소(`name@example.com`)는 주소 모양에 넣지 않는다. 왜: 받는 사람 자신의 주소를 바닥글에 보이고, 링크가 아니다.
 */
const ADDRESS: readonly RegExp[] = [
  new RegExp(String.raw`\b[a-z][a-z0-9+.-]*:\/\/${TAIL}`, 'gi'),
  new RegExp(String.raw`(?<![\w:/])\/\/[^\s/]${TAIL}`, 'gi'),
  new RegExp(String.raw`\[[0-9a-f.%]*:[0-9a-f:.%]*\](?::\d{1,5})?${TAIL}`, 'gi'),
  new RegExp(String.raw`(?<![\w.-])(?:[a-z][\w-]*(?:\.[\w-]+)*|\d[\w-]*(?:\.[\w-]+)+|\d{3,}):\d{1,5}(?![\d:])(?:\/${TAIL})?`, 'gi'),
  // `<` 뒤는 경로가 아니라 닫는 태그 모양(`</b>`)이다. 글자로 바뀌어 보일 뿐 링크가 되지 않는다.
  new RegExp(String.raw`(?<![\w.:/~<-])\/[a-z0-9_.~%-]+(?:\/${TAIL})?`, 'gi'),
];
/** 주소는 아니지만 외부 글에 남기지 않는 것: 앱 메뉴 안내(「설정 → 알림」)와 링크 속성 글자(`href=`) */
const APP_HINTS: readonly RegExp[] = [
  /설정\s*→\s*[^\s,.)」』]+(?:\s*·\s*[^\s,.)」』]+)?/g,
  /href\s*=/gi,
  // 메일 헤더 인코딩 문법(`=?UTF-8?B?…?=`). 글에 적혀 있으면 메일 앱이 풀어서 다른 글로 보일 수 있다.
  /=\?[^?\s]*\?[bq]\?[^?\s]*\?=/gi,
];

/** 이름 있는 HTML 글자 기호 중 주소에 쓰일 수 있는 것과 흔한 것(나머지는 숫자 기호 `&#46;`로 온다) */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', period: '.', sol: '/', colon: ':', commat: '@', percnt: '%', num: '#', quest: '?', equals: '=', lowbar: '_', hyphen: '-', dash: '-',
};
/** 폭이 없는 글자 · 방향 제어 글자 · 줄 바꿈 가능 표시(보이지 않지만 주소 사이에 끼워 넣을 수 있다) */
// 결합 문자(이음 표시 · 변형 선택자)는 글자 묶음 안에 두면 앞 글자와 붙어 보이므로 따로 나열한다.
const INVISIBLE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F]|\\u00AD|\\u061C|\\u115F|\\u1160|\\u17B4|\\u17B5|\\u3164|\\uFEFF|\\uFFA0|\\u034F|\\u180B|\\u180C|\\u180D|\\u180E|\\u180F|\\uFE00|\\uFE01|\\uFE02|\\uFE03|\\uFE04|\\uFE05|\\uFE06|\\uFE07|\\uFE08|\\uFE09|\\uFE0A|\\uFE0B|\\uFE0C|\\uFE0D|\\uFE0E|\\uFE0F', 'g');
/** 점으로 읽히는 글자(NFKC 뒤에도 남는 것): 。 ｡ ︒ ﹒ ․ 등 */
const DOTS = new RegExp('[\\u3002\\uFF61\\uFE12\\uFE52\\u2024\\uFF0E\\u0701\\u0702\\u2E33\\u2E3C]', 'g');

/**
 * 외부 글 정규화(Q-13 fix3). 주소 모양을 판정하기 **전에** 글을 한 가지 표기로 모은다. 변환 함수와 검사기가 같은 결과를 쓴다.
 * 1. HTML 글자 기호를 푼다(`&#46;` → `.`, `&period;` → `.`).
 * 2. 퍼센트 인코딩을 푼다(`%2E` → `.`). 풀 수 없는 조각(「10%」)은 그대로 둔다.
 * 3. NFKC(호환 글자를 기본 글자로: 전각 `．` → `.`, 전각 영문 → 영문).
 * 4. 남은 점류(。 ｡ 등)를 `.`으로, 폭 없는 글자 · 방향 제어 글자를 지운다.
 * 두 번 인코딩한 글(`%252E`)도 풀리도록 결과가 더 바뀌지 않을 때까지(최대 4번) 되풀이한다.
 * 왜: 같은 주소를 여러 글자로 적을 수 있다(`192。168。0。10`, `wbs%2Ecorp%2Eexample`). 모양 규칙을 늘리지 않고 표기를 하나로 모은 뒤 판정한다.
 * 출력에는 정규화한 글을 쓴다. 예: 「프로젝트。완료」는 「프로젝트.완료」로 나간다.
 */
export function normalizeExternal(text: string): string {
  let current = text;
  for (let round = 0; round < 4; round++) {
    const next = current
      .replace(/&#(\d{1,7});?/g, (m, n: string) => { const c = Number(n); return c > 0 && c <= 0x10FFFF ? String.fromCodePoint(c) : m; })
      .replace(/&#x([0-9a-f]{1,6});?/gi, (m, n: string) => { const c = parseInt(n, 16); return c > 0 && c <= 0x10FFFF ? String.fromCodePoint(c) : m; })
      .replace(/&([a-z]+);/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
      .replace(/(?:%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } })
      .normalize('NFKC')
      .replace(DOTS, '.')
      .replace(INVISIBLE, '');
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * 외부로 나가는 글을 보고용으로 바꾸는 **하나뿐인** 변환 함수(G L396 · L1052, Q-13 결정 A · fix1 · fix2 · fix3).
 * 메일 헤더(제목 등) · 본문(HTML · text/plain) · 보고용 화면 · 보고용 PDF가 모두 이 함수를 지난다.
 * 1. 정규화한다(normalizeExternal). 이후 단계와 **출력**은 모두 정규화한 글을 쓴다.
 * 2. 주소처럼 보이는 것(ADDRESS)을 통째로 「(링크 생략)」으로 바꾼다. 일반 외부 주소도 예외가 없다.
 * 3. 내부 용어(Task ID · RP · 시도 · 모델 · Effort · 토큰)와 앱 메뉴 안내 · `href=` · 메일 헤더 인코딩 문법(`=?…?=`)을 뺀다.
 * 왜: 제목 · 이름은 자유 입력이다. 메일 앱은 글로 적힌 주소도 링크로 바꿔 준다.
 * 예: 「TASK-0007 개선 http://127.1:5173/report/abc」 → 「개선 (링크 생략)」. 모두 지워져 빈 글이 되면 「(제목 비공개)」.
 * appUrl은 판별에 쓰지 않는다(모든 주소 모양을 지운다). 호출하는 쪽과의 호환을 위해 받기만 한다.
 */
export function externalText(text: string, appUrl?: string | null): string {
  void appUrl;
  // 스킴 주소 · 호스트:포트 · 경로처럼 점이 없어도 링크인 것은 「(링크 생략)」, 그 밖의 주소 모양은 마지막 토큰 규칙이 「(주소 생략)」으로 바꾼다.
  const linked = ADDRESS.reduce((acc, re) => acc.replace(new RegExp(re.source, re.flags), ` ${LINK_OMITTED} `), normalizeExternal(text));
  const cleaned = [...APP_HINTS, ...INTERNAL_TERMS].reduce((acc, re) => acc.replace(new RegExp(re.source, re.flags), ''), omitAddressTokens(linked))
    .replace(/\s+/g, ' ').replace(/(\(링크 생략\)\s*)+/g, `${LINK_OMITTED} `).replace(/(\(주소 생략\)\s*)+/g, `${EMAIL_OMITTED} `).trim();
  return cleaned || '(제목 비공개)';
}
/**
 * 외부로 나가는 글 검사기(Q-13 결정 A · fix2 · fix3). 변환 함수와 **같은 기준**(정규화 뒤 같은 모양 규칙)으로
 * 남은 주소 모양 · 내부 용어 · 메뉴 안내 · `href=` · 헤더 인코딩 문법을 모두 돌려준다. 빈 목록이면 통과(「주소 모양 0건」).
 * 시험과 발송 직전(메일 worker · 보고용 PDF 생성 · SMTP 설정 저장) 모두 이 함수를 쓴다.
 * 글자(text/plain · 제목 · 헤더)에 쓴다. HTML은 externalHtmlLeaks로 보이는 글과 링크 태그를 함께 본다.
 */
export function externalLeaks(text: string, appUrl?: string | null): string[] {
  void appUrl;
  const normal = normalizeExternal(text);
  return [...addressTokens(normal), ...[...ADDRESS, ...APP_HINTS, ...INTERNAL_TERMS].flatMap((re) => normal.match(new RegExp(re.source, re.flags)) ?? [])];
}
/** HTML에서 보이는 글만(스타일 · 스크립트 · 제목 태그 · 태그를 뺀다). 글자 기호 풀기는 검사기의 정규화가 맡는다. */
export function htmlVisibleText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<title[\s\S]*?<\/title>/gi, ' ').replace(/<[^>]+>/g, ' ');
}
/** HTML 검사: 링크가 되는 태그 · 속성(`<a`, `href=`, `src=http…`)과 보이는 글 · 문서 제목의 externalLeaks. 빈 목록이면 통과 */
export function externalHtmlLeaks(html: string): string[] {
  const tags = html.match(/<a\b|<area\b|<base\b|\bhref\s*=|\bsrc\s*=\s*["']?(?:https?:|\/\/)/gi) ?? [];
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  return [...tags, ...externalLeaks(title), ...externalLeaks(htmlVisibleText(html))];
}

/**
 * 보내는 사람 설정(`이름 <주소>` 또는 `주소`)을 **허용 목록**으로 읽는다(Q-13 fix3, Codex 재리뷰 3-1).
 * - 이름: 한글 · 영문 · 숫자 · 공백 · 하이픈만, 40자 이하, 내부 용어 0건. 따옴표 · 괄호 · `=?…?=` · 줄바꿈 같은 그 밖의 글자는 모두 거부한다.
 * - 주소: 평범한 메일 주소(`name@example.com`) 하나.
 * 맞지 않으면 null(해석할 수 없는 이름을 빈 이름으로 통과시키지 않는다).
 * 왜 허용 목록인가: 메일 생성기는 인코딩(`=?UTF-8?B?…?=`) · 주석(`(…)`) · 따옴표 · 줄바꿈을 여러 방식으로 읽는다.
 *   그 해석을 따라가며 검사하기보다, 그런 문법이 될 수 있는 글자를 처음부터 받지 않는다. 헤더는 이 결과(이름 · 주소)로 우리가 만든다.
 */
export const SENDER_NAME_MAX = 40;
export function parseSender(from: string): { name: string; address: string } | null {
  // 제어 글자(줄바꿈 · 탭 등)가 하나라도 있으면 거부한다. 헤더 줄을 나누거나 이어 붙이는 데 쓰일 수 있다.
  if ([...from].some((ch) => { const c = ch.codePointAt(0) ?? 0; return c < 0x20 || c === 0x7f; })) return null;
  const angle = /^([^<>]*)<([^<>]+)>$/.exec(from.trim());
  const name = (angle ? angle[1] ?? '' : '').trim();
  const address = (angle ? angle[2] ?? '' : from).trim();
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(address)) return null;
  if (angle && !name) return null;
  if (name && !(new RegExp(`^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 -]{1,${String(SENDER_NAME_MAX)}}$`).test(name) && externalLeaks(name).length === 0)) return null;
  return { name, address };
}
/**
 * 내부 사람이 읽는 보고용(팀장 화면 · 내부 수신자 메일 · 내부 보고용 PDF)에서 자유 입력의 내부 용어만 뺀다(G L396, 리뷰 M6-01 3).
 * 외부 변환(externalText)과 달리 주소 · 파일 이름은 그대로 둔다(Q-13 fix4: 외부 변환은 외부 수신자에게만).
 * 예: 「TASK-0007 RP-002 개선」 → 「개선」. 모두 지워져 빈 글이 되면 「(제목 비공개)」.
 */
export function scrubInternal(text: string): string {
  const cleaned = INTERNAL_TERMS.reduce((acc, re) => acc.replace(new RegExp(re.source, re.flags), ''), text).replace(/\s+/g, ' ').trim();
  return cleaned || '(제목 비공개)';
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
