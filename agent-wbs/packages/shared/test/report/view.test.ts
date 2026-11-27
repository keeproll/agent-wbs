import { describe, expect, test } from 'vitest';
import { Value } from 'typebox/value';
import { externalLeaks, externalText, externalView, normalizeExternal, parseSender, internalKpis, internalTerms, reportFigures, ReportSnapshotSchema as ReportSnapshot, scrubInternal, type ReportSnapshotData } from '@awbs/shared';

/** 빈 스냅샷에 필요한 칸만 채운다. */
type Patch = Partial<Omit<ReportSnapshotData, 'summary'>> & { summary?: Partial<ReportSnapshotData['summary']> };
function snap(patch: Patch = {}): ReportSnapshotData {
  const summary: ReportSnapshotData['summary'] = {
    taskCount: 5, doneCount: 3, doneBefore: 1, workPct: 52.5, workPctBefore: 20, baselineVersion: 2, forecast: '2026-11-10', lo: '2026-11-08', hi: '2026-11-14',
    forecastBefore: '2026-11-07', target: '2026-11-12', uptimePct: 75, ratePct: 60, blocked: 1, statuses: [], started: [],
    attempts: { total: 4, dev: 2, qa: 2, pass: 1, fail: 1, escalated: 1, interrupted: 0, tokens: 125_000 },
    ...patch.summary,
  };
  return { projectName: '시험 프로젝트', projectNameStatus: 'snapshot', issues: [], series: [], done: [], active: [], failures: [], attempts: [], replans: [], gaps: [], messages: [], next: [], all: [], ...patch, summary };
}
const doneTask = (taskKey: string, title: string) => ({
  taskKey, wbsPath: '1.1.1', title, assignee: 'Claude' as const, verifier: 'Codex' as const, workType: 'Implementation' as const, domain: 'BE' as const,
  actStart: '2026-10-27T01:00:00.000Z', actEnd: '2026-10-28T01:00:00.000Z', estHours: 3, actualHours: 2.5, attempts: 2, slipDays: 0,
  verification: null, checklist: { done: 1, total: 1, requiredLeft: 0 }, outputs: { delivered: 1, names: ['a.ts'] }, doneCond: '테스트 통과',
});

test('테스트 스냅샷은 계약 스키마(ReportSnapshot)에 맞다', () => {
  expect(Value.Check(ReportSnapshot, snap())).toBe(true);
});

describe('팀장용·보고용 핵심 숫자는 같은 스냅샷에서 온다(milestones §4.0)', () => {
  const s = snap({ done: [doneTask('TASK-0001', '로그인 화면'), doneTask('TASK-0002', 'Task API')], gaps: [{ from: '2026-10-27T10:00:00.000Z', to: '2026-10-27T13:00:00.000Z', minutes: 180, reason: 'reboot' }] });
  test('계산값', () => {
    expect(reportFigures(s)).toMatchObject({ doneInPeriod: 2, doneTotal: 3, taskCount: 5, forecastDeltaDays: 3, slackDays: 2, gapHours: 3 });
  });
  test('팀장용 KPI 4개', () => {
    expect(internalKpis(s).map((k) => [k.label, k.value])).toEqual([
      ['완료 (기간)', '2건'], ['작업량 기준 완료율', '52.5%'], ['완료 예상 (기준 v2)', '11-10'], ['가동률 (기간)', '75%'],
    ]);
    expect(internalKpis(s)[2]?.sub).toBe('범위 11-08 ~ 11-14 · 기간 시작 대비 +3일 지연');
  });
  test('보고용 KPI 4개: 같은 숫자를 다른 이름으로', () => {
    const ext = externalView(s, 'weekly');
    expect(ext.kpis.map((k) => [k.label, k.value])).toEqual([
      ['완료', '2건'], ['진척률 (작업량)', '52.5%'], ['완료 예상일', '2026-11-10'], ['목표일 대비', '여유 2일'],
    ]);
    expect(ext.summary[0]).toBe('기간 중 2건 완료, 누적 3 / 5건 (작업량 기준 52.5%, 기간 시작 20%).');
    expect(ext.summary[1]).toBe('완료 예상일은 2026-11-10 (범위 11-08 ~ 11-14), 기간 시작 대비 +3일 지연 — 목표일(2026-11-12)까지 여유 2일.');
    expect(ext.summary[2]).toBe('품질 검증에서 1건이 기준을 통과하지 못해 보완 작업을 진행했고, 1건은 통과했습니다.');
    expect(ext.summary[3]).toBe('작업 환경 중단이 총 3시간 있었으며(재부팅 · 전원 꺼짐 등), 일정에 자동 반영했습니다.');
    expect(ext.highlights).toEqual(['로그인 화면', 'Task API']);
  });
});

