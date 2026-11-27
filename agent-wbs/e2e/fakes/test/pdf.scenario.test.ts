/**
 * M6-02 보고서 PDF 시나리오(milestones M6-02 완료 조건, G§4.11 L392·L410, §8.5 L944, contracts §2.3·§8, UAT-REPORT-04·05).
 *
 * 확인하는 것(완료 조건 괄호 안 다섯 가지):
 * 1. 12섹션 필수 값 텍스트 추출 — PDF에서 글자를 꺼내, 화면 계산(apps/web report/model.ts)이 만든 값이 모두 있는지 본다.
 * 2. 부록 새 페이지 — 「부록. 전체 Task 현황」이 새 쪽의 첫 글자로 시작한다.
 * 3. A4 — 모든 쪽이 210×297mm이고, 글자가 인쇄 영역(여백 14mm) 밖으로 잘리지 않는다.
 * 4. 폰트 embed — 모든 글꼴이 Pretendard GOV이고 글꼴 파일이 PDF 안에 들어 있다(Type3 그림 글자 0개).
 * 5. 생성 중 초기화 — PDF를 만드는 사이에 프로젝트를 초기화하면 옛 PDF를 저장하지 않는다.
 * 그 밖에: 캐시(두 번째는 다시 만들지 않음, 동시 요청은 한 번만 만듦), 실패 503 PDF_FAILED, 입력 오류.
 *
 * 준비는 M6-01 보고서 시나리오와 같다: demo seed + 아래 fixture(중단 구간·재조정·Evidence·알림).
 * PDF는 실제 Chromium(Playwright)으로 만든다. 시험은 그 렌더러를 감싸 호출 횟수만 세거나 잠시 멈춘다.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import { internalTerms, type ReportSnapshotData } from '../../../packages/shared/src/index.ts';
import { createPool, recreateTestDatabase, runMigrations, seedDemo, type Pool } from '../../../packages/db/src/index.ts';
import { buildApp } from '../../../apps/api/src/app.ts';
import { issueLoginLink } from '../../../apps/api/src/platform/credentials.ts';
import { generateDueReports } from '../../../apps/api/src/reports/service.ts';
import { chromiumRenderer, type PdfRenderer } from '../../../apps/api/src/pdf/render.ts';
import { reportPdf } from '../../../apps/api/src/pdf/service.ts';
import * as pdfModel from '../../../apps/api/src/pdf/model.ts';
import { externalDoc as pdfExternalDoc, internalDoc as pdfInternalDoc } from '../../../apps/api/src/pdf/model.ts';
import * as web from '../../../apps/web/src/features/report/model.ts';
import { externalDoc, internalDoc } from '../../../apps/web/src/features/report/model.ts';
import { readPdf, squash, type PdfPage } from '../pdf-inspect.ts';
import { chromium } from 'playwright-core';
import { pdfAssets } from '../../../apps/api/src/pdf/assets.ts';
import { reportHtml, type ReportHtmlInput } from '../../../apps/api/src/pdf/html.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
interface Report { id: string; reportKey: string; kind: string; from: string; to: string; generatedAt: string }

let owner: Pool;
let pool: Pool;
let root: string;
let baseUrl: string;
let headers: Record<string, string>;
let close: () => Promise<void>;
const real = chromiumRenderer();

/** 시험이 렌더러를 감싼다: 호출 횟수를 세고, 필요하면 실패시키거나 멈춰 둔다. 실제 PDF는 진짜 Chromium이 만든다. */
const probe = {
  calls: 0,
  fail: false,
  gate: null as Promise<void> | null,
  started: null as (() => void) | null,
};
const renderer: PdfRenderer = {
  async render(html) {
    probe.calls++;
    probe.started?.();
    if (probe.gate) await probe.gate;
    if (probe.fail) throw new Error('시험용 변환 실패');
    return real.render(html);
  },
  close: () => real.close(),
};

const kst = (day: string, hm = '00:00') => new Date(`${day}T${hm}:00+09:00`).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');

