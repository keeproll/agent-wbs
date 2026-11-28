/**
 * M6-03 메일 단위 시험(DB 없음): SMTP 결과 분류와 메일 본문 규칙.
 * SMTP는 로컬 가짜 서버(e2e/fakes/smtp.ts)다. 실제 메일 서버에는 연결하지 않는다.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { internalTerms, type ReportSnapshotData } from '@awbs/shared';
import { FakeSmtp, mimePart } from '../../../e2e/fakes/smtp.ts';
import { checkSmtp, describeError, sendSmtp, type SmtpTarget } from '../src/mail/smtp.ts';
import { externalMailLeaks, mailSubject, renderMail, type MailReport } from '../src/mail/render.ts';
import { parseSender, scrubInternal } from '@awbs/shared';

const smtp = new FakeSmtp();
let target: SmtpTarget;
const mail = { from: 'Agent WBS <agent-wbs@example.com>', to: 'qa@example.com', subject: '제목', html: '<p>본문</p>', text: '본문' };

beforeAll(async () => {
  target = { host: '127.0.0.1', port: await smtp.start(), sec: '없음', user: smtp.user, password: smtp.password };
});
afterAll(async () => { await smtp.stop(); });

describe('SMTP 결과 분류(contracts §4.4: 수락 / 확실한 실패 / 수락 여부 불명)', () => {
  test('T-15 운영에서는 옛 평문 SMTP 설정도 연결·발송 전에 거부한다', async () => {
    const before = smtp.connections;
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(await checkSmtp(target)).toMatchObject({ ok: false, error: expect.stringContaining('SSL/TLS 또는 STARTTLS') });
      expect(await sendSmtp(target, mail)).toMatchObject({ state: 'rejected', error: expect.stringContaining('SSL/TLS 또는 STARTTLS') });
      expect(smtp.connections).toBe(before);
    } finally { vi.unstubAllEnvs(); }
  });
  test.each([
    ['accept', 'accepted'],
    ['auth_fail', 'rejected'],
    ['temp_fail', 'rejected'],
    ['drop_on_mail', 'rejected'],
    ['hold', 'unknown'],
    ['drop', 'unknown'],
  ] as const)('가짜 서버 %s → %s', async (mode, state) => {
    smtp.mode = mode;
    const outcome = await sendSmtp(target, mail, 400);
    expect(outcome.state).toBe(state);
    smtp.mode = 'accept';
  });

  test('연결이 거부되면(포트 닫힘) 보내기 전 실패다', async () => {
    const outcome = await sendSmtp({ ...target, port: 1 }, mail, 400);
    expect(outcome).toMatchObject({ state: 'rejected' });
    if (outcome.state === 'rejected') expect(outcome.error).toContain('SMTP 서버 연결 실패');
  });

  test('본문을 보내기 전에 끊긴 경우는 서버에 메일이 없다(그래서 다시 보내도 중복이 아니다)', async () => {
    const before = smtp.messages.length;
    smtp.mode = 'drop_on_mail';
    await sendSmtp(target, mail, 400);
    smtp.mode = 'accept';
    expect(smtp.messages).toHaveLength(before);
  });

  test('연결 확인은 로그인까지만 하고 메일을 보내지 않는다', async () => {
    const before = smtp.messages.length;
    expect(await checkSmtp(target, 400)).toEqual({ ok: true, error: null });
    smtp.mode = 'auth_fail';
    const bad = await checkSmtp(target, 400);
    smtp.mode = 'accept';
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('SMTP 인증 실패');
    expect(smtp.messages).toHaveLength(before);
  });

  test('오류 문장에 비밀번호가 섞여 와도 가린다', () => {
    expect(describeError(Object.assign(new Error('x'), { response: '535 bad pass fake-password', responseCode: 535 }), 'fake-password')).not.toContain('fake-password');
  });

  test('보낸 메일은 multipart/alternative(text/plain + text/html)다', async () => {
    const before = smtp.messages.length;
    expect((await sendSmtp(target, mail, 400)).state).toBe('accepted');
    const raw = smtp.messages[before]?.raw ?? '';
    expect(raw).toMatch(/multipart\/alternative/i);
    expect(mimePart(raw, 'text/plain')).toBe('본문');
    expect(mimePart(raw, 'text/html')).toBe('<p>본문</p>');
  });
});

/** 빈 스냅샷(데이터가 하나도 없을 때) */
const emptySnapshot = (): ReportSnapshotData => ({
  projectName: '메일 시험 프로젝트', projectNameStatus: 'snapshot',
  summary: {
    taskCount: 0, doneCount: 0, doneBefore: 0, workPct: 0, workPctBefore: 0, baselineVersion: 0, forecast: null, lo: null, hi: null, forecastBefore: null,
    target: null, uptimePct: 0, ratePct: 0, blocked: 0, statuses: [], started: [],
    attempts: { total: 0, dev: 0, qa: 0, pass: 0, fail: 0, escalated: 0, interrupted: 0, tokens: 0 },
  },
  issues: [], series: [], done: [], active: [], failures: [], attempts: [], replans: [], gaps: [], messages: [], next: [], all: [],
});
const report = (kind: MailReport['kind'], snapshot = emptySnapshot()): MailReport => ({
  id: '00000000-0000-4000-8000-000000000001', reportKey: 'RPT-W-261026', kind, from: '2026-10-26', to: kind === 'daily' ? '2026-10-26' : '2026-11-01',
  generatedAt: '2026-11-02T22:00:00.000Z', snapshot,
});