describe('보고용은 내부 용어(Task ID·시도·모델/Effort·토큰·RP 번호)를 쓰지 않는다(G L396)', () => {
  test('검사기 자체: 내부 용어를 찾아낸다', () => {
    expect(internalTerms('TASK-0007 완료, RP-003 반영, ATT-0007-2 실행, claude-opus-5-5 · Effort 높음, 토큰 12K')).toEqual(
      expect.arrayContaining(['TASK-0007', 'RP-003', 'ATT-0007-2', 'claude-opus-5-5', 'Effort', '토큰']));
    expect(internalTerms('기간 중 2건 완료')).toEqual([]);
  });
  test('값이 가득한 스냅샷의 보고용 문장에 내부 용어 0건', () => {
    const s = snap({
      done: [doneTask('TASK-0001', '로그인 화면')],
      next: [{ taskKey: 'TASK-0003', wbsPath: '1.2', title: '보고서 화면', assignee: 'Codex', verifier: 'Claude', status: 'ready', start: '2026-11-03', end: '2026-11-04', estHours: 4,
        grade: { modelId: 'gpt-6.1-sol', effort: 'high' }, blockers: [{ pred: 'TASK-0002', type: 'FS', status: 'running' }], conflictGroup: 'FE' }],
      series: [{ day: '2026-10-27', done: 1, attempts: 3, fails: 1, uptimePct: 80, forecast: '2026-11-10' }],
      summary: { forecast: '2026-11-20', target: '2026-11-12' },
    });
    const ext = externalView(s, 'weekly');
    const text = JSON.stringify(ext);
    expect(internalTerms(text)).toEqual([]);
    expect(ext.plan).toEqual(['보고서 화면 (11-03 ~ 11-04)']);
    expect(ext.risks).toContain('목표일 초과 예상 — 범위 조정 또는 일정 협의 필요');
    expect(ext.trend).toEqual([{ day: '2026-10-27', uptimePct: 80, done: 1, forecast: '2026-11-10' }]);
  });
  test('빈 스냅샷: 빈 상태 문장', () => {
    const ext = externalView(snap({ summary: { forecast: null, lo: null, hi: null, forecastBefore: null, target: null, attempts: { total: 0, dev: 0, qa: 0, pass: 0, fail: 0, escalated: 0, interrupted: 0, tokens: 0 } } }), 'daily');
    expect(ext.summary[1]).toBe('완료 예상일을 아직 산정하지 않았습니다.');
    expect(ext.summary[2]).toBe('기간 중 품질 검증 결과는 없습니다.');
    expect(ext.summary[3]).toBe('작업 환경 중단 없이 진행했습니다.');
    expect(ext.risks).toEqual(['선행 작업 대기 1건 — 선행 완료 후 순차 진행']);
    expect(ext.highlights).toEqual([]);
    expect(ext.plan).toEqual([]);
  });
});

describe('리뷰 3: 보고용에 들어가는 자유 입력(작업 제목·프로젝트 이름)에서도 내부 용어를 뺀다(G L396)', () => {
  const bad = 'TASK-0007 RP-002 gpt-5 Effort 토큰 실행 시도 개선';
  test('제목의 내부 용어만 빼고 나머지 말은 남긴다', () => {
    expect(scrubInternal(bad)).toBe('개선');
    expect(scrubInternal('로그인 화면 (claude-opus-5-5로 구현)')).toBe('로그인 화면 (로 구현)');
    expect(scrubInternal('TASK-0001')).toBe('(제목 비공개)');
    expect(scrubInternal('일반 제목')).toBe('일반 제목');
  });
  test('완료 항목·다음 계획에 내부 용어가 섞인 제목이 있어도 보고용 출력은 0건', () => {
    const s = snap({
      done: [doneTask('TASK-0001', bad)],
      next: [{ taskKey: 'TASK-0003', wbsPath: '1.2', title: `${bad} 2단계`, assignee: 'Codex', verifier: 'Claude', status: 'ready', start: '2026-11-03', end: '2026-11-04', estHours: 4,
        grade: null, blockers: [], conflictGroup: null }],
    });
    const ext = externalView(s, 'weekly');
    expect(internalTerms(JSON.stringify(ext))).toEqual([]);
    expect(ext.highlights).toEqual(['개선']);
    expect(ext.plan).toEqual(['개선 2단계 (11-03 ~ 11-04)']);
  });
});