/** M6-01 reports.scenario의 fixture와 같은 기록(demo seed에 없는 중단 구간·재조정·Evidence·알림). */
async function fixture() {
  await owner.query("update projects set start_date='2026-10-27', target_date='2026-11-12'");
  await owner.query("update tasks set act_start=$1, act_end=$2 where task_key='TASK-0002'", [kst('2026-10-28', '20:00'), '2026-10-28T14:59:59.999Z']);
  await owner.query("update tasks set act_start=$1, act_end=$2 where task_key='TASK-0003'", [kst('2026-10-28', '21:00'), '2026-10-28T15:00:00.000Z']);
  await owner.query(`insert into runner_sessions(runner_id,started_at,ended_at,end_reason,last_heartbeat_at) values
    ('pc-1',$1,$2,'reboot',$2),('pc-1',$3,null,null,$4)`, [kst('2026-10-27', '09:00'), kst('2026-10-29', '22:00'), kst('2026-10-30', '01:00'), kst('2026-11-27', '00:00')]);
  const project = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id;
  const t7 = (await owner.query<{ id: string }>("select id from tasks where task_key='TASK-0007'")).rows[0]?.id;
  await owner.query(`insert into replans(project_id,rp_key,trigger,actor,baseline_v,status,before,after,created_at) values
    ($1,'RP-001','초기 WBS 등록','Planning Agent',1,'applied','{"end":null}','{"end":"2026-11-07","lo":"2026-11-06","hi":"2026-11-10"}',$2)`, [project, kst('2026-10-25', '10:00')]);
  const rp2 = (await owner.query<{ id: string }>(`insert into replans(project_id,rp_key,trigger,actor,baseline_v,status,before,after,created_at) values
    ($1,'RP-002','QA FAIL — TASK-0007 재작업','시스템',2,'applied','{"end":"2026-11-07"}','{"end":"2026-11-10","lo":"2026-11-08","hi":"2026-11-14"}',$2) returning id`, [project, kst('2026-10-31', '10:00')])).rows[0]?.id;
  await owner.query(`insert into replan_moves(project_id,task,replan,kind,before,after,created_at) values($1,$2,$3,'delayed','{"end":"2026-11-04"}','{"end":"2026-11-06"}',$4)`, [project, t7, rp2, kst('2026-10-31', '10:00')]);
  await owner.query(`insert into evidence(project_id,task,verification,kind,reference_path)
    select v.project_id,a.task,v.id,'log',p from verifications v join task_attempts a on a.id=v.attempt,
    unnest(array['evidence/TASK-0007/qa-1/vitest.txt','evidence/TASK-0007/qa-1/perf.json']) p
    where a.task=$1 and v.result='FAIL'`, [t7]);
  await owner.query(`insert into alerts(project_id,key,severity,target,created_at) values($1,'usage:Claude','warn','{"message":"Claude 사용량 부족 — 실행 보류"}',$2)`, [project, kst('2026-10-30', '09:00')]);
}

