/**
 * 보고서 메일 본문 만들기(G§4.11 L403-404, §9.6-6 5 L1049, P Sel.mailSubject L3916 · Sel.mailHtml L4003).
 *
 * 미리보기와 실제 발송이 **이 함수 하나**를 쓴다(G§8.5 「실제 발송과 같은 생성 함수」).
 * 왜: 미리보기와 보낸 메일이 다르면 팀장이 확인한 내용과 받는 사람이 본 내용이 어긋난다.
 *
 * 메일 HTML 규칙(G L1049). 메일 앱(Outlook·Gmail)은 화면 HTML의 많은 기능을 지우기 때문이다.
 * - 표(`<table>`)로 칸을 나누고, 모든 모양은 `style="…"`(인라인 스타일)로 적는다. `<style>`·외부 CSS·class·flex/grid는 쓰지 않는다.
 * - 폭은 640px. 외부 이미지·스크립트·웹 폰트는 넣지 않는다.
 * - 글꼴은 `'Pretendard GOV','Apple SD Gothic Neo','Malgun Gothic',sans-serif` 순서다. Pretendard GOV가 없는 PC는 다음 글꼴로 보인다.
 * - 서식 없는 본문(text/plain)도 함께 만든다. HTML을 못 읽는 메일 앱을 위해서다.
 *
 * 숫자와 보고용 문장은 화면과 같은 계산(`internalKpis`·`externalView`, shared report/view)에서 온다.
 * 그래서 화면·메일·PDF가 같은 스냅샷에서 같은 숫자를 보인다(milestones §4.0).
 */
import { externalView, internalKpis, monthDay, type Kpi, type ReportKind, type ReportSnapshotData } from '@awbs/shared';

export interface MailReport {
  id: string;
  reportKey: string;
  kind: ReportKind;
  from: string;
  to: string;
  generatedAt: string;
  snapshot: ReportSnapshotData;
}
export interface MailInput {
  projectName: string;
  report: MailReport;
  view: 'int' | 'ext';
  /** 받는 사람 주소(바닥글 「수신: …」). 미리보기에서 받는 사람을 고르지 않았으면 null */
  to: string | null;
  /** Agent WBS 접속 주소(설정 → 알림). 비어 있으면 「전체 보고서 보기」 링크를 넣지 않는다(G L543). */
  appUrl: string | null;
}
export interface RenderedMail { subject: string; html: string; text: string }

const KIND = { daily: '일간', weekly: '주간', custom: '기간' } as const;
/** P LBL.status L2912 */
const STATUS: Record<string, string> = {
  planning: '계획 중', approval: '승인 대기', ready: '실행 대기', running: '실행 중', qa: 'QA 진행', rework: '재작업 필요', verifying: '검증 진행',
  gate: 'Gate 대기', paused: '중단 · 재개 대기', done: '완료', failed: '실패', cancelled: '취소됨',
};
const FONT = "font-family:'Pretendard GOV','Apple SD Gothic Neo','Malgun Gothic',sans-serif;";

/** 일간 보고서는 항상 팀장용이다(G L402). */
export const mailView = (kind: ReportKind, view: 'int' | 'ext'): 'int' | 'ext' => (kind === 'daily' ? 'int' : view);

/** 첨부 PDF 파일 이름(G L410 예: `RPT-W-261027_보고용.pdf`) */
export const pdfName = (reportKey: string, view: 'int' | 'ext') => `${reportKey}_${view === 'int' ? '팀장용' : '보고용'}.pdf`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const period = (r: MailReport) => (r.from === r.to ? r.from : `${r.from} ~ ${r.to}`);
/** 생성 시각을 서울 시각 `YYYY-MM-DD HH:mm`로 */
const seoulTime = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

/** 제목(G L404 형식): `[Agent WBS] 주간 보고(요약) 2026-10-27 ~ 2026-11-02 — 완료 3건 · 완료 예상 11-10` */
export function mailSubject(r: MailReport, view: 'int' | 'ext'): string {
  const v = mailView(r.kind, view);
  return `[Agent WBS] ${KIND[r.kind]} 보고${v === 'ext' ? '(요약)' : ''} ${period(r)} — 완료 ${String(r.snapshot.done.length)}건 · 완료 예상 ${monthDay(r.snapshot.summary.forecast)}`;
}

interface Section { title: string; items: string[] }

