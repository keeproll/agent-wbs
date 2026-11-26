import { describe, expect, test } from 'vitest';
import { Value } from 'typebox/value';
import { externalView, internalKpis, internalTerms, reportFigures, ReportSnapshotSchema as ReportSnapshot, scrubInternal, type ReportSnapshotData } from '@awbs/shared';

/** 빈 스냅샷에 필요한 칸만 채운다. */
type Patch = Partial<Omit<ReportSnapshotData, 'summary'>> & { summary?: Partial<ReportSnapshotData['summary']> };
function snap(patch: Patch = {}): ReportSnapshotData {
  const summary: ReportSnapshotData['summary'] = {
    taskCount: 5, doneCount: 3, doneBefore: 1, workPct: 52.5, workPctBefore: 20, baselineVersion: 2, forecast: '2026-11-10', lo: '2026-11-08', hi: '2026-11-14',
    forecastBefore: '2026-11-07', target: '2026-11-12', uptimePct: 75, ratePct: 60, blocked: 1, statuses: [], started: [],
    attempts: { total: 4, dev: 2, qa: 2, pass: 1, fail: 1, escalated: 1, interrupted: 0, tokens: 125_000 },
    ...patch.summary,
  };
  return { issues: [], series: [], done: [], active: [], failures: [], attempts: [], replans: [], gaps: [], messages: [], next: [], all: [], ...patch, summary };
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
