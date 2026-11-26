/**
 * 보고서 PDF용 HTML. 화면(apps/web/src/features/report/ReportPage.tsx `ReportDocument`)의 `<article class="rpt-doc">`와
 * **같은 마크업·같은 클래스·같은 CSS**(apps/web/src/shared/styles/prototype.css)로 만든다(G L410).
 *
 * 화면과 다른 점은 세 가지뿐이다. 모두 원본 인쇄 경로(P printReport L5000–5012)와 같다.
 * - 보기 전환·PDF 버튼 줄(`rp-bar`)과 「생성 이후 변경」 안내(`rp-noprint`)는 넣지 않는다. 인쇄물에 없는 화면 조작이기 때문이다.
 * - Task 링크(`reflink`)는 글자만 남긴다. PDF에서는 링크로 Task 상세를 열 수 없다(G L379).
 * - 원본 인쇄 CSS(`html,body{background:#fff}…@page{size:A4;margin:14mm}`)를 덧붙인다.
 *
 * 모든 값은 HTML 특수 문자를 바꿔 넣는다(`esc`). 왜: 제목·메시지에 `<script>` 같은 글자가 있어도 글자로만 보이게 한다.
 */
import { readFileSync } from 'node:fs';
import type { ReportSnapshotData } from '@awbs/shared';
import {
  byLabel, docTitle, externalDoc, formatDateTime, internalDoc, KIND, lateLabel, periodLabel, snapLabel, type ReportHead, type ReportView,
} from './model.ts';

