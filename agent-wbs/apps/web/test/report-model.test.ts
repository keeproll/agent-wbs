import { describe, expect, test } from 'vitest';
import { internalTerms, type ReportSnapshotData } from '@awbs/shared';
import {
  changedLabel, defaultView, externalDoc, formProblem, internalDoc, lateLabel, quickRange, rowView, type ReportRow,
} from '../src/features/report/model.ts';

const T = (kst: string) => new Date(`${kst}:00+09:00`).toISOString();
const empty: ReportSnapshotData = {
  summary: {
    taskCount: 0, doneCount: 0, doneBefore: 0, workPct: 0, workPctBefore: 0, baselineVersion: 0, forecast: null, lo: null, hi: null, forecastBefore: null,
    target: null, uptimePct: 0, ratePct: 0, blocked: 0, statuses: [], started: [],
    attempts: { total: 0, dev: 0, qa: 0, pass: 0, fail: 0, escalated: 0, interrupted: 0, tokens: 0 },
  },
  issues: [], series: [], done: [], active: [], failures: [], attempts: [], replans: [], gaps: [], messages: [], next: [], all: [],
};
const full: ReportSnapshotData = {
  ...empty,
  summary: { ...empty.summary, taskCount: 12, doneCount: 3, workPct: 18.2, statuses: [{ status: 'done', count: 3 }, { status: 'rework', count: 1 }], forecast: '2026-11-10', lo: '2026-11-08', hi: '2026-11-14', baselineVersion: 2,
    attempts: { total: 4, dev: 2, qa: 2, pass: 1, fail: 1, escalated: 0, interrupted: 0, tokens: 880_000 } },
  issues: [{ level: 'bad', text: '메시지 MSG-003 전달 실패 (TASK-0005)', taskKey: 'TASK-0005' }],
  series: [{ day: '2026-10-28', done: 2, attempts: 2, fails: 0, uptimePct: 100, forecast: '2026-11-07' }],
  done: [{ taskKey: 'TASK-0001', wbsPath: '1.1.1', title: 'Monorepo 구성', assignee: 'Claude', verifier: 'Codex', workType: 'Implementation', domain: 'DevOps',
    actStart: T('2026-10-28 14:02'), actEnd: T('2026-10-28 16:40'), estHours: 1.5, actualHours: 2, attempts: 2, slipDays: 0,
    verification: { id: 'v1', result: 'PASS', cmd: 'pnpm install', actual: '성공' }, checklist: { done: 3, total: 3, requiredLeft: 0 }, outputs: { delivered: 1, names: ['package.json'] }, doneCond: '빌드 통과' }],
  active: [{ taskKey: 'TASK-0007', wbsPath: '2.1.1', title: 'WBS Tree UI', assignee: 'Claude', verifier: 'Codex', workType: 'Implementation', domain: 'FE', status: 'rework', progressPct: 55,
    actStart: T('2026-11-01 10:02'), end: '2026-11-06', lo: '2026-11-05', hi: '2026-11-08', slipDays: 2, remainHours: 2.3,
    lastAttempt: { attemptKey: 'ATT-0007-2', kind: 'qa', agent: 'Codex', grade: { modelId: 'gpt-6.1-sol', effort: 'high' }, status: 'completed', summary: '필터 결함' },
    verification: { id: 'v2', result: 'FAIL', cmd: 'pnpm test', actual: '2건 실패' }, checklist: { done: 2, total: 4, requiredLeft: 1 },
    gate: { passed: 2, unmet: ['checklist', 'verification', 'defects'] }, blockingDefects: 2, blockers: [{ pred: 'TASK-0003', type: 'FS', status: 'running' }], next: 'Claude 재작업 → Codex 재검증' }],
  failures: [{ verificationId: 'v2', taskKey: 'TASK-0007', title: 'WBS Tree UI', agent: 'Codex', at: T('2026-11-01 13:35'), cmd: 'pnpm test', expected: '통과', actual: '2건 실패',
    defects: ['DEF-0007-1 상위 노드 누락'], evidence: ['evidence/a.txt'], messages: [{ msgKey: 'MSG-001', delivery: 'Acknowledged' }], reworks: [] }],
  attempts: [{ attemptKey: 'ATT-0001-1', taskKey: 'TASK-0001', kind: 'dev', agent: 'Claude', grade: { modelId: 'claude-sonnet-5-5', effort: 'low' }, startedAt: T('2026-10-28 14:02'),
    endedAt: T('2026-10-28 15:10'), status: 'completed', summary: '구성 완료', adjust: null, files: 3, tokens: 210_000 }],
  replans: [{ replanId: 'RP-002', at: T('2026-10-31 10:00'), trigger: 'QA FAIL', before: '2026-11-07', after: '2026-11-10', lo: '2026-11-08', hi: '2026-11-14',
    moved: [{ taskKey: 'TASK-0007', title: 'WBS Tree UI', kind: 'delayed', before: '2026-11-04', after: '2026-11-06', deltaDays: 2 }] }],
  gaps: [{ from: T('2026-10-29 22:00'), to: T('2026-10-30 01:00'), minutes: 180, reason: 'reboot' }],
  messages: [{ at: T('2026-11-01 14:02'), taskKey: 'TASK-0007', dir: 'out', agent: 'Claude', type: '수정 요청', delivery: 'Acknowledged', pendingNext: true, firstLine: '필터 수정' }],
  next: [{ taskKey: 'TASK-0008', wbsPath: '2.2.2', title: 'Task Detail UI', assignee: 'Codex', verifier: 'Claude', status: 'ready', start: '2026-11-03', end: '2026-11-04', estHours: 6,
    grade: { modelId: 'gpt-6.1-sol', effort: 'xhigh' }, blockers: [], conflictGroup: null }],
  all: [{ taskKey: 'TASK-0001', wbsPath: '1.1.1', title: 'Monorepo 구성', assignee: 'Claude', verifier: 'Codex', status: 'done', progressPct: 100, checklist: { done: 3, total: 3 }, verifState: 'pass', end: '2026-10-28', slipDays: null, blocked: false },
    { taskKey: 'TASK-0007', wbsPath: '2.1.1', title: 'WBS Tree UI', assignee: 'Claude', verifier: 'Codex', status: 'rework', progressPct: 55, checklist: { done: 2, total: 4 }, verifState: 'fail', end: '2026-11-06', slipDays: 2, blocked: true }],
};
const row = (patch: Partial<ReportRow> = {}): ReportRow => ({ id: 'r', reportKey: 'RPT-W-261026', kind: 'weekly', from: '2026-10-26', to: '2026-11-01', view: 'int',
  generatedAt: T('2026-11-04 07:00'), dueAt: T('2026-11-02 07:00'), reason: '서버 시작 시 누락분 보충', ...patch });

