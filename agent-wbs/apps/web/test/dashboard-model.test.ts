import { describe, expect, it } from 'vitest';
import {
  alertLink, domainBars, gradeRows, panels, recentRows, schedCards, schedNote, taskKpis, typeBars, type AlertItem, type Dashboard,
} from '../src/features/dashboard/model.ts';

const schedule = {
  start: '2026-10-27', end: '2026-11-06', lo: '2026-11-06', hi: '2026-11-10', baselineVersion: 1, baselineEnd: '2026-11-06',
  firstBaselineEnd: '2026-11-06', target: '2026-12-18', slipDays: 0, slackDays: 42, elapsedDays: 9, remainingDays: 1,
  totalHours: 42, doneHours: 5.5, remainHours: 29.3, progressPct: 30, plannedPct: 54, doneRatePct: 25, doneHoursRatePct: 13,
  doneCount: 3, taskCount: 12, rate: 0.69,
} as NonNullable<Dashboard['schedule']>;

describe('대시보드 계산(UI-01, P dashVM L6274–6333)', () => {
  it('Task KPI 4개: 숫자와 WBS 필터 주소가 짝을 이룬다', () => {
    const k = taskKpis({ total: 12, done: 3, active: 3, blocked: 4 });
    expect(k.map((x) => [x.l, x.v, x.to, x.cls])).toEqual([
      ['전체 Task', '12', '/wbs', ''], ['완료', '3', '/wbs?status=done', 'ok'], ['진행 중', '3', '/wbs?status=active', 'run'], ['선행 차단', '4', '/wbs?blocked=y', 'bad'],
    ]);
    expect(k[0]?.sub).toBe('취소 제외 · 완료율 25%');
    expect(taskKpis({ total: 0, done: 0, active: 0, blocked: 0 })[3]?.cls).toBe('');
  });

  it('일정 카드 문구는 원본 스크린샷과 같다', () => {
    const c = schedCards(schedule);
    expect(c.map((x) => x.v)).toEqual(['30%', '25%', '11-06', '42h']);
    expect(c[0]?.sub).toBe('계획 54% 대비 -24%p');
    expect(c[0]?.subC).toBe('sc sc-bad');
    expect(c[1]?.sub).toBe('Task 3/12 · 공수 기준 13% (5.5h/42h)');
    expect(c[2]?.sub).toBe('범위 11-06 ~ 11-10 · 기준 11-06 이내 · 목표 12-18까지 여유 42일');
    expect(c[3]?.sub).toBe('잔여 29.3h · 관측 가동률 69% · 경과 9일 · 남은 기간 약 1일 · 최초 기준 v1 11-06');
    expect(schedCards(null)).toEqual([]);
  });

  it('일정 설명: 동시 실행 한도는 min(한도, 상한)', () => {
    const runner = { concurrency: { limit: 10, caps: { total: 16 } } } as never;
    expect(schedNote(schedule, runner)).toBe('프로젝트 2026-10-27 시작 · 관측 가동률 · 동시 실행 한도 10 (상한 16, 하위 Agent 포함) · 충돌 묶음 직렬화 · 작업 불가일 반영 · 진행률은 상태 단계 가중치 × 예상 실행 시간');
  });

  it('6행동 패널: 순서·빈 안내·위험 패널 숫자 색', () => {
    const p = panels({
      late: [], approvals: [{ kind: 'proposal', id: 'cp1', title: 'Dependency 검증', status: 'review' }],
      executions: [{ kind: 'running', taskKey: 'TASK-0004', title: 'Drizzle', attemptId: 'a4', attemptKind: 'qa', agent: 'Codex' }],
      rework: [{ taskKey: 'TASK-0007', title: 'WBS Tree UI', verificationId: 'v2', result: 'FAIL', defects: 2 }],
      gate: [{ taskKey: 'TASK-0009', title: 'G', unmet: ['outputs', 'approval'] }], messages: [],
    } as unknown as Dashboard['panels']);
    expect(p.map((x) => x.title)).toEqual(['일정 지연', 'Planning · 승인 대기', '실행 진행 · 대기', 'QA 실패 · 재작업', 'Completion Gate 미통과', '메시지 확인 필요']);
    expect(p[0]?.emptyT).toBe('지연 예상 Task가 없습니다.');
    expect(p[1]?.items[0]).toMatchObject({ tag: '승인 대기', tagC: 'cps c-review', to: '/change/cp1' });
    expect(p[1]?.nCls).toBe('bad');
    expect(p[2]?.items[0]).toMatchObject({ tag: 'QA · Codex', to: '/exec/TASK-0004?att=a4' });
    expect(p[2]?.nCls).toBe('');
    expect(p[3]?.items[0]).toMatchObject({ tag: 'FAIL · 결함 2', tagC: 'vf v-fail' });
    expect(p[4]?.items[0]).toMatchObject({ tag: '미충족 2 — 필수 산출물, 팀장 승인', to: '/wbs/TASK-0009?tab=checklist' });
  });

  it('분포 막대: 가장 큰 값이 100%, 0건은 흐리게, 누르면 WBS 필터', () => {
    const t = typeBars([{ key: 'Analysis', count: 1 }, { key: 'Implementation', count: 6 }, { key: 'Test', count: 0 }] as Dashboard['byWorkType']);
    expect(t.map((b) => [b.l, b.en, b.pct, b.cls, b.to])).toEqual([
      ['분석', 'Analysis', 17, 'bar-r', '/wbs?type=Analysis'], ['구현', 'Implementation', 100, 'bar-r', '/wbs?type=Implementation'], ['테스트', 'Test', 0, 'bar-r dim', '/wbs?type=Test'],
    ]);
    expect(domainBars([{ key: 'FE', count: 3 }] as Dashboard['byDomain'])[0]).toMatchObject({ l: 'FE', en: 'Frontend', to: '/wbs?domain=FE' });
  });

  it('등급 통계: 판정 전·30% 이상 경고·상향 열·토큰 K', () => {
    const g = gradeRows([
      { agent: 'Claude', modelId: 'opus', effort: 'high', attempts: 3, judged: 2, fails: 1, reworkRatePct: 50, escalations: 1, tokens: 120_000 },
      { agent: 'Codex', modelId: 'gpt', effort: 'medium', attempts: 1, judged: 0, fails: 0, reworkRatePct: null, escalations: 0, tokens: 800 },
    ] as Dashboard['grades']);
    expect(g.map((x) => [x.grade, x.rateL, x.rateC, x.esc, x.tok])).toEqual([
      ['opus · 높음', '50%', 'sc sc-bad', '1', '120K'], ['gpt · 보통', '판정 전', 'muted', '0', '1K'],
    ]);
  });

  it('최근 결과: 최신 8건, 실행은 작업 실행으로·검증은 검증 상세로', () => {
    const r = recentRows(Array.from({ length: 10 }, (_, i) => ({
      kind: i % 2 ? 'attempt' : 'verification', at: `2026-11-0${String(i)}T00:00:00.000Z`, id: `x${String(i)}`, taskKey: 'TASK-0007', agent: 'Codex', text: 't',
      ...(i % 2 ? { status: 'completed' } : { result: 'PASS' }),
    })) as unknown as Dashboard['recent']);
    expect(r).toHaveLength(8);
    expect(r[0]).toMatchObject({ kind: '실행', tag: '완료', to: '/exec/TASK-0007?att=x9' });
    expect(r[1]).toMatchObject({ kind: '검증', tag: 'PASS', to: '/verify?sel=x8' });
  });

  it('알림 이동: Task 알림은 그 Task 실행, 나머지는 해당 화면·설정 탭', () => {
    const a = (key: string, taskKey: string | null = null) => ({ id: '1', key, severity: 'warn', taskKey, target: null, text: 't', at: '2026-11-05T12:45:00.000Z' }) as AlertItem;
    expect(alertLink(a('rework-limit:abc', 'TASK-0007'))).toEqual({ to: '/exec/TASK-0007', label: 'TASK-0007 실행 보기' });
    expect(alertLink(a('input_history_rewritten')).to).toBe('/project');
    expect(alertLink(a('external-write-blocked')).to).toBe('/settings/runner');
    expect(alertLink(a('mail:fail')).to).toBe('/settings/report');
    // CI 알림(M7-05): 서버 target은 실행 id(ref 규칙 taskKey → id) → 그 실행 상세. 대상이 없으면 빌드·통합 목록
    expect(alertLink({ ...a('ci:buildFail|int|#9'), target: 'r-1' })).toEqual({ to: '/ci/r-1', label: '빌드 · 통합 보기' });
    expect(alertLink(a('ci:baseline|abc')).to).toBe('/ci');
  });
});