beforeAll(async () => {
  const db = new URL(inject('testDatabaseUrl'));
  db.pathname += '_pdf_scenario';
  await recreateTestDatabase(db.href);
  owner = createPool(db.href, { onError: () => undefined });
  const appUrl = new URL(db);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  pool = createPool(appUrl.href, { onError: () => undefined });
  root = await mkdtemp(join(tmpdir(), 'awbs-m602-pdf-'));
  const origin = 'http://127.0.0.1:3100';
  const app = buildApp(pool, false, { origin, lan: false }, { dataRoot: root }, { renderer });
  close = async () => { await app.close(); await pool.end(); await owner.end(); await rm(root, { recursive: true, force: true }); };
  await runMigrations(owner);
  await seedDemo(owner, db.href);
  await fixture();
  await generateDueReports(pool, 1, { now: kst('2026-11-04', '07:00'), startup: true });
  const link = await issueLoginLink(pool);
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await fetch(`${baseUrl}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'link', token: link }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  const { csrfToken } = await (await fetch(`${baseUrl}/api/session`, { headers: { cookie } })).json() as { csrfToken: string };
  headers = { cookie, origin, 'x-csrf-token': csrfToken, 'x-project-epoch': '1' };
}, 60_000);
afterAll(async () => { await close(); });

const pdf = (id: string, view: string) => fetch(`${baseUrl}/api/reports/${id}/pdf?view=${view}`, { headers });
const json = async (path: string, init: RequestInit = {}): Promise<Body> => (await fetch(baseUrl + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })).json();
const reportOf = async (kind: string, from: string): Promise<Report & { snapshot: ReportSnapshotData }> => {
  const project = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id ?? '';
  const r = ((await json(`/api/projects/${project}/reports?limit=200&kind=${kind}`)).items as Report[]).find((x) => x.from === from);
  assert(r, `${kind} ${from} 보고서가 없다`);
  return json(`/api/reports/${r.id}`) as Promise<Report & { snapshot: ReportSnapshotData }>;
};
const fetchPdf = async (id: string, view: string) => {
  const response = await pdf(id, view);
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes, doc: await readPdf(bytes) };
};
const textOf = (pages: PdfPage[]) => pages.map((p) => p.text).join('');
/** 문서에 이 글자가 있는가(공백 무시). 없으면 어떤 값이 빠졌는지 보이게 값을 그대로 돌려준다. */
const missing = (text: string, values: string[]) => values.filter((v) => v.trim() && !text.includes(squash(v)));

/**
 * 인쇄 폭(A4 − 좌우 14mm = 182mm ≈ 688px)으로 실제 Chromium에 배치해(print 매체, 100%) 표를 잰다.
 * PDF도 같은 엔진·같은 폭·100%로 찍으므로 배치가 같다.
 * - overflow: 문서·표·행·칸 중 내용이 칸보다 넓은 곳.
 * - brokenWords: 표 머리글·칸 안의 단어(공백으로 나눈 조각) 중 하이픈(-) 바로 뒤가 아닌 곳에서 줄이 바뀐 것(조정자 규칙:
 *   한글 음절·영문 글자 중간 줄바꿈 0, 줄바꿈은 공백 또는 하이픈 바로 뒤만 허용). 글자마다 화면 위치를 재서 줄이 바뀐 곳을 찾는다.
 * - hyphenBreaks: 하이픈 바로 뒤에서 줄이 바뀐 단어(허용되지만, 등급 칸의 모델 ID는 통째로 유지해야 한다).
 * - words: 잰 단어 수.
 */
async function layoutAtPrintWidth(html: string): Promise<{ overflow: string[]; brokenWords: string[]; hyphenBreaks: string[]; words: number }> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: Math.floor((182 / 25.4) * 96), height: 1123 } });
    const fonts = pdfAssets().fonts;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/doc') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      const font = fonts.get(url.pathname);
      return font ? route.fulfill({ contentType: 'font/woff2', body: font }) : route.abort();
    });
    await page.emulateMedia({ media: 'print' });
    await page.goto('https://layout.awbs.invalid/doc');
    return await page.evaluate(`(async () => {
      await Promise.all([...document.fonts].map((f) => f.load()));
      const overflow = [], brokenWords = [], hyphenBreaks = [];
      let words = 0;
      const doc = document.querySelector('.rpt-doc');
      if (doc.scrollWidth > window.innerWidth) overflow.push('문서 ' + doc.scrollWidth);
      const cells = document.querySelectorAll('.rpt-tbl [role=cell], .rpt-tbl [role=columnheader], .rpt-trend [role=cell], .rpt-trend [role=columnheader]');
      for (const e of document.querySelectorAll('.rpt-tbl, .rpt-trend, [role=row]')) {
        if (e.scrollWidth > e.clientWidth + 1) overflow.push((e.getAttribute('role') || e.className) + ' ' + e.scrollWidth + '>' + e.clientWidth);
      }
      for (const cell of cells) {
        if (cell.scrollWidth > cell.clientWidth + 1) overflow.push('칸 ' + cell.scrollWidth + '>' + cell.clientWidth + ' ' + cell.textContent);
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (const m of node.textContent.matchAll(/\\S+/g)) {
            words++;
            const range = document.createRange();
            range.setStart(node, m.index);
            range.setEnd(node, m.index + m[0].length);
            const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
            if (tops.size < 2) continue;
            // 두 줄에 걸쳤다. 줄이 바뀐 글자 바로 앞이 하이픈(-)이면 허용, 아니면 단어 중간 줄바꿈이다.
            let prev = null;
            for (let i = 0; i < m[0].length; i++) {
              const ch = document.createRange();
              ch.setStart(node, m.index + i);
              ch.setEnd(node, m.index + i + 1);
              const top = Math.round(ch.getBoundingClientRect().top);
              if (prev !== null && top !== prev) { (m[0][i - 1] === '-' ? hyphenBreaks : brokenWords).push(m[0] + ' (' + cell.textContent.slice(0, 30) + ')'); break; }
              prev = top;
            }
          }
        }
      }
      return { overflow, brokenWords, hyphenBreaks, words };
    })()`) as { overflow: string[]; brokenWords: string[]; hyphenBreaks: string[]; words: number };
  } finally { await browser.close(); }
}

// A4 = 210×297mm = 595.28×841.89pt. Chromium은 쪽 크기를 화면 점(px) 단위로 맞추므로 1pt 남짓 차이가 난다.
const A4 = { width: 595.28, height: 841.89 };
const MARGIN = (14 / 25.4) * 72;

describe('주간 팀장용 PDF(RPT-W-261026, 12섹션에 값이 있다)', () => {
  let s: ReportSnapshotData;
  let id: string;
  let head: Report;
  let doc: Awaited<ReturnType<typeof readPdf>>;
  let response: Response;
  let bytes: Uint8Array;
  beforeAll(async () => {
    const r = await reportOf('weekly', '2026-10-26');
    s = r.snapshot;
    id = r.id;
    head = r;
    ({ response, bytes, doc } = await fetchPdf(id, 'int'));
  }, 60_000);

  test('PDF 형식과 파일 이름(G L410: RPT-W-261026_팀장용.pdf)', () => {
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="RPT-W-261026.pdf"; filename*=UTF-8''${encodeURIComponent('RPT-W-261026_팀장용.pdf')}`);
  });

  test('A4: 모든 쪽이 210×297mm', () => {
    expect(doc.pages.length).toBeGreaterThan(1);
    for (const p of doc.pages) {
      expect(Math.abs(p.width - A4.width)).toBeLessThan(1.5);
      expect(Math.abs(p.height - A4.height)).toBeLessThan(1.5);
    }
  });

  test('잘림 없음: 모든 글자가 좌우 여백(14mm) 안에 있다', () => {
    const outside = doc.pages.flatMap((p, n) => p.items.filter((i) => i.x < MARGIN - 1 || i.x + i.width > p.width - MARGIN + 1).map((i) => `${String(n + 1)}쪽 ${i.str}`));
    expect(outside).toEqual([]);
  });

  test('본문 글자는 9pt 이상이다(100% 배율). 9pt 미만은 원본 11~11.5px인 태그·배지·꼬리말뿐이다', () => {
    const x = internalDoc(s);
    // 원본 크기 그대로 두기로 한 예외(조정자 승인): .tag(11px)·.sc(11.5px)·.rpt-f(11px)
    const small = new Set([
      ...x.issues.map((i) => i.label), '완료', 'FAIL', '차단',
      ...x.active.map((t) => t.st), ...x.messages.map((m) => m.type),
    ].map(squash));
    const footer = squash(`Agent WBS 자동 생성 · ${head.reportKey} · ${pdfModel.formatDateTime(head.generatedAt)}`);
    const under = doc.pages.flatMap((p) => p.items.filter((i) => i.size < 8.95).map((i) => squash(i.str)))
      .filter((t) => !small.has(t) && !footer.includes(t));
    expect(under).toEqual([]);
    // 본문(13px)이 9.75pt다 = 줄이지 않고 찍었다.
    const sizes = doc.pages.flatMap((p) => p.items.map((i) => Math.round(i.size * 100) / 100));
    expect(sizes).toContain(9.75);
  });

  test('표가 인쇄 폭(182mm = 688px)을 넘지 않고, 모든 열 제목·값이 단어 중간에서 줄바꿈되지 않는다(팀장용·보고용)', async () => {
    const r = await json(`/api/reports/${id}`) as ReportHtmlInput;
    for (const view of ['int', 'ext'] as const) {
      const found = await layoutAtPrintWidth(reportHtml({ ...r, view }));
      expect(found.overflow, `${view} 넘침`).toEqual([]);
      expect(found.brokenWords, `${view} 단어 중간 줄바꿈`).toEqual([]);
      // 등급 칸의 모델 ID(예: claude-sonnet-5-5)는 하이픈에서도 끊기지 않는다(등급 열을 넓힌 이유).
      const models = new Set([...r.snapshot.attempts, ...r.snapshot.next].flatMap((a) => a.grade?.modelId ?? []));
      expect(models.size, view).toBeGreaterThan(0);
      expect(found.hyphenBreaks.filter((w) => models.has(w.split(' ')[0] ?? '')), `${view} 모델 ID 끊김`).toEqual([]);
      // 시험이 실제로 표의 단어를 쟀다는 증거
      expect(found.words, view).toBeGreaterThan(view === 'int' ? 300 : 20);
    }
  }, 60_000);

  test('띄어쓰기 없는 아주 긴 글(한글·영문)도 어떤 칸의 너비도 넘지 않는다(keep-all + overflow-wrap:anywhere)', async () => {
    const r = await json(`/api/reports/${id}`) as ReportHtmlInput;
    const long = `${'가나다라마바사'.repeat(12)}${'ABCDEFGHIJ'.repeat(12)}`;
    const snapshot: ReportSnapshotData = {
      ...r.snapshot,
      all: r.snapshot.all.map((t, n) => (n === 0 ? { ...t, title: long, taskKey: 'TASK-0001' } : t)),
      next: r.snapshot.next.map((t, n) => (n === 0 ? { ...t, title: long, conflictGroup: long } : t)),
      attempts: r.snapshot.attempts.map((a, n) => (n === 0 ? { ...a, summary: long } : a)),
    };
    for (const view of ['int', 'ext'] as const) {
      const found = await layoutAtPrintWidth(reportHtml({ ...r, snapshot, view }));
      expect(found.overflow, view).toEqual([]);
    }
    // 이런 글은 칸 끝에서 끊을 수밖에 없다(그래서 넘치지 않는다). 시험이 실제로 긴 글을 넣었다는 증거다.
    expect((await layoutAtPrintWidth(reportHtml({ ...r, snapshot, view: 'int' }))).brokenWords.some((w) => w.startsWith('가나다라'))).toBe(true);
  }, 60_000);

  test('폰트 embed: 글꼴은 모두 Pretendard GOV이고 글꼴 파일이 들어 있다(그림 글자 Type3 없음)', () => {
    expect(doc.fonts.baseFonts.length).toBeGreaterThan(0);
    expect(doc.fonts.baseFonts.filter((f) => !/^[A-Z]{6}\+PretendardGOV-/.test(f))).toEqual([]);
    expect(doc.fonts.type3).toBe(0);
    expect(doc.fonts.embeddedFiles).toBe(doc.fonts.descriptors);
  });

  test('부록은 새 쪽에서 시작한다(G L392)', () => {
    const heading = squash('부록. 전체 Task 현황 (보고서 생성 시점)');
    const at = doc.pages.findIndex((p) => p.text.includes(heading));
    expect(at).toBeGreaterThan(0);
    expect(doc.pages[at]?.text.startsWith(heading)).toBe(true);
    // 부록 표 머리글은 앞쪽에 없다(부록 내용이 앞 쪽에 섞이지 않음).
    expect(doc.pages.slice(0, at).some((p) => p.text.includes(squash('WBSTask제목상태개발/검증진행률')))).toBe(false);
    // 부록 쪽들에 전체 Task 12개가 모두 있다.
    const appendix = textOf(doc.pages.slice(at));
    expect(s.all.map((t) => t.taskKey).filter((k) => !appendix.includes(k))).toEqual([]);
  });

  test('12섹션 필수 값이 PDF 글자에 모두 있다(화면 계산과 같은 값)', () => {
    const text = textOf(doc.pages);
    const x = internalDoc(s);
    const sections = ['팀장 확인 필요', '일별 추세', '현재 상태 분포', '1. 완료한 Task', '2. 진행 중 · 확인 필요 Task', '3. QA 실패 · 결함 상세', '4. 실행 기록', '5. 일정 재조정', '6. 작업 환경 중단', '7. 팀장 지시 · Runner 응답', '8. 다음 주 예정', '부록. 전체 Task 현황'];
    expect(missing(text, sections)).toEqual([]);
    expect(missing(text, [
      // 핵심 지표
      ...x.kpis.flatMap((k) => [k.label, k.value, k.sub]),
      // 팀장 확인 필요
      ...x.issues.map((i) => i.text),
      // 일별 추세
      ...x.series.flatMap((d) => [d.day, d.up]),
      x.statusLine,
      // 1. 완료
      ...x.done.flatMap((t) => [t.id, t.title, t.who, t.act, t.est, t.verif, t.cl, t.out, t.cond, t.slip]),
      // 2. 진행 중: 미충족 Gate와 다음 작업
      ...x.active.flatMap((t) => [t.id, t.st, t.start, t.fc, t.last, t.verif, t.cl, t.gate, t.issue, t.next]),
      // 3. QA 실패: 명령 → 결과
      ...x.failures.flatMap((f) => [f.task, f.cmd, f.exp, f.act, f.defects, f.ev, f.follow]),
      // 4. 실행 기록
      x.execLine, ...x.attempts.flatMap((a) => [a.id, a.task, a.grade, a.time, a.sum, a.files, a.tok]),
      // 5. 재조정
      ...x.replans.flatMap((r) => [r.id, r.trigger, r.ch, r.range, ...r.moved.flatMap((m) => [m.task, m.title, m.ch])]),
      // 6. 중단
      ...x.gaps.flatMap((g) => [g.from, g.to, g.dur, g.reason]),
      // 7. 메시지
      ...x.messages.flatMap((m) => [m.task, m.dir, m.type, m.body]),
      // 8. 예정
      ...x.next.flatMap((t) => [t.id, t.title, t.per, t.pre, t.cg]),
      // 부록: 모든 열
      ...x.all.flatMap((t) => [t.wbs, t.id, t.title, t.st, t.who, t.pct, t.cl, t.verif, t.fc, t.slip]),
    ])).toEqual([]);
    expect(x.failures.length).toBeGreaterThan(0);
    expect(x.active.some((t) => t.gate.includes('미충족'))).toBe(true);
  });

  test('화면에만 있는 것(PDF 버튼·「생성 이후 변경」 안내)은 PDF에 없다', () => {
    expect(textOf(doc.pages)).not.toContain('PDF다운로드');
  });

  /** 캐시 파일 경로: `<세대>/pdf/<보고서>-<보기>-<문서 hash 앞 16자>.pdf` */
  const cachedPath = async () => (await owner.query<{ path: string }>("select path from report_pdfs where report=$1 and view='int'", [id])).rows[0]?.path ?? '';

  test('캐시: 두 번째 요청은 다시 만들지 않고 같은 파일을 준다(report_pdfs에 sha256 기록)', async () => {
    const before = probe.calls;
    const again = new Uint8Array(await (await pdf(id, 'int')).arrayBuffer());
    expect(probe.calls).toBe(before);
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
    const rows = (await owner.query<{ path: string; sha256: string; view: string }>('select path,sha256,view from report_pdfs where report=$1', [id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toMatch(new RegExp(`^1/pdf/${id}-int-[0-9a-f]{16}\\.pdf$`));
    const { createHash } = await import('node:crypto');
    expect(rows[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Buffer.from(await readFile(join(root, await cachedPath()))).equals(Buffer.from(bytes))).toBe(true);
  });

  test('캐시 파일이 바뀌었거나 없어졌으면 다시 만든다(지문이 다른 파일을 내보내지 않음)', async () => {
    await writeFile(join(root, await cachedPath()), 'broken');
    const before = probe.calls;
    const r = await fetchPdf(id, 'int');
    expect(probe.calls).toBe(before + 1);
    expect(Buffer.from(r.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    await rm(join(root, await cachedPath()));
    expect((await fetchPdf(id, 'int')).doc.pages.length).toBe(doc.pages.length);
    expect(probe.calls).toBe(before + 2);
    expect((await owner.query('select 1 from report_pdfs where report=$1', [id])).rowCount).toBe(1);
  }, 60_000);

  test('캐시 키는 문서 hash다: 행이 다른 문서의 파일을 가리키면(지문은 맞아도) 쓰지 않고 다시 만든다', async () => {
    // 다른 문서(예: 예전 서식)로 만든 파일이 남아 있는 상황을 만든다. 파일 지문은 행과 맞게 둔다.
    const other = `1/pdf/${id}-int-${'0'.repeat(16)}.pdf`;
    await writeFile(join(root, other), 'other document');
    const { createHash } = await import('node:crypto');
    await owner.query("update report_pdfs set path=$2,sha256=$3 where report=$1 and view='int'", [id, other, createHash('sha256').update('other document').digest('hex')]);
    const before = probe.calls;
    const r = await fetchPdf(id, 'int');
    expect(probe.calls).toBe(before + 1);
    expect(Buffer.from(r.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(await cachedPath()).not.toBe(other);
    // 행이 가리키던 옛 파일은 지운다.
    await expect(readFile(join(root, other))).rejects.toThrow();
  }, 60_000);

  test('PDF의 모든 값은 스냅샷에서 온다: 생성 뒤 프로젝트 이름을 바꿔도 제목은 생성 때 이름이다', async () => {
    expect(s.projectName).toBe('Verum-SDN Agent WBS — Self Development');
    await owner.query("update projects set name='바뀐 이름'");
    try {
      await rm(join(root, await cachedPath()));
      const r = await fetchPdf(id, 'int');
      const text = textOf(r.doc.pages);
      expect(text).toContain(squash(`${s.projectName} — 주간 보고서`));
      expect(text).not.toContain('바뀐이름');
    } finally {
      await owner.query('update projects set name=$1', [s.projectName]);
    }
  }, 60_000);
});

describe('보고용 PDF(같은 스냅샷, 내부 용어 0건)', () => {
  test('보고용 문장이 모두 있고 Task ID·시도·모델·토큰이 없다', async () => {
    const r = await reportOf('weekly', '2026-10-26');
    const { response, doc } = await fetchPdf(r.id, 'ext');
    expect(response.headers.get('content-disposition')).toContain(encodeURIComponent('RPT-W-261026_보고용.pdf'));
    const text = textOf(doc.pages);
    const e = externalDoc(r.snapshot, 'weekly');
    expect(missing(text, ['요약', '주간 추이', '주요 완료 항목', '위험 · 이슈', '다음 계획', ...e.kpis.flatMap((k) => [k.label, k.value, k.sub]), ...e.summary, ...e.highlights, ...e.risks, ...e.plan])).toEqual([]);
    expect(internalTerms(doc.pages.map((p) => p.items.map((i) => i.str).join(' ')).join('\n'))).toEqual([]);
    expect(doc.fonts.type3).toBe(0);
  }, 60_000);
});

describe('빈 상태(기록 없는 날 일간 RPT-D-261027)', () => {
  test('값이 없어도 섹션마다 안내 문구를 보인다', async () => {
    const r = await reportOf('daily', '2026-10-27');
    const { doc } = await fetchPdf(r.id, 'int');
    expect(missing(textOf(doc.pages), [
      '기간 중 완료한 Task가 없습니다.', '기간 중 실행 시도가 없습니다.', '기간 중 재조정이 없습니다.', '기간 중 중단이 없습니다.', '기간 중 메시지가 없습니다.', '8. 다음 날 예정',
    ])).toEqual([]);
  }, 60_000);

  test('짧은 보고서에서도 부록은 새 쪽에서 시작한다(앞 쪽에 자리가 남아도 넘긴다)', async () => {
    // 부록이 앞 쪽에 충분히 들어갈 만큼 작은 보고서: 기록 없는 날 스냅샷에서 진행 중 Task·확인 항목을 비우고 전체 표를 1건만 남긴다.
    // 왜: 부록이 한 쪽을 거의 채우면 「새 쪽 시작」 규칙이 없어도 자리가 모자라 다음 쪽으로 넘어가 버려, 규칙을 시험하지 못한다.
    const base = await reportOf('daily', '2026-10-27');
    const small: ReportSnapshotData = { ...base.snapshot, active: [], issues: [], all: base.snapshot.all.slice(0, 1) };
    const project = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id;
    const id = (await owner.query<{ id: string }>(`insert into reports(project_id,report_key,kind,"from","to",view,snapshot,generated_at,reason)
      values($1,'RPT-C-900','custom','2026-10-27','2026-10-27','int',$2::jsonb,now(),'팀장 지정') returning id`, [project, JSON.stringify(small)])).rows[0]?.id;
    assert(id);
    const { doc } = await fetchPdf(id, 'int');
    const heading = squash('부록. 전체 Task 현황 (보고서 생성 시점)');
    expect(doc.pages).toHaveLength(2);
    // 기간 보고서는 「다음 주 예정」이라고 쓴다(화면과 같다).
    expect(doc.pages[0]?.text).toContain(squash('8. 다음 주 예정'));
    expect(doc.pages[0]?.text).not.toContain(heading);
    // 첫 쪽에 남은 높이(가장 아래 글자 ~ 아래 여백)가 부록 전체 높이(둘째 쪽 첫 글자 ~ 마지막 글자)보다 넉넉하다.
    // = 부록이 첫 쪽에 들어갈 수 있었는데도 새 쪽에서 시작했다.
    const ys = (n: number) => doc.pages[n]?.items.map((i) => i.y) ?? [];
    const free = Math.min(...ys(0)) - MARGIN;
    // 꼬리말(「Agent WBS 자동 생성」)은 부록 뒤에 붙는 줄이라 높이에서 뺀다.
    const body = doc.pages[1]?.items.filter((i) => !i.str.includes('자동 생성')).map((i) => i.y) ?? [];
    const appendix = Math.max(...body) - Math.min(...body);
    expect(free).toBeGreaterThan(appendix + 30);
    expect(doc.pages[1]?.text.startsWith(heading)).toBe(true);
  }, 60_000);
});

describe('PDF와 화면이 같은 계산을 쓴다', () => {
  test('서버 PDF의 보기 계산이 화면(apps/web report/model.ts)과 모든 보고서에서 같다', async () => {
    const project = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id ?? '';
    const list = (await json(`/api/projects/${project}/reports?limit=200`)).items as (Report & Parameters<typeof web.lateLabel>[0])[];
    expect(list.length).toBeGreaterThan(5);
    for (const row of list) {
      const { snapshot } = await json(`/api/reports/${row.id}`) as { snapshot: ReportSnapshotData };
      const kind = row.kind as 'daily' | 'weekly' | 'custom';
      expect(pdfInternalDoc(snapshot)).toEqual(internalDoc(snapshot));
      expect(pdfExternalDoc(snapshot, kind)).toEqual(externalDoc(snapshot, kind));
      // 머리말(제목·기간·누락 보충·스냅샷 안내·파일 이름·생성 주체)도 같은 글자다.
      for (const view of ['int', 'ext'] as const) {
        expect(pdfModel.docTitle(snapshot.projectName, kind, view)).toBe(web.docTitle(snapshot.projectName, kind, view));
        expect(pdfModel.pdfName(row.reportKey, view)).toBe(web.pdfName(row.reportKey, view));
      }
      expect(pdfModel.periodLabel(row)).toBe(web.periodLabel(row));
      expect(pdfModel.lateLabel(row)).toBe(web.lateLabel(row));
      expect(pdfModel.snapLabel(row.generatedAt)).toBe(web.snapLabel(row.generatedAt));
      expect(pdfModel.byLabel(kind)).toBe(web.rowView(row).byL);
      expect(pdfModel.KIND[kind].doc).toBe(web.KIND[kind].doc);
    }
  });
});

describe('동시 요청 · 실패 · 입력', () => {
  test('같은 보고서를 동시에 세 번 요청해도 한 번만 만든다', async () => {
    const r = await reportOf('daily', '2026-10-28');
    const before = probe.calls;
    const all = await Promise.all([pdf(r.id, 'int'), pdf(r.id, 'int'), pdf(r.id, 'int')]);
    expect(all.map((x) => x.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(all.map(async (x) => Buffer.from(await x.arrayBuffer())));
    expect(bodies[1]?.equals(bodies[0] ?? Buffer.alloc(0))).toBe(true);
    expect(probe.calls - before).toBe(1);
  }, 60_000);

  test('변환 실패 → 503 PDF_FAILED(다시 시도·기간 분리 안내), 저장하지 않고 다음 요청은 성공한다', async () => {
    const r = await reportOf('daily', '2026-10-29');
    probe.fail = true;
    const failed = await pdf(r.id, 'int');
    probe.fail = false;
    expect(failed.status).toBe(503);
    const body = await failed.json() as Body;
    expect(body.error.code).toBe('PDF_FAILED');
    expect(body.error.fix).toContain('다시 시도');
    expect(body.error.fix).toContain('기간을 나눠');
    expect((await owner.query('select 1 from report_pdfs where report=$1', [r.id])).rowCount).toBe(0);
    expect((await pdf(r.id, 'int')).status).toBe(200);
  }, 60_000);

  test('일간은 팀장용만 있다: 일간 보고용 → 400', async () => {
    const r = await reportOf('daily', '2026-10-29');
    const response = await pdf(r.id, 'ext');
    expect(response.status).toBe(400);
    expect(((await response.json()) as Body).error.errors[0].path).toBe('view');
  });

  test('보기 값이 없거나 틀리면 400, 없는 보고서는 404', async () => {
    const r = await reportOf('daily', '2026-10-29');
    expect((await fetch(`${baseUrl}/api/reports/${r.id}/pdf`, { headers })).status).toBe(400);
    expect((await pdf(r.id, 'all')).status).toBe(400);
    expect((await pdf(randomUUID(), 'int')).status).toBe(404);
  });

  test('팀장 세션이 없으면 401', async () => {
    const r = await reportOf('daily', '2026-10-29');
    expect((await fetch(`${baseUrl}/api/reports/${r.id}/pdf?view=int`)).status).toBe(401);
  });
});

describe('생성 중 프로젝트 초기화(contracts §8 초기화 경합)', () => {
  let stale: ReportSnapshotData;
  test('PDF를 만드는 동안 초기화하면: 초기화는 기다리지 않고 끝나고, 옛 PDF는 어느 세대 폴더에도 저장되지 않는다', async () => {
    const r = await reportOf('daily', '2026-10-30');
    let release: () => void = () => undefined;
    probe.gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { probe.started = resolve; });
    const pending = pdf(r.id, 'int');
    await started;
    const name = (await owner.query<{ name: string }>('select name from projects')).rows[0]?.name;
    const reset = await fetch(`${baseUrl}/api/project/reset`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ epoch: 1, confirmName: name, keepSettings: true }),
    });
    // 변환이 멈춰 있는 동안 초기화가 끝났다 = PDF 변환은 세대 잠금을 잡고 있지 않다.
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as Body).epoch).toBe(2);
    probe.started = null;
    release();
    probe.gate = null;
    const response = await pending;
    // 초기화로 보고서가 없어졌다. 옛 세대의 PDF를 돌려주거나 저장하지 않는다.
    expect(response.status).toBe(404);
    expect((await owner.query('select 1 from report_pdfs')).rowCount).toBe(0);
    const files = async (epoch: string) => readdir(join(root, epoch, 'pdf')).catch(() => [] as string[]);
    expect((await files('1')).filter((f) => f.startsWith(r.id))).toEqual([]);
    expect(await files('2')).toEqual([]);
    stale = r.snapshot;
  }, 60_000);

  test('세대 잠금: 초기화 전 세대(1)로 시작한 변환은, 새 세대(2)에 같은 보고서가 있어도 저장하지 않는다', async () => {
    // 초기화 뒤 새 세대의 보고서 하나(새 프로젝트 등록 뒤 생긴 보고서와 같은 상태)를 owner 권한으로 넣는다.
    const project = (await owner.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('새 프로젝트','https://github.com/fake/next','fake','next','','active') returning id")).rows[0]?.id;
    const id = (await owner.query<{ id: string }>(`insert into reports(project_id,report_key,kind,"from","to",view,snapshot,generated_at,reason)
      values($1,'RPT-C-001','custom','2026-10-30','2026-10-30','int',$2::jsonb,now(),'팀장 지정') returning id`, [project, JSON.stringify(stale)])).rows[0]?.id;
    assert(id);
    // 요청은 세대 1에서 받았고(변환 시작), 저장하려는 지금은 세대 2다.
    await expect(reportPdf(pool, root, renderer, 1, id, 'int')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await owner.query('select 1 from report_pdfs where report=$1', [id])).rowCount).toBe(0);
    expect((await readdir(join(root, '1', 'pdf')).catch(() => [] as string[])).filter((f) => f.startsWith(id))).toEqual([]);
    // 같은 보고서를 현재 세대로 요청하면 정상으로 만들고 세대 2 폴더에 둔다.
    const response = await pdf(id, 'int');
    expect(response.status).toBe(200);
    expect(await readdir(join(root, '2', 'pdf'))).toEqual([expect.stringMatching(new RegExp(`^${id}-int-[0-9a-f]{16}\\.pdf$`))]);
  }, 60_000);
});
