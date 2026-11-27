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
import { reportProjectName, type ReportSnapshotData } from '@awbs/shared';
import {
  byLabel, docTitle, externalDoc, formatDateTime, internalDoc, KIND, lateLabel, periodLabel, snapLabel, type ReportHead, type ReportView,
} from './model.ts';
import { FONT_FILES, pdfAssets } from './assets.ts';

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

/** 화면 CSS. 웹과 같은 파일이다(빌드 산출물에서는 빌드가 복사한 것, assets.ts). */
const prototypeCss = () => pdfAssets().css;

/**
 * 글꼴: Pretendard GOV 1.3.9(G§9.7). 화면과 같은 글꼴 이름을 쓰되 PDF에는 **굵기별 고정 글꼴 파일**을 넣는다.
 * 왜: 화면의 가변 글꼴(Variable)은 Chromium PDF에서 굵기가 바뀐 글자를 그림 글자(Type3)로 바꿔 넣는다.
 * 그림 글자는 글꼴 파일이 아니라서 「폰트 embed」가 아니고, 글자 복사·검색 품질도 떨어진다.
 */
const fontFaces = () => Object.entries(FONT_FILES).map(([weight, name]) =>
  `@font-face{font-family:'Pretendard GOV Variable';font-weight:${weight};font-style:normal;font-display:block;src:url('/fonts/PretendardGOV-${name}.woff2') format('woff2')}`).join('');

/**
 * PDF 전용 CSS(조정자 결정 C). **원본 인쇄 경로(P L5000–5012)와 다른 점은 아래 두 가지뿐이다.** 화면 CSS는 바꾸지 않는다.
 *
 * 1. 표 3개의 고정 열 너비
 *    - 원본 고정 열 너비 합(부록 .al 약 770px, 실행 기록 .at 약 708px)이 인쇄 폭(182mm ≈ 688px)보다 넓다.
 *      원본대로 찍으면 Chromium이 문서 전체를 약 0.89배로 줄여 본문이 9pt 밑이 되고, 남는 폭이 없는 제목 열이 글자 단위로 쪼개진다.
 *    - 그래서 세 표(.at 실행 기록, .nx 다음 예정, .al 부록)의 고정 열 너비만 바꿔 688px 안에 넣는다. 글자 크기·간격·순서는 원본 그대로다.
 *    - 등급 열(.at 3번째)은 모델 ID(예: claude-sonnet-5-5)가 하이픈에서 끊기지 않을 만큼 넓힌다.
 *    - 원본 값(prototype.css L549–551): .at `96px 148px 150px 120px 56px minmax(0,1fr) 90px`,
 *      .nx `90px minmax(0,1.4fr) 80px 100px 160px minmax(0,1.2fr)`, .al `56px 86px minmax(0,1.6fr) 90px 110px 56px 76px 66px 90px 66px`
 * 2. 표 칸 `word-break:keep-all` + 문서 `overflow-wrap:anywhere`
 *    - Chromium은 한글을 음절 사이 어디서나 줄바꿈한다. 그래서 좁은 칸에서 「개발」이 「개/발」로 쪼개진다.
 *      keep-all이면 한글도 띄어쓰기에서만 줄바꿈한다.
 *    - 띄어쓰기 없는 아주 긴 글이 칸·문서 밖으로 넘치지 않게, 한 줄에 다 들어가지 않는 글만 줄 끝에서 끊는다(overflow-wrap:anywhere).
 *      보통 글에는 영향이 없다. 문서 전체에 두는 이유: 보고용의 목록(주요 완료 항목 등)도 표가 아니지만 넘치면 문서 전체가 줄어든다.
 *    - 하이픈(-) 바로 뒤 줄바꿈은 허용한다(마크업은 화면과 같게 둔다).
 */
const PDF_CSS = [
  '.rpt-trw.at{grid-template-columns:80px 78px 168px 86px 44px minmax(0,1fr) 54px}',
  '.rpt-trw.nx{grid-template-columns:72px minmax(0,1fr) 72px 92px 128px 128px}',
  '.rpt-trw.al{grid-template-columns:40px 72px minmax(0,1fr) 60px 88px 40px 60px 58px 64px 44px}',
  '.rpt-tbl [role=cell],.rpt-tbl [role=columnheader]{word-break:keep-all}',
  '.rpt-doc{overflow-wrap:anywhere}',
].join('');

/** 원본 인쇄 경로(P L5005)가 문서에 덧붙인 CSS 그대로 */
const PRINT_CSS = 'html,body{background:#fff;margin:0}.rpt-doc{border:0;max-width:none;padding:0}.reflink{color:inherit;text-decoration:none;border:0;background:none;padding:0;font:inherit}@page{size:A4;margin:14mm}';

/**
 * 입력은 보고서 기록(번호·종류·기간·생성 시각·사유)과 스냅샷뿐이다. 프로젝트 이름도 스냅샷 값을 쓴다.
 * 왜: 보고서는 생성 시점 기록이다. 지금 DB 값을 읽으면 이름을 바꾼 뒤 만든 PDF가 그때의 보고서와 달라진다.
 */
export interface ReportHtmlInput extends ReportHead { view: ReportView; snapshot: ReportSnapshotData }

export function reportHtml(r: ReportHtmlInput): string {
  const late = lateLabel(r);
  const weekly = r.kind !== 'daily' && r.snapshot.series.length > 1;
  const article = el('article', `class="rpt-doc" aria-label="${esc(`${r.reportKey} 보고서`)}"`,
    el('header', 'class="rpt-h"',
      el('div', 'class="rpt-kind"', esc(KIND[r.kind].doc)),
      el('h2', '', esc(docTitle(reportProjectName(r.snapshot), r.kind, r.view))),
      el('div', 'class="rpt-meta"',
        el('span', '', esc('기간 '), el('b', 'class="mono"', esc(periodLabel(r)))),
        el('span', '', esc('생성 '), span('mono', formatDateTime(r.generatedAt)), esc(` · ${byLabel(r.kind)}`)),
        span('mono', r.reportKey)),
      el('p', 'class="rpt-snap"', esc(`${snapLabel(r.generatedAt)}${late ? ` · ${late}` : ''}`))),
    r.view === 'int' ? internal(r.snapshot, r.kind, weekly) : external(r.snapshot, r.kind, weekly),
    el('footer', 'class="rpt-f"', esc(`Agent WBS 자동 생성 · ${r.reportKey} · ${formatDateTime(r.generatedAt)}`)));
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(`${r.reportKey}_${r.view === 'int' ? '팀장용' : '보고용'}`)}</title>`
    + `<style>${fontFaces()}</style><style>${prototypeCss()}</style><style>${PRINT_CSS}${PDF_CSS}</style></head><body>${article}</body></html>`;
}