describe('메일 본문(G L403-404, L1049)', () => {
  test('빈 보고서도 섹션마다 「없음」을 보인다', () => {
    const m = renderMail({ projectName: '<P&>', report: report('weekly'), view: 'int', to: null, appUrl: null });
    expect(m.html.match(/>없음</g)).toHaveLength(6);
    expect(m.text.match(/^없음$/gm)).toHaveLength(6);
    // 프로젝트 이름은 HTML로 해석되지 않게 바꾼다
    expect(m.html).toContain('&lt;P&amp;&gt;');
    expect(m.html).not.toContain('<P&>');
    expect(m.html).toContain('생성 2026-11-03 07:00');
  });

  test('제목 형식: 일간은 날짜 하나, 보고용은 「(요약)」, 완료 예상이 없으면 —', () => {
    expect(mailSubject(report('daily'), 'ext')).toBe('[Agent WBS] 일간 보고 2026-10-26 — 완료 0건 · 완료 예상 —');
    expect(mailSubject(report('weekly'), 'ext')).toBe('[Agent WBS] 주간 보고(요약) 2026-10-26 ~ 2026-11-01 — 완료 0건 · 완료 예상 —');
  });

  test('보고용은 Task ID가 든 데이터가 있어도 본문에 내부 용어를 넣지 않는다', () => {
    const s = emptySnapshot();
    s.done.push({
      taskKey: 'TASK-0001', wbsPath: '1.1', title: '로그인 화면', assignee: 'Claude', verifier: 'Codex', workType: 'Implementation', domain: 'FE',
      actStart: null, actEnd: '2026-10-27T01:00:00.000Z', estHours: 1, actualHours: 1, attempts: 1, slipDays: null, verification: null,
      checklist: { done: 0, total: 0 }, outputs: { delivered: 0, names: [] }, doneCond: '',
    } as unknown as ReportSnapshotData['done'][number]);
    s.replans.push({ replanId: 'RP-001', at: '2026-10-27T01:00:00.000Z', trigger: '시험', before: null, after: '2026-11-01', lo: '2026-11-01', hi: '2026-11-02', moved: [] });
    const ext = renderMail({ projectName: 'P', report: report('weekly', s), view: 'ext', to: 'boss@example.com', appUrl: 'http://x/' });
    expect(internalTerms(ext.html)).toEqual([]);
    expect(internalTerms(ext.text)).toEqual([]);
    expect(ext.html).toContain('로그인 화면');
    const int = renderMail({ projectName: 'P', report: report('weekly', s), view: 'int', to: null, appUrl: 'http://x/' });
    expect(int.html).toContain('TASK-0001 로그인 화면');
    expect(int.html).toContain('RP-001 시험 (최초 → 11-01)');
    expect(int.html).toContain('href="http://x/report/00000000-0000-4000-8000-000000000001"');
  });

  /**
   * Q-13 결정 A: 외부 수신자 메일에는 앱 링크 · 내부 경로가 0건이다(G L1052).
   * 왜 접속 주소(appUrl)를 넣고 시험하나: 주소가 설정돼 있어도 외부 메일에는 링크가 빠져야 하기 때문이다.
   */
  test('외부 수신자 메일은 접속 주소가 있어도 링크 · 내부 경로가 0건이다', () => {
    const m = renderMail({ projectName: 'P', report: report('weekly'), view: 'ext', to: 'outside@partner.example', appUrl: 'http://192.168.0.10:3000/', external: true });
    for (const body of [m.html, m.text]) {
      expect(body.match(/href=|https?:\/\/|192\.168\.|\/report\/|\/settings\/|설정 →|전체 보고서 보기/g) ?? []).toEqual([]);
      expect(body).toContain('전체 내용은 첨부한 PDF에 있습니다.');
    }
    // 같은 보고서 · 같은 주소라도 내부 수신자면 지금처럼 링크가 있다.
    const inside = renderMail({ projectName: 'P', report: report('weekly'), view: 'ext', to: 'boss@example.com', appUrl: 'http://192.168.0.10:3000/' });
    expect(inside.html).toContain('href="http://192.168.0.10:3000/report/');
    expect(inside.text).toContain('설정 → 보고서 · 메일');
  });

  test('외부 수신자 메일은 팀장용으로 만들 수 없다(내부 용어가 밖으로 나가지 않게)', () => {
    expect(() => renderMail({ projectName: 'P', report: report('weekly'), view: 'int', to: 'o@partner.example', appUrl: null, external: true })).toThrow('보고용');
  });
});