describe('기간 말 재구성: 그 시점 상태를 되살릴 수 없으면 「기록 없음」(owner 2026-11-27 아이템 13)', () => {
  const missing = snap({ basis: { asOf: '2026-11-01T15:00:00.000Z', stateFrom: '2026-11-09T15:00:00.000000Z', missing: ['state'] } });
  test('팀장용: 상태에서 나온 지표(완료·작업량)는 숫자 대신 기록 없음', () => {
    const k = internalKpis(missing);
    expect([k[0]?.value, k[1]?.value]).toEqual(['기록 없음', '기록 없음']);
    expect(k[0]?.sub).toBe('상태 기록 시작(2026-11-10) 전 시점');
  });
  test('보고용: 지어낸 숫자 문장 대신 기록 없음 문장', () => {
    const e = externalView(missing, 'weekly');
    expect([e.kpis[0]?.value, e.kpis[1]?.value]).toEqual(['기록 없음', '기록 없음']);
    expect(e.summary[0]).toBe('이 기간 끝 시점의 진행 현황은 기록이 없어 산정하지 않았습니다(상태 기록 시작 2026-11-10).');
    expect(e.risks).not.toContain('특이 위험 없음');
  });
  test('기록이 있으면 지금과 같다', () => {
    expect(internalKpis(snap())[0]?.value).toBe('0건');
  });
});

describe('Q-13 fix2: 외부 글은 주소 모양을 모두 「(링크 생략)」으로(변환 함수 하나 · 검사기 같은 기준)', () => {
  test('주소처럼 보이는 것은 어느 서버든 통째로 바꾼다', () => {
    expect(externalText('TASK-0007 개선 http://127.0.0.1:5173/settings/report')).toBe('개선 (링크 생략)');
    for (const a of ['https://wbs.corp.example/report/1', 'https://example.org/spec', 'ftp://files.example.org/a', '//cdn.example.org/x', 'www.example.org', 'www.example.org/x',
      '[::1]:5173/report', '127.0.0.1', '10.0.0.5/x', 'localhost:5173', 'wbs.corp.example:443', '127.1:5173/x', 'wbs.corp.example/report/1', 'example.org/spec', '/report/abc', '/settings']) {
      expect(externalText(`앞 ${a} 뒤`), a).toBe('앞 (링크 생략) 뒤');
    }
    expect(externalText('설정 → 보고서 · 메일 안내 개선')).toBe('안내 개선');
    expect(externalText('http://127.0.0.1:5173/')).toBe('(링크 생략)');
  });
  test('주소가 아닌 업무 문장 · 시각 · 날짜 · 메일 주소는 그대로 둔다', () => {
    for (const t of ['누적 0 / 0', 'A/B 시험', '보고서/결과 정리', '생성 2026-11-04 07:00 · RPT-W-261026', '10.5% 진척', '기간 2026-10-26 ~ 2026-11-01', '수신: partner@outside.example', 'API 문서 갱신', '<b>굵게</b>']) {
      expect(externalText(t), t).toBe(t);
    }
  });
  test('scrubInternal은 같은 함수다', () => {
    expect(scrubInternal('TASK-0007 개선 http://localhost:5173/report/1')).toBe(externalText('TASK-0007 개선 http://localhost:5173/report/1'));
  });
  test('검사기는 변환 전에는 찾고, 변환 뒤에는 0건이다', () => {
    const dirty = 'TASK-0007 RP-002 Effort 토큰 개선 https://example.org/spec /settings/report 설정 → 알림 <a href="x"> 127.1:5173';
    expect(externalLeaks(dirty)).toEqual(expect.arrayContaining(['TASK-0007', 'RP-002', 'Effort', '토큰', 'https://example.org/spec', '/settings/report', '설정 → 알림', 'href=', '127.1:5173']));
    expect(externalLeaks(externalText(dirty))).toEqual([]);
  });
  test('보고용 보기(화면 · PDF)의 작업 제목도 같은 함수를 지난다', () => {
    const s = snap({ done: [doneTask('TASK-0001', '개선 https://wbs.corp.example/report/1')] });
    expect(externalView(s, 'weekly').highlights).toEqual(['개선 (링크 생략)']);
  });

  /**
   * Codex 재리뷰 지적 1 재현: 같은 앱 주소의 다른 표기. 표준 URL 해석기로 보면 앱 주소와 같은 곳이다.
   * 기준을 검사기의 정규식에만 두지 않으려고, 먼저 URL 해석으로 「정말 앱 주소」인지 확인한 뒤 변환 · 검사 결과를 본다.
   */
  test.each([
    ['http://127.1:5173/report/abc', 'http://127.0.0.1:5173/'],
    ['http://2130706433:5173/report/abc', 'http://127.0.0.1:5173/'],
    ['http://[0:0:0:0:0:0:0:1]:5173/report/abc', 'http://[::1]:5173/'],
    ['https://%77bs.corp.example/report/abc', 'https://wbs.corp.example/'],
  ])('재리뷰 재현: %s', (address, app) => {
    expect(new URL(address).origin).toBe(new URL(app).origin);
    const out = externalText(`TASK-0007 개선 ${address}`, app);
    expect(out).toBe('개선 (링크 생략)');
    expect(externalLeaks(out, app)).toEqual([]);
    expect(externalLeaks(address, app).length).toBeGreaterThan(0);
  });
  test.each(['https://notwbs.corp.example.org/spec', 'https://localhost.example.org/spec', 'https://other.example.org/spec?source=wbs.corp.example'])(
    '재리뷰 재현(외부 주소를 자르지 않음): %s → 조각이 남지 않고 통째로 바뀐다', (address) => {
      expect(externalText(`참고 ${address} 반영`, 'https://wbs.corp.example/')).toBe('참고 (링크 생략) 반영');
    });
});