/** 글꼴 굵기별 파일. 이 주소는 렌더러(render.ts)가 패키지 파일로 응답한다. */
export const FONT_FILES = { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold' } as const;

const esc = (value: string | number) => String(value).replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
/** 태그 이름·속성은 이 파일이 정한 고정값이다. 바깥 값은 children(이미 esc 처리)으로만 들어온다. */
const el = (tag: string, attrs: string, ...children: string[]) => `<${tag}${attrs ? ` ${attrs}` : ''}>${children.join('')}</${tag}>`;
const span = (cls: string, text: string | number, style = '') => el('span', `${cls ? `class="${cls}"` : ''}${style ? ` style="${style}"` : ''}`, esc(text));
const plain = (text: string | number) => el('span', '', esc(text));
const cell = (cls: string, ...children: string[]) => el('span', `${cls ? `class="${cls}" ` : ''}role="cell"`, ...children);
const head = (cls: string, cols: readonly string[]) => el('div', `class="${cls}" role="row"`, ...cols.map((c) => el('span', 'role="columnheader"', esc(c))));
const empty = (show: boolean, text: string) => (show ? el('p', 'class="muted"', esc(text)) : '');
const sec = (title: string, ...children: string[]) => el('section', 'class="rpt-sec"', el('h3', '', esc(title)), ...children);
const task = (key: string) => span('reflink', key);
const kv = (pairs: [string, string][]) => el('div', 'class="rpt-kv"', ...pairs.flatMap(([k, v]) => [plain(k), v]));
const bar = (cls: string, height: number) => `<span class="rpt-b ${cls}" style="height:${String(height)}px"></span>`;

function kpis(items: { label: string; value: string; sub: string }[]) {
  return el('div', 'class="rpt-kpis"', ...items.map((k) => el('div', 'class="rpt-kpi"', span('rpt-kl', k.label), el('b', 'class="rpt-kv"', esc(k.value)), span('rpt-ks', k.sub))));
}

/** 팀장용(UI-11B, P L2147–2224) — ReportPage.tsx InternalView와 같은 순서·마크업 */
function internal(s: ReportSnapshotData, kind: ReportHead['kind'], weekly: boolean) {
  const x = internalDoc(s);
  return [
    kpis(x.kpis),
    sec('팀장 확인 필요', empty(!x.issues.length, '확인할 항목이 없습니다.'), ...x.issues.map((i) => el('div', 'class="rpt-li"', span(i.cls, i.label), plain(i.text)))),
    weekly ? sec('일별 추세', el('div', 'class="rpt-trend" role="table" aria-label="일별 추세"',
      head('rpt-tr h', ['날짜', '가동률', '실행 시도', '완료', 'QA FAIL', '완료 예상']),
      ...x.series.map((d) => el('div', 'class="rpt-tr" role="row"',
        cell('mono', esc(d.day)), cell('rpt-bc', bar('up', d.upBar), span('mono', d.up)), cell('rpt-bc', bar('at', d.aBar), span('mono', d.atts)),
        cell('mono', esc(d.done)), cell('mono', esc(d.fails)), cell('mono', esc(d.fc)))))) : '',
    el('p', 'class="rpt-note"', esc(`현재 상태 분포 — ${x.statusLine}`)),
    sec('1. 완료한 Task', empty(!x.done.length, '기간 중 완료한 Task가 없습니다.'), ...x.done.map((t) => el('div', 'class="rpt-card"',
      el('div', 'class="rpt-ch"', span('sc sc-ok', '완료'), task(t.id), span('mono muted', t.wbs), el('b', '', esc(t.title)), span('muted', t.cls, 'margin-left:auto')),
      kv([['담당', plain(t.who)], ['실제 기간', span('mono', t.act)], ['작업량', plain(t.est)], ['기준 대비', plain(t.slip)],
        ['최종 검증', plain(t.verif)], ['체크리스트', plain(t.cl)], ['산출물', plain(t.out)], ['완료 조건', plain(t.cond)]])))),
    sec('2. 진행 중 · 확인 필요 Task', empty(!x.active.length, '진행 중인 Task가 없습니다.'), ...x.active.map((t) => el('div', 'class="rpt-card"',
      el('div', 'class="rpt-ch"', span('tag', t.st), task(t.id), span('mono muted', t.wbs), el('b', '', esc(t.title)), span('muted', `${t.cls} · 진행률 ${t.pct}`, 'margin-left:auto')),
      kv([['담당', plain(t.who)], ['실제 시작', span('mono', t.start)],
        ['완료 예상', el('span', '', span('mono', t.fc), esc(` · ${t.slip} · 남은 작업량 ${t.remain}`))],
        ['최근 실행', plain(t.last)], ['검증', plain(t.verif)], ['체크리스트', plain(t.cl)],
        ['Completion Gate', plain(t.gate)], ['이슈', plain(t.issue)], ['다음 작업', el('span', '', el('b', '', esc(t.next)))]])))),
    x.failures.length ? sec('3. QA 실패 · 결함 상세', ...x.failures.map((f) => el('div', 'class="rpt-card bad"',
      el('div', 'class="rpt-ch"', span('sc sc-bad', 'FAIL'), task(f.task), el('b', '', esc(f.title)), span('mono muted', `${f.agent} · ${f.at}`, 'margin-left:auto')),
      kv([['검증 명령', span('mono', f.cmd)], ['기대 결과', plain(f.exp)], ['실제 결과', plain(f.act)],
        ['결함', plain(f.defects)], ['Evidence', span('mono', f.ev)], ['후속 조치', plain(f.follow)]])))) : '',
    sec('4. 실행 기록', el('p', '', esc(x.execLine)), empty(!x.attempts.length, '기간 중 실행 시도가 없습니다.'),
      x.attempts.length ? el('div', 'class="rpt-tbl" role="table" aria-label="실행 기록"',
        head('rpt-trw h at', ['시도', 'Task · 종류', 'Agent · 등급', '시간', '결과', '요약', '파일 · 토큰']),
        ...x.attempts.map((a) => el('div', 'class="rpt-trw at" role="row"',
          cell('mono', esc(a.id)), cell('', esc(a.task)), cell('', esc(a.grade)), cell('mono', esc(a.time)), cell('', esc(a.st)),
          cell('', esc(a.sum), a.esc ? `<br>${span('muted', `등급 조정: ${a.esc}`)}` : ''), cell('mono', esc(`${a.files} · ${a.tok}`))))) : ''),
    sec('5. 일정 재조정', empty(!x.replans.length, '기간 중 재조정이 없습니다.'), ...x.replans.map((r) => el('div', 'class="rpt-card"',
      el('div', 'class="rpt-ch"', span('mono', r.id), span('mono muted', r.at), el('b', '', esc(r.trigger)), span('mono', `완료 예상 ${r.ch} (범위 ${r.range})`, 'margin-left:auto')),
      r.moved.length ? el('div', 'class="rpt-moved"', ...r.moved.map((m) => el('div', '', span('mono', m.task), esc(` ${m.title} — ${m.kind} `), span('mono', m.ch)))) : ''))),
    sec('6. 작업 환경 중단', empty(!x.gaps.length, '기간 중 중단이 없습니다.'),
      ...x.gaps.map((g) => el('div', 'class="rpt-li"', span('mono', `${g.from} ~ ${g.to}`), span('mono', g.dur), plain(g.reason)))),
    sec('7. 팀장 지시 · Runner 응답', empty(!x.messages.length, '기간 중 메시지가 없습니다.'),
      ...x.messages.map((m) => el('div', 'class="rpt-li"', span('mono muted', m.at), span('mono', m.task), plain(m.dir), span('tag', m.type), span('muted', m.st), span('', m.body, 'flex-basis:100%')))),
    sec(`8. ${kind === 'daily' ? '다음 날 예정' : '다음 주 예정'}`, empty(!x.next.length, '예정된 Task가 없습니다.'),
      x.next.length ? el('div', 'class="rpt-tbl" role="table" aria-label="예정"',
        head('rpt-trw h nx', ['Task', '제목', '상태', '예상 기간', '담당 · 등급', '선행 조건 · 충돌 묶음']),
        ...x.next.map((t) => el('div', 'class="rpt-trw nx" role="row"',
          cell('', task(t.id)), cell('', esc(`${t.title} `), span('muted', `(${t.est})`)), cell('', esc(t.st)), cell('mono', esc(t.per)),
          cell('', esc(t.who), '<br>', span('muted', t.grade)), cell('', esc(t.pre), '<br>', span('muted', t.cg))))) : ''),
    el('section', 'class="rpt-sec rpt-appx"', el('h3', '', esc('부록. 전체 Task 현황 (보고서 생성 시점)')), empty(!x.all.length, 'Task가 없습니다.'),
      el('div', 'class="rpt-tbl" role="table" aria-label="전체 Task 현황"',
        head('rpt-trw h al', ['WBS', 'Task', '제목', '상태', '개발/검증', '진행률', '체크리스트', '검증', '완료 예상', '기준 대비']),
        ...x.all.map((t) => el('div', 'class="rpt-trw al" role="row"',
          cell('mono', esc(t.wbs)), cell('', task(t.id)), cell('', esc(`${t.title} `), t.blocked ? span('sc sc-bad', '차단') : ''),
          cell('', esc(t.st)), cell('', esc(t.who)), cell('mono', esc(t.pct)), cell('mono', esc(t.cl)), cell('', esc(t.verif)), cell('mono', esc(t.fc)), cell('mono', esc(t.slip)))))),
  ].join('');
}

/** 보고용(UI-11C, P L2228–2242) — ReportPage.tsx ExternalSections와 같은 순서·마크업 */
function external(s: ReportSnapshotData, kind: ReportHead['kind'], weekly: boolean) {
  const e = externalDoc(s, kind);
  const list = (items: string[]) => el('ul', 'class="rpt-ul"', ...items.map((t) => el('li', '', esc(t))));
  return [
    kpis(e.kpis),
    sec('요약', list(e.summary)),
    weekly ? sec('주간 추이', el('div', 'class="rpt-trend" role="table" aria-label="주간 추이"',
      head('rpt-tr h ext', ['날짜', '작업 환경 가동', '완료', '완료 예상일']),
      ...e.trendRows.map((d) => el('div', 'class="rpt-tr ext" role="row"',
        cell('mono', esc(d.day)), cell('rpt-bc', bar('up', d.upBar), span('mono', d.up)), cell('mono', esc(d.done)), cell('mono', esc(d.fc)))))) : '',
    sec('주요 완료 항목', empty(!e.highlights.length, '기간 중 완료 항목이 없습니다.'), list(e.highlights)),
    sec('위험 · 이슈', list(e.risks)),
    sec('다음 계획', empty(!e.plan.length, '예정 항목이 없습니다.'), list(e.plan)),
  ].join('');
}

/** 화면 CSS 원본. 웹과 같은 파일을 읽는다(복사하지 않는다). 서버가 떠 있는 동안 한 번만 읽는다. */
let styles: string | undefined;
const prototypeCss = () => (styles ??= readFileSync(new URL('../../../web/src/shared/styles/prototype.css', import.meta.url), 'utf8'));

/**
 * 글꼴: Pretendard GOV 1.3.9(G§9.7). 화면과 같은 글꼴 이름을 쓰되 PDF에는 **굵기별 고정 글꼴 파일**을 넣는다.
 * 왜: 화면의 가변 글꼴(Variable)은 Chromium PDF에서 굵기가 바뀐 글자를 그림 글자(Type3)로 바꿔 넣는다.
 * 그림 글자는 글꼴 파일이 아니라서 「폰트 embed」가 아니고, 글자 복사·검색 품질도 떨어진다.
 */
const fontFaces = () => Object.entries(FONT_FILES).map(([weight, name]) =>
  `@font-face{font-family:'Pretendard GOV Variable';font-weight:${weight};font-style:normal;font-display:block;src:url('/fonts/PretendardGOV-${name}.woff2') format('woff2')}`).join('');

/** 원본 인쇄 경로(P L5005)가 문서에 덧붙인 CSS 그대로 */
const PRINT_CSS = 'html,body{background:#fff;margin:0}.rpt-doc{border:0;max-width:none;padding:0}.reflink{color:inherit;text-decoration:none;border:0;background:none;padding:0;font:inherit}@page{size:A4;margin:14mm}';

export interface ReportHtmlInput extends ReportHead { projectName: string; view: ReportView; snapshot: ReportSnapshotData }

export function reportHtml(r: ReportHtmlInput): string {
  const late = lateLabel(r);
  const weekly = r.kind !== 'daily' && r.snapshot.series.length > 1;
  const article = el('article', `class="rpt-doc" aria-label="${esc(`${r.reportKey} 보고서`)}"`,
    el('header', 'class="rpt-h"',
      el('div', 'class="rpt-kind"', esc(KIND[r.kind].doc)),
      el('h2', '', esc(docTitle(r.projectName, r.kind, r.view))),
      el('div', 'class="rpt-meta"',
        el('span', '', esc('기간 '), el('b', 'class="mono"', esc(periodLabel(r)))),
        el('span', '', esc('생성 '), span('mono', formatDateTime(r.generatedAt)), esc(` · ${byLabel(r.kind)}`)),
        span('mono', r.reportKey)),
      el('p', 'class="rpt-snap"', esc(`${snapLabel(r.generatedAt)}${late ? ` · ${late}` : ''}`))),
    r.view === 'int' ? internal(r.snapshot, r.kind, weekly) : external(r.snapshot, r.kind, weekly),
    el('footer', 'class="rpt-f"', esc(`Agent WBS 자동 생성 · ${r.reportKey} · ${formatDateTime(r.generatedAt)}`)));
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(`${r.reportKey}_${r.view === 'int' ? '팀장용' : '보고용'}`)}</title>`
    + `<style>${fontFaces()}</style><style>${prototypeCss()}</style><style>${PRINT_CSS}</style></head><body>${article}</body></html>`;
}