/** 본문 섹션 목록(G L403: 팀장용 6개 / 보고용 4개). 팀장용 줄 모양은 P mailHtml L4017-4020 그대로다. */
function sections(r: MailReport, view: 'int' | 'ext'): { kpis: Kpi[]; sections: Section[] } {
  const s = r.snapshot;
  if (view === 'ext') {
    const x = externalView(s, r.kind);
    return {
      kpis: x.kpis,
      sections: [
        { title: '요약', items: x.summary },
        { title: '주요 완료 항목', items: x.highlights },
        { title: '위험 · 이슈', items: x.risks },
        { title: '다음 계획', items: x.plan },
      ],
    };
  }
  return {
    kpis: internalKpis(s),
    sections: [
      { title: '팀장 확인 필요', items: s.issues.map((i) => i.text) },
      { title: '완료한 Task', items: s.done.map((t) => `${t.taskKey} ${t.title}`) },
      { title: '진행 중 · 확인 필요', items: s.active.slice(0, 6).map((t) => `${t.taskKey} ${t.title} — ${STATUS[t.status] ?? t.status} · 다음: ${t.next}`) },
      { title: 'QA 실패', items: s.failures.map((f) => `${f.taskKey} ${f.title} — ${f.actual}`) },
      { title: '일정 재조정', items: s.replans.map((p) => `${p.replanId} ${p.trigger} (${p.before === null ? '최초' : monthDay(p.before)} → ${monthDay(p.after)})`) },
      { title: r.kind === 'daily' ? '다음 날 예정' : '다음 주 예정', items: s.next.map((t) => `${t.taskKey} ${t.title} (${monthDay(t.start)} ~ ${monthDay(t.end)})`) },
    ],
  };
}

const FOOTER = '보고서는 생성 시점의 스냅샷이며 이후 변경은 반영되지 않습니다. 수신 설정은 Agent WBS → 설정 → 보고서 · 메일에서 바꿀 수 있습니다.';
const footerLead = (to: string | null) => `이 메일은 Agent WBS가 보고서 생성 직후 자동으로 보냈습니다${to ? ` (수신: ${to})` : ''}.`;
const reportLink = (input: MailInput) => {
  const base = (input.appUrl ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/report/${input.report.id}` : null;
};

export function renderMail(input: MailInput): RenderedMail {
  const r = input.report;
  const view = mailView(r.kind, input.view);
  const subject = mailSubject(r, view);
  const { kpis, sections: list } = sections(r, view);
  const label = `${KIND[r.kind]} 보고서 · ${view === 'ext' ? '보고용' : '팀장용'}`;
  const meta = `기간 ${period(r)} · 생성 ${seoulTime(r.generatedAt)} · ${r.reportKey}`;
  const link = reportLink(input);

  const cell = (k: Kpi) => `<td style="padding:10px 12px;border:1px solid #E1E5EA;width:25%;vertical-align:top;${FONT}"><div style="font-size:12px;color:#6B7480">${esc(k.label)}</div><div style="font-size:20px;font-weight:700;color:#1F2933;margin:2px 0">${esc(k.value)}</div><div style="font-size:12px;color:#6B7480">${esc(k.sub)}</div></td>`;
  const sec = (x: Section) => `<tr><td style="padding:18px 0 6px;${FONT}font-size:15px;font-weight:700;color:#1F2933;border-bottom:1px solid #E1E5EA">${esc(x.title)}</td></tr>`
    + `<tr><td style="padding:6px 0 0;${FONT}font-size:13.5px;line-height:1.65;color:#3E4651">${x.items.length ? x.items.map((t) => `<div style="padding:3px 0">• ${esc(t)}</div>`).join('') : '<div style="color:#8A939E">없음</div>'}</td></tr>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>`
    + '<body style="margin:0;padding:0;background:#F2F4F7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F7"><tr><td align="center" style="padding:24px 12px">'
    + '<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#FFFFFF;border:1px solid #E1E5EA;border-radius:8px"><tr><td style="padding:24px 28px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
    + `<tr><td style="${FONT}font-size:12px;font-weight:700;color:#2453CF">${esc(label)}</td></tr>`
    + `<tr><td style="${FONT}font-size:20px;font-weight:700;color:#1F2933;padding:4px 0 2px">${esc(input.projectName)}</td></tr>`
    + `<tr><td style="${FONT}font-size:13px;color:#6B7480;padding-bottom:14px;border-bottom:2px solid #1F2933">${esc(meta)}</td></tr>`
    + `<tr><td style="padding:14px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${kpis.map(cell).join('')}</tr></table></td></tr>`
    + list.map(sec).join('')
    + (link ? `<tr><td style="padding:22px 0 0"><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#2453CF;color:#FFFFFF;text-decoration:none;border-radius:6px;${FONT}font-size:14px;font-weight:600">Agent WBS에서 전체 보고서 보기</a></td></tr>` : '')
    + `<tr><td style="padding:18px 0 0;${FONT}font-size:11.5px;color:#8A939E;line-height:1.6">${esc(`${footerLead(input.to)} ${FOOTER}`)}</td></tr>`
    + '</table></td></tr></table></td></tr></table></body></html>';

  const text = [
    label, input.projectName, meta, '',
    ...kpis.map((k) => `${k.label}: ${k.value} (${k.sub})`),
    ...list.flatMap((x) => ['', `■ ${x.title}`, ...(x.items.length ? x.items.map((t) => `• ${t}`) : ['없음'])]),
    ...(link ? ['', `Agent WBS에서 전체 보고서 보기: ${link}`] : []),
    '', footerLead(input.to), FOOTER, '',
  ].join('\n');
  return { subject, html, text };
}