/**
 * Q-13 fix3: 정규화 뒤 판정(Codex 재리뷰 3-2). 리뷰어 재현과 인코딩 변형을 표로 둔다.
 * 기준은 정규식만이 아니다: 각 입력을 표준 URL 해석기로 읽어 원래 주소(호스트)를 먼저 확인한다.
 */
describe('Q-13 fix3: 외부 글은 정규화한 뒤 주소 모양을 판정하고, 출력도 정규화한 글이다', () => {
  // [입력, 표준 URL 해석의 호스트, 설명]
  const VARIANTS: [string, string, string][] = [
    ['192。168。0。10:5173/report/abc', '192.168.0.10', 'U+3002 점(재리뷰 재현 · 실제 발송)'],
    ['wbs。corp。example/report/abc', 'wbs.corp.example', 'U+3002 점'],
    ['wbs．corp．example/report/abc', 'wbs.corp.example', 'U+FF0E 전각 점'],
    ['wbs｡corp｡example/report/abc', 'wbs.corp.example', 'U+FF61 반각 점'],
    ['wbs%2Ecorp%2Eexample/report/abc', 'wbs.corp.example', '퍼센트 인코딩 점'],
    ['wbs%252Ecorp%252Eexample/report/abc', 'wbs.corp.example', '두 번 퍼센트 인코딩'],
    ['wbs&#46;corp&#x2e;example/report/abc', 'wbs.corp.example', 'HTML 숫자 기호 점'],
    ['wbs&period;corp&period;example/report/abc', 'wbs.corp.example', 'HTML 이름 기호 점'],
    ['wbs​.corp.‍example/report/abc', 'wbs.corp.example', '폭 없는 글자 끼움'],
    ['ｗｂｓ．ｃｏｒｐ．ｅｘａｍｐｌｅ／ｒｅｐｏｒｔ', 'wbs.corp.example', '전각 영문 전체'],
    ['https%3A%2F%2Fwbs%2Ecorp%2Eexample%2Freport%2Fabc', 'wbs.corp.example', '주소 전체 퍼센트 인코딩'],
  ];
  test.each(VARIANTS)('%s → 「(링크 생략)」, 검사기 0건 (%s · %s)', (input, host) => {
    const asUrl = normalizeExternal(input).replace(/^(?!https?:)/, 'http://');
    // 표준 URL 해석기로 본 호스트(정규식과 따로 세운 기준)
    expect(new URL(asUrl).hostname).toBe(host);
    expect(externalLeaks(input).length).toBeGreaterThan(0);
    const out = externalText(`앞 ${input} 뒤`);
    expect(out).toBe('앞 (링크 생략) 뒤');
    expect(externalLeaks(out)).toEqual([]);
  });
  test('출력은 정규화한 글이다(원문 표기가 아니라)', () => {
    expect(externalText('프로젝트。완료 ｢보고｣')).toBe(normalizeExternal('프로젝트。완료 ｢보고｣'));
    expect(externalText('프로젝트。완료')).toBe('프로젝트.완료');
  });
  test('정규화해도 업무 문장 · 퍼센트 · 시각 · 날짜는 그대로다', () => {
    for (const t of ['진척 10% · 누적 0 / 0', '생성 2026-11-04 07:00', '기간 2026-10-26 ~ 2026-11-01', 'A/B 시험', '보고서 개선 완료']) expect(externalText(t), t).toBe(t);
  });
  test('메일 헤더 인코딩 문법(=?…?=)은 외부 글에서 빠지고 검사기가 찾는다', () => {
    expect(externalLeaks('=?UTF-8?B?VEFTSy0wMDA3?=').length).toBeGreaterThan(0);
    expect(externalText('이름 =?UTF-8?Q?TASK=2D0007?= 끝')).toBe('이름 끝');
  });
  test('버전 번호(숫자 세 덩이)도 IP 모양이라 생략된다 — 정보 손실로 받아들임(조정자 판단)', () => {
    expect(externalText('버전 1.2.3 배포')).toBe('버전 (링크 생략) 배포');
  });
});