describe('목록 행(P rows L6375)', () => {
  test('주간: 종류 · 기간 · 생성 · 주체 · 보기 · 누락분 보충', () => {
    expect(rowView(row())).toMatchObject({ kindL: '주간', kindC: 'tag rk-w', periodL: '2026-10-26 ~ 2026-11-01', atL: '2026-11-04 07:00', byL: '시스템 (정기)', audL: '팀장용 · 보고용', late: true });
    expect(lateLabel(row())).toBe('서버 시작 시 누락분 보충 — 예정 2026-11-02 07:00');
  });
  test('일간·기간 지정', () => {
    expect(rowView(row({ kind: 'daily', from: '2026-10-28', to: '2026-10-28', reason: '정기 생성' }))).toMatchObject({ kindL: '일간', periodL: '2026-10-28', audL: '팀장용', late: false });
    expect(rowView(row({ kind: 'custom', reason: '팀장 지정', dueAt: null }))).toMatchObject({ kindL: '기간 지정', kindC: 'tag rk-c', byL: '팀장' });
  });
  test('보기: 일간은 팀장용 고정, 나머지는 고른 보기 또는 생성 때 보기', () => {
    expect(defaultView(row({ kind: 'daily', view: 'ext' }), 'ext')).toBe('int');
    expect(defaultView(row({ kind: 'custom', view: 'ext' }), undefined)).toBe('ext');
    expect(defaultView(row(), 'ext')).toBe('ext');
  });
});

describe('기간 지정 입력(P createReport L4991)', () => {
  const today = '2026-11-04';
  test.each([
    ['', '2026-11-01', '시작일과 종료일을 모두 입력하세요.'],
    ['2026-11-02', '2026-11-01', '시작일이 종료일보다 늦습니다.'],
    ['2026-11-01', '2026-11-05', '종료일은 오늘 이후일 수 없습니다.'],
    ['2026-08-03', '2026-11-04', '기간은 최대 93일입니다.'],
    ['2026-08-04', '2026-11-04', ''],
  ])('%s ~ %s → %s', (from, to, message) => { expect(formProblem(from, to, today)).toBe(message); });
  test('단축 기간: 이번 주 · 지난 주 · 최근 30일(오늘 11-04 수요일)', () => {
    expect(quickRange('thisWeek', today)).toEqual({ from: '2026-11-02', to: '2026-11-04' });
    expect(quickRange('lastWeek', today)).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(quickRange('last30', today)).toEqual({ from: '2026-10-06', to: '2026-11-04' });
  });
});

test('생성 이후 변경 안내(G L374)', () => {
  expect(changedLabel({ replans: 0, currentEnd: '2026-11-12', reportEnd: '2026-11-10' })).toBeNull();
  expect(changedLabel({ replans: 2, currentEnd: '2026-11-12', reportEnd: '2026-11-10' })).toBe('생성 이후 일정 재조정 2회 — 현재 완료 예상 2026-11-12 (보고서 기준 2026-11-10)');
});