describe('메일 지표 이름 · 요약 문장은 원본 메일 문구(P mailHtml L4006-4014), 숫자는 화면과 같은 계산', () => {
  const filled = () => {
    const s = emptySnapshot();
    Object.assign(s.summary, { taskCount: 12, doneCount: 3, workPct: 13.1, workPctBefore: 0, baselineVersion: 2, forecast: '2026-11-29', lo: '2026-11-28', hi: '2026-12-02', target: '2026-11-25', uptimePct: 87, blocked: 2 });
    s.gaps.push({ from: '2026-10-29T13:00:00.000Z', to: '2026-10-29T16:00:00.000Z', minutes: 180, reason: 'reboot' });
    s.failures.push({ verificationId: 'v', taskKey: 'TASK-0007', title: 'WBS Tree UI', agent: 'Codex', at: '2026-10-30T01:00:00.000Z', cmd: '', expected: '', actual: '12/14 통과', defects: [], evidence: [], messages: [], reworks: [] });
    return s;
  };
  test('팀장용 지표 4개: 완료 (기간) · 완료율 (작업량) · 완료 예상 (vN) · 가동률(중단 N회)', () => {
    const m = renderMail({ projectName: 'P', report: report('weekly', filled()), view: 'int', to: null, appUrl: null });
    expect(m.text).toContain('완료 (기간): 0건 (누적 3 / 12)');
    expect(m.text).toContain('완료율 (작업량): 13.1% (기간 시작 0%)');
    expect(m.text).toContain('완료 예상 (v2): 11-29 (범위 11-28 ~ 12-02)');
    expect(m.text).toContain('가동률: 87% (중단 1회)');
    expect(renderMail({ projectName: 'P', report: report('weekly'), view: 'int', to: null, appUrl: null }).text).toContain('가동률: 0% (중단 없음)');
  });
  test('보고용 지표 · 요약 · 위험(원본 문장)', () => {
    const m = renderMail({ projectName: 'P', report: report('weekly', filled()), view: 'ext', to: null, appUrl: null });
    expect(m.text).toContain('완료: 0건 (누적 3 / 12)');
    expect(m.text).toContain('진척률: 13.1% (기간 시작 0%)');
    expect(m.text).toContain('완료 예상일: 2026-11-29 (범위 11-28 ~ 12-02)');
    expect(m.text).toContain('목표일 대비: 4일 초과 (목표 2026-11-25)');
    expect(m.text).toContain('• 기간 중 0건 완료, 누적 3 / 12건 (작업량 기준 13.1%).');
    expect(m.text).toContain('• 완료 예상일 2026-11-29 (범위 11-28 ~ 12-02).');
    expect(m.text).toContain('• 품질 검증 1건 보완 진행.');
    expect(m.text).toContain('• 목표일 초과 예상 — 범위 조정 또는 일정 협의 필요');
    expect(m.text).toContain('• 품질 보완 작업 1건 — 보완 후 재검증 예정');
    expect(m.text).toContain('• 선행 작업 대기 2건');
    const empty = renderMail({ projectName: 'P', report: report('weekly'), view: 'ext', to: null, appUrl: null }).text;
    expect(empty).toContain('• 완료 예상일 산정 전.');
    expect(empty).toContain('• 품질 검증 이상 없음.');
    expect(empty).toContain('• 특이 위험 없음');
    expect(empty).toContain('목표일 대비: — (목표 —)');
  });
});


