/**
 * 보고서 PDF용 HTML(apps/api/src/pdf/html.ts)의 빠른 시험. 실제 PDF·글꼴·캐시·초기화는 pdf.scenario(`pnpm test:scenario -- pdf`)가 본다.
 */
import { describe, expect, test } from 'vitest';
import type { ReportSnapshotData } from '@awbs/shared';
import { externalPdfLeaks, reportHtml, type ReportHtmlInput } from '../src/pdf/html.ts';

const summary: ReportSnapshotData['summary'] = {
  taskCount: 1, doneCount: 1, doneBefore: 0, workPct: 100, workPctBefore: 0, baselineVersion: 1, forecast: '2026-11-10', lo: '2026-11-08', hi: '2026-11-14',
  forecastBefore: '2026-11-10', target: '2026-11-12', uptimePct: 90, ratePct: 60, blocked: 0, statuses: [{ status: 'done', count: 1 }], started: [],
  attempts: { total: 0, dev: 0, qa: 0, pass: 0, fail: 0, escalated: 0, interrupted: 0, tokens: 0 },
};
const evil = '<script>alert(1)</script> & "따옴표"';
const snapshot: ReportSnapshotData = {
  projectName: `프로젝트 ${evil}`, projectNameStatus: 'snapshot', issues: [], series: [], active: [], failures: [], attempts: [], replans: [], gaps: [], messages: [], next: [], summary,
  done: [{
    taskKey: 'TASK-0001', wbsPath: '1.1.1', title: evil, assignee: 'Claude', verifier: 'Codex', workType: 'Implementation', domain: 'BE',
    actStart: '2026-10-27T01:00:00.000Z', actEnd: '2026-10-28T01:00:00.000Z', estHours: 3, actualHours: 2.5, attempts: 1, slipDays: 0,
    verification: null, checklist: { done: 1, total: 1, requiredLeft: 0 }, outputs: { delivered: 1, names: ['a.ts'] }, doneCond: '테스트 통과',
  }],
  all: [{ taskKey: 'TASK-0001', wbsPath: '1.1.1', title: evil, status: 'done', assignee: 'Claude', verifier: 'Codex', progressPct: 100, checklist: { done: 1, total: 1 }, verifState: 'pass', end: '2026-10-28', slipDays: 0, blocked: false }],
};
/** CSS를 뺀 본문만(CSS에는 화면용 선택자 이름도 들어 있다) */
const bodyOf = (html: string) => html.slice(html.indexOf('<body>'));
const input = (view: 'int' | 'ext'): ReportHtmlInput => ({
  reportKey: 'RPT-W-261026', kind: 'weekly', from: '2026-10-26', to: '2026-11-01', generatedAt: '2026-11-03T22:00:00.000000Z', dueAt: null, reason: '정기 생성',
  view, snapshot,
});

describe('보고서 PDF HTML', () => {
  test.each(['int', 'ext'] as const)('%s: 바깥 값의 HTML 특수 문자는 글자로 바뀐다(스크립트 0개)', (view) => {
    const html = reportHtml(input(view));
    expect(html).not.toContain('<script');
    expect(html).toContain('&#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;따옴표&#34;');
  });

  test('바깥 주소를 쓰지 않는다: 글꼴은 렌더러가 응답하는 /fonts/ 경로만 쓴다', () => {
    const html = reportHtml(input('int'));
    expect(html).not.toMatch(/https?:\/\//);
    expect([...html.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual([
      "'/fonts/PretendardGOV-Regular.woff2'", "'/fonts/PretendardGOV-Medium.woff2'", "'/fonts/PretendardGOV-SemiBold.woff2'", "'/fonts/PretendardGOV-Bold.woff2'",
    ]);
  });

  test('화면과 같은 문서 틀(rpt-doc·부록 rpt-appx)과 원본 인쇄 CSS(A4·14mm)', () => {
    const html = reportHtml(input('int'));
    expect(html).toContain('<article class="rpt-doc" aria-label="RPT-W-261026 보고서">');
    expect(html).toContain('<section class="rpt-sec rpt-appx">');
    expect(html).toContain('.rpt-appx{break-before:page}');
    expect(html).toContain('@page{size:A4;margin:14mm}');
    // 화면 조작(보기 전환·PDF 버튼)은 넣지 않는다.
    expect(bodyOf(html)).not.toContain('rp-bar');
    expect(bodyOf(html)).not.toContain('PDF 다운로드');
  });

  test('보고용에는 부록·Task ID가 없다', () => {
    const html = bodyOf(reportHtml(input('ext')));
    expect(html).not.toContain('rpt-appx');
    expect(html).not.toContain('TASK-0001');
    expect(html).toContain('(보고용)');
  });
});

describe('Q-13 fix1: 보고용 PDF도 같은 변환 함수 · 검사기를 지난다', () => {
  test('제목 · 프로젝트 이름의 앱 주소 · 내부 용어가 보고용 PDF 문서에 남지 않는다', () => {
    const dirty = { ...snapshot, projectName: 'P http://127.0.0.1:5173/report/x', done: snapshot.done.map((t) => ({ ...t, title: 'TASK-0007 개선 http://127.0.0.1:5173/settings/report' })) } as typeof snapshot;
    const html = reportHtml({ ...input('ext'), snapshot: dirty, appUrl: 'http://127.0.0.1:5173/' });
    expect(externalPdfLeaks(html, 'http://127.0.0.1:5173/')).toEqual([]);
    expect(externalPdfLeaks('<body>TASK-0007 http://127.0.0.1:5173/settings/report <a href="x">y</a></body>', 'http://127.0.0.1:5173/').length).toBeGreaterThanOrEqual(3);
  });
});