describe('팀장용 보기(12섹션 값)', () => {
  const d = internalDoc(full);
  test('1 KPI·상태 분포·실행 요약', () => {
    expect(d.kpis.map((k) => k.value)).toEqual(['1건', '18.2%', '11-10', '0%']);
    // 상태 순서는 진행 순서(계획 → 완료)다.
    expect(d.statusLine).toBe('재작업 필요 1 · 완료 3');
    expect(d.execLine).toBe('실행 시도 4건 (개발 · 재작업 2 / QA · 재검증 2) · 검증 PASS 1 · FAIL 1 · 등급 자동 상향 0 · 중단 0 · 토큰 880K');
  });
  test('2 확인 필요', () => { expect(d.issues).toEqual([{ cls: 'sc sc-bad', label: '조치 필요', text: '메시지 MSG-003 전달 실패 (TASK-0005)', taskKey: 'TASK-0005' }]); });
  test('3 추세', () => { expect(d.series[0]).toMatchObject({ day: '10-28', up: '100%', atts: '2', done: '2', fails: '0', fc: '11-07' }); });
  test('4 완료 카드', () => {
    expect(d.done[0]).toMatchObject({
      cls: '구현 / DevOps', who: 'Claude 개발 · Codex 검증', act: '2026-10-28 14:02 ~ 2026-10-28 16:40', est: '1.5h → 실제 2h (시도 2회)', slip: '기준 내',
      verif: 'PASS · pnpm install → 성공', cl: '3 / 3 (필수 완료)', out: '1 / 1 제출 — package.json', cond: '빌드 통과',
    });
  });
  test('5 진행 중 카드: Gate 미충족 조건 · 이슈 · 다음 작업', () => {
    expect(d.active[0]).toMatchObject({
      st: '재작업 필요', pct: '55%', fc: '2026-11-06 (범위 11-05 ~ 11-08)', slip: '기준 대비 +2일', remain: '2.3h',
      last: 'ATT-0007-2 QA (Codex · gpt-6.1-sol · 높음, 완료) — 필터 결함', verif: 'FAIL — 2건 실패', cl: '2 / 4 (필수 1건 남음)',
      gate: '2 / 5 — 미충족: 필수 Checklist 완료, 필요한 Verification 통과, 미해결 차단 결함 없음',
      issue: '차단 결함 2건 · 선행 미충족: TASK-0003(FS, 실행 중)', next: 'Claude 재작업 → Codex 재검증',
    });
  });
  test('6 QA 실패', () => { expect(d.failures[0]).toMatchObject({ defects: 'DEF-0007-1 상위 노드 누락', ev: 'evidence/a.txt', follow: '수정 지시 MSG-001(수신 확인) · 재작업 시작 전' }); });
  test('7 실행 기록 표', () => { expect(d.attempts[0]).toMatchObject({ id: 'ATT-0001-1', task: 'TASK-0001 · 개발', grade: 'Claude · claude-sonnet-5-5 · 낮음', time: '10-28 14:02 ~ 15:10', st: '완료', files: '3개', tok: '210K' }); });
  test('8 재조정', () => { expect(d.replans[0]).toMatchObject({ ch: '2026-11-07 → 2026-11-10', range: '11-08 ~ 11-14', moved: [{ task: 'TASK-0007', title: 'WBS Tree UI', kind: '지연', ch: '11-04 → 11-06 (+2일)' }] }); });
  test('9 중단', () => { expect(d.gaps).toEqual([{ from: '10-29 22:00', to: '10-30 01:00', dur: '3시간', reason: '재부팅' }]); });
  test('10 메시지', () => { expect(d.messages[0]).toMatchObject({ at: '11-01 14:02', task: 'TASK-0007', dir: '팀장 → Claude', type: '수정 요청', st: '수신 확인 · 다음 실행 대기', body: '필터 수정' }); });
  test('11 예정', () => { expect(d.next[0]).toMatchObject({ per: '11-03 ~ 11-04', est: '6h', who: 'Codex 개발 · Claude 검증', grade: 'gpt-6.1-sol · 매우 높음', pre: '선행 충족', cg: '—', st: '실행 대기' }); });
  test('12 부록 전체 표', () => {
    expect(d.all.map((x) => [x.wbs, x.id, x.st, x.who, x.pct, x.cl, x.verif, x.fc, x.slip, x.blocked])).toEqual([
      ['1.1.1', 'TASK-0001', '완료', 'Claude/Codex', '100%', '3/3', 'PASS', '완료 10-28', '', false],
      ['2.1.1', 'TASK-0007', '재작업 필요', 'Claude/Codex', '55%', '2/4', 'FAIL', '11-06', '+2일', true],
    ]);
  });
});

describe('빈 상태', () => {
  test('팀장용: 빈 목록과 안내 기준', () => {
    const d = internalDoc(empty);
    expect([d.issues, d.series, d.done, d.active, d.failures, d.attempts, d.replans, d.gaps, d.messages, d.next, d.all]).toEqual([[], [], [], [], [], [], [], [], [], [], []]);
    expect(d.statusLine).toBe('Task 없음');
    expect(d.kpis[3]?.sub).toBe('중단 없음');
  });
  test('보고용: 내부 용어 없음 · 빈 상태 문장', () => {
    const e = externalDoc(full, 'weekly');
    expect(internalTerms(JSON.stringify(e))).toEqual([]);
    expect(e.highlights).toEqual(['Monorepo 구성']);
    expect(externalDoc(empty, 'weekly').plan).toEqual([]);
  });
});