/** Q-13 fix3: 보내는 사람 허용 목록(Codex 재리뷰 3-1 재현). 해석할 수 없으면 null — 빈 이름으로 통과시키지 않는다. */
describe('Q-13 fix3: 보내는 사람은 허용 목록으로만 읽는다', () => {
  test.each([
    ['Agent WBS <agent-wbs@example.com>', { name: 'Agent WBS', address: 'agent-wbs@example.com' }],
    ['에이전트 보고-1 <a@example.com>', { name: '에이전트 보고-1', address: 'a@example.com' }],
    ['agent-wbs@example.com', { name: '', address: 'agent-wbs@example.com' }],
    [`${'가'.repeat(40)} <a@example.com>`, { name: '가'.repeat(40), address: 'a@example.com' }],
  ])('허용: %s', (from, expected) => { expect(parseSender(from)).toEqual(expected); });
  test.each([
    ['=?UTF-8?B?VEFTSy0wMDA3?= <agent@example.com>', 'B 방식 인코딩(재리뷰 재현)'],
    ['=?UTF-8?Q?TASK=2D0007?= <agent@example.com>', 'Q 방식 인코딩(재리뷰 재현)'],
    ['agent@example.com (TASK-0007)', '주석 표기(재리뷰 재현)'],
    ['TASK-0007 agent@example.com', '꺾쇠 없는 이름(재리뷰 재현)'],
    ['"TASK-0007\nhttp://127.0.0.1:5173/settings/report" <agent@example.com>', '줄바꿈(재리뷰 재현)'],
    ['"Agent WBS" <a@example.com>', '따옴표'],
    ['TASK-0007 <a@example.com>', '허용 글자지만 내부 용어'],
    ['Agent.WBS <a@example.com>', '점'],
    ['ａｇｅｎｔ <a@example.com>', '전각 영문'],
    [`${'가'.repeat(41)} <a@example.com>`, '41자'],
    ['<a@example.com>', '꺾쇠만 있고 이름 없음'],
    ['Agent <a@example.com>, B <b@example.com>', '주소 둘'],
    ['Agent <not-an-address>', '주소 형식 아님'],
  ])('거부: %s (%s)', (from) => { expect(parseSender(from)).toBeNull(); });
});

/** Q-13 fix3 후속: 스킴 · 포트 · 경로가 없는 맨 호스트도 주소 모양이다(내부 호스트 이름 유출 방지). */
describe('Q-13 fix3 후속: 맨 호스트(이름.이름…, 마지막 이름 글자 2자 이상)', () => {
  test.each([
    ['wbs.corp.example', '재리뷰 §4 한계 사례'],
    ['wbs。corp。example', '정규화 뒤 같은 호스트'],
    ['intranet.local', '로컬 호스트'],
    ['a-b.example.org', '하이픈 이름'],
    ['WBS.Corp.Example', '대문자'],
    ['www.\nexample.org', '줄바꿈으로 끊긴 www(재리뷰 §4)'],
    ['file.txt', '파일 이름 — 정보 손실 수용(조정자 판단)'],
    ['Node.js', '점 있는 제품 이름 — 정보 손실 수용'],
  ])('%s → 「(링크 생략)」, 검사기가 찾고 변환 뒤 0건 (%s)', (host) => {
    expect(externalLeaks(host).length).toBeGreaterThan(0);
    const out = externalText(`앞 ${host} 뒤`);
    expect(out).toBe('앞 (링크 생략) 뒤');
    expect(externalLeaks(out)).toEqual([]);
  });
  test.each(['first.last@example.com', 'partner@outside.example', '10.5% 진척', 'v1.2.3 배포', 'e.g. 예시', 'RPT-W-261026_보고용.pdf', '프로젝트.완료', 'Verum-SDN Agent WBS'])(
    '주소가 아닌 것은 그대로: %s', (t) => { expect(externalText(t)).toBe(t); expect(externalLeaks(t)).toEqual([]); });
});