describe('Q-13 fix1: 외부 메일은 모든 글이 변환 함수를 지나고 검사기 0건(리뷰 재현)', () => {
  const APP = 'http://127.0.0.1:5173';
  const withTitle = (title: string) => {
    const s = emptySnapshot();
    s.done.push({ taskKey: 'TASK-0001', wbsPath: '1.1', title, assignee: 'Claude', verifier: 'Codex', workType: 'Implementation', domain: 'FE', actStart: null, actEnd: '2026-10-27T01:00:00.000Z',
      estHours: 1, actualHours: 1, attempts: 1, slipDays: null, verification: null, checklist: { done: 1, total: 1 }, outputs: { delivered: 1, names: [] }, doneCond: '' } as unknown as ReportSnapshotData['done'][number]);
    return s;
  };
  test.each([
    ['내부 용어(리뷰 1)', 'TASK-0007 RP-002 Effort 토큰 개선'],
    ['앱 주소 · 앱 경로(리뷰 2)', 'TASK-0007 개선 http://127.0.0.1:5173/settings/report'],
    ['메뉴 안내 · 경로만', '개선 /report/abc 설정 → 보고서 · 메일'],
  ])('%s: 제목 · HTML · text/plain · 첨부 이름 모두 0건이고 남은 말은 보인다', (_name, title) => {
    const m = renderMail({ projectName: `P ${APP}/report/x TASK-0009`, report: report('weekly', withTitle(title)), view: 'ext', to: 'outside@partner.example', appUrl: APP, external: true });
    expect(externalMailLeaks({ ...m, to: 'outside@partner.example', attachments: [{ filename: 'RPT-W-261026_보고용.pdf' }] }, APP)).toEqual([]);
    expect(m.text).toContain('• 개선');
  });
  test('검사기는 남은 링크 · 내부 용어를 찾는다(발송 직전 차단의 근거)', () => {
    expect(externalMailLeaks({ subject: 'TASK-0001 보고', html: '<a href="http://127.0.0.1:5173/report/1">x</a>', text: '설정 → 알림', attachments: [{ filename: 'RP-001.pdf' }] }, APP).length).toBeGreaterThanOrEqual(5);
  });
});

describe('Q-13 fix2 · fix3: 보내는 사람은 허용 목록으로만 읽고, 헤더 검사에 들어간다', () => {
  test('externalMailLeaks는 From까지 본다(읽을 수 없는 보내는 사람은 그 자체로 실패)', () => {
    const base = { subject: '주간 보고(요약)', html: '<p>본문</p>', text: '본문' };
    expect(externalMailLeaks({ ...base, from: 'Agent WBS <a@example.com>' }, null)).toEqual([]);
    expect(externalMailLeaks({ ...base, from: { name: '에이전트 보고', address: 'a@example.com' } }, null)).toEqual([]);
    expect(externalMailLeaks({ ...base, from: '"TASK-0007 http://127.1:5173/x" <a@example.com>' }, null).length).toBeGreaterThan(0);
    expect(externalMailLeaks({ ...base, from: '=?UTF-8?B?VEFTSy0wMDA3?= <a@example.com>' }, null)).toEqual(['보내는 사람 형식']);
  });
  test('From 헤더는 읽어 낸 이름 · 주소로 만든다: 실제 메일 생성기 결과를 풀면 설정한 이름 그대로다', async () => {
    const { default: MailComposer } = await import('nodemailer/lib/mail-composer');
    for (const from of ['Agent WBS <agent-wbs@example.com>', '에이전트 보고-1 <a@example.com>', 'a@example.com']) {
      const sender = parseSender(from);
      expect(sender, from).not.toBeNull();
      const raw = (await new MailComposer({ from: sender ?? '', to: 'b@example.com', subject: 's', text: 't' }).compile().build()).toString();
      const header = /^From: (.*)$/m.exec(raw)?.[1] ?? '';
      const decoded = header.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, e: string, t: string) => (e.toLowerCase() === 'b' ? Buffer.from(t, 'base64').toString('utf8') : t)).replace(/"/g, '');
      expect(decoded).toBe(sender?.name ? `${sender.name} <${sender.address}>` : (sender?.address ?? ''));
    }
  });
});

describe('Q-13 fix4: 외부 변환은 외부 수신자에게만 — 내부 수신자의 팀장용 · 보고용은 바뀌지 않는다', () => {
  const TITLE = 'TASK-0007 개선 file.txt Node.js help@intranet.corp.example http://127.0.0.1:5173/report/1 내부.한국 1.2.3';
  const withTitle = () => {
    const s = emptySnapshot();
    s.done.push({ taskKey: 'TASK-0001', wbsPath: '1.1', title: TITLE, assignee: 'Claude', verifier: 'Codex', workType: 'Implementation', domain: 'FE', actStart: null, actEnd: '2026-10-27T01:00:00.000Z',
      estHours: 1, actualHours: 1, attempts: 1, slipDays: null, verification: null, checklist: { done: 1, total: 1 }, outputs: { delivered: 1, names: [] }, doneCond: '' } as unknown as ReportSnapshotData['done'][number]);
    return s;
  };
  const APP = 'http://127.0.0.1:5173/';
  test('내부 수신자 보고용: 작업 제목은 내부 용어만 빠지고(scrubInternal) 파일 이름 · 제품 이름 · 주소 · 버전은 그대로', () => {
    const m = renderMail({ projectName: 'P', report: report('weekly', withTitle()), view: 'ext', to: 'boss@example.com', appUrl: APP });
    expect(m.text).toContain(`• ${scrubInternal(TITLE)}`);
    expect(m.text).toContain('file.txt Node.js help@intranet.corp.example http://127.0.0.1:5173/report/1 내부.한국 1.2.3');
    expect(m.text).not.toContain('(링크 생략)');
    expect(m.text).not.toContain('(주소 생략)');
  });
  test('내부 수신자 팀장용: 작업 번호 · 제목이 원문 그대로', () => {
    const m = renderMail({ projectName: 'P', report: report('weekly', withTitle()), view: 'int', to: 'lead@example.com', appUrl: APP });
    expect(m.text).toContain(`TASK-0001 ${TITLE}`);
    expect(m.text).toContain('Agent WBS에서 전체 보고서 보기: http://127.0.0.1:5173/report/');
  });
  test('외부 수신자: 같은 제목이 외부 변환을 지나 검사기 0건', () => {
    const m = renderMail({ projectName: 'P', report: report('weekly', withTitle()), view: 'ext', to: 'outside@partner.example', appUrl: APP, external: true });
    expect(m.text).toMatch(/• 개선 (\((링크|주소) 생략\) )+/);
    for (const f of ['file.txt', 'Node.js', 'help@', 'intranet', '127.0.0.1', '내부.한국']) expect(m.text).not.toContain(f);
    // 숫자 사이 점(버전)은 보고 내용이라 남는다(fix5 후속).
    expect(m.text).toContain('1.2.3');
    expect(externalMailLeaks({ ...m, to: 'outside@partner.example' }, null)).toEqual([]);
  });
});
