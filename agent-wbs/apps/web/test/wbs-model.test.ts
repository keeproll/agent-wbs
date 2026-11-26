import { describe, expect, it } from 'vitest';
import { bulkList, NODES, SCHEDULE, TASKS } from '../e2e/support/wbs-fixture.ts';
import {
  buildRows, COLS, DEFAULT_COLS, EMPTY_FILTERS, filterCount, ganttGeometry, gridColumns, isFilterActive, railItems,
  scheduleLine, serverQuery, taskCells, wbsSubtitle, wizardErrors, wizardMissing, type Filters, type ViewState,
} from '../src/features/wbs/model.ts';

const view = (patch: Partial<ViewState> = {}): ViewState => ({ search: '', filters: { ...EMPTY_FILTERS }, sort: 'wbs', collapsed: new Set(), ...patch });
const withFilter = (patch: Partial<Filters>) => view({ filters: { ...EMPTY_FILTERS, ...patch } });
const taskKeys = (rows: ReturnType<typeof buildRows>['rows']) => rows.flatMap((r) => (r.kind === 'task' ? [r.task.taskKey] : []));
const groupPaths = (rows: ReturnType<typeof buildRows>['rows']) => rows.flatMap((r) => (r.kind === 'group' ? [r.node.wbsPath] : []));

describe('WBS 표 행 만들기(UI-03B, UAT-WBS-01·02)', () => {
  it('필터가 없으면 Phase → WP → Task 순서로 모든 행을 만든다', () => {
    const { rows, taskCount, active } = buildRows(NODES, TASKS, view());
    expect(active).toBe(false);
    expect(taskCount).toBe(12);
    expect(groupPaths(rows)).toEqual(['1', '1.1', '1.2', '2', '2.1', '2.2', '3', '3.1', '3.2']);
    expect(rows.slice(0, 4).map((r) => (r.kind === 'group' ? r.node.wbsPath : r.task.taskKey))).toEqual(['1', '1.1', 'TASK-0001', 'TASK-0002']);
  });

  it('필터 결과에는 매칭 Task의 상위 Phase·WP만 함께 보인다', () => {
    const { rows, taskCount, active } = buildRows(NODES, TASKS, withFilter({ agent: 'Codex' }));
    expect(active).toBe(true);
    expect(taskKeys(rows)).toEqual(['TASK-0003', 'TASK-0010', 'TASK-0012']);
    expect(groupPaths(rows)).toEqual(['1', '1.2', '3', '3.1', '3.2']);
    expect(taskCount).toBe(3);
  });

  it('8개 선택 필터가 모두 함께 적용된다', () => {
    expect(taskKeys(buildRows(NODES, TASKS, withFilter({ type: 'Design' })).rows)).toEqual(['TASK-0004', 'TASK-0010', 'TASK-0012']);
    // 기술 영역은 주 영역 또는 관련 영역
    expect(taskKeys(buildRows(NODES, TASKS, withFilter({ domain: 'DB' })).rows)).toEqual(['TASK-0002', 'TASK-0003', 'TASK-0004', 'TASK-0009']);
    expect(taskKeys(buildRows(NODES, TASKS, withFilter({ status: 'active' })).rows)).toEqual(['TASK-0004', 'TASK-0005', 'TASK-0007']);
    expect(taskKeys(buildRows(NODES, TASKS, withFilter({ priority: '0' })).rows)).toEqual(['TASK-0003', 'TASK-0004', 'TASK-0005', 'TASK-0012']);
    expect(taskKeys(buildRows(NODES, TASKS, withFilter({ phase: 'PH-3' })).rows)).toEqual(['TASK-0010', 'TASK-0011', 'TASK-0012']);
    expect(taskKeys(buildRows(NODES, TASKS, withFilter({ blocked: 'y' })).rows)).toEqual(['TASK-0006', 'TASK-0008', 'TASK-0009', 'TASK-0011']);
    expect(taskKeys(buildRows(NODES, TASKS, withFilter({ blocked: 'n', verif: 'pass' })).rows)).toEqual(['TASK-0001', 'TASK-0002', 'TASK-0003']);
    expect(taskKeys(buildRows(NODES, TASKS, withFilter({ agent: 'Claude', domain: 'FE', blocked: 'n' })).rows)).toEqual(['TASK-0007']);
  });

  it('상태 필터 한 가지와 검색어는 서버 조회 조건으로 보낸다(「진행 중」 묶음은 화면에서 거른다)', () => {
    expect(serverQuery(view({ search: ' task-0004 ' , filters: { ...EMPTY_FILTERS, status: 'qa' } }))).toEqual({ q: 'task-0004', status: 'qa' });
    expect(serverQuery(withFilter({ status: 'active' }))).toEqual({});
    expect(serverQuery(view())).toEqual({});
  });

  it('서버가 거른 상태·검색 결과는 화면에서 다시 거르지 않는다(이전 목록 유지 규칙)', () => {
    // 서버 응답이 오기 전 이전 목록을 그대로 보여 줘야 하므로 status·q는 화면에서 거르지 않는다.
    const { rows } = buildRows(NODES, TASKS, view({ search: 'Drizzle', filters: { ...EMPTY_FILTERS, status: 'qa' } }));
    expect(taskKeys(rows)).toHaveLength(12);
  });

  it('검색어나 필터가 있으면 「필터 결과」, 필터 개수는 선택 필터 수', () => {
    expect(isFilterActive(view({ search: 'x' }))).toBe(true);
    expect(filterCount(withFilter({ agent: 'Codex', status: 'qa' }))).toBe(2);
  });

  it('정렬은 Work Package 안에서만 적용된다', () => {
    const { rows } = buildRows(NODES, TASKS, view({ sort: 'priority' }));
    expect(taskKeys(rows).slice(4, 9)).toEqual(['TASK-0005', 'TASK-0006', 'TASK-0007', 'TASK-0008', 'TASK-0009']);
    const byStatus = taskKeys(buildRows(NODES, TASKS, view({ sort: 'status' })).rows);
    // WP-04: rework(0007) · ready(0008) · planning(0009) → 계획 중 · 실행 대기 · 재작업 순
    expect(byStatus.slice(6, 9)).toEqual(['TASK-0009', 'TASK-0008', 'TASK-0007']);
    const byUpdated = taskKeys(buildRows(NODES, TASKS, view({ sort: 'updated' })).rows);
    expect(byUpdated.slice(0, 2)).toEqual(['TASK-0002', 'TASK-0001']);
  });

  it('접힌 그룹은 그룹 행만 남고 Task 수에는 포함된다', () => {
    const { rows, taskCount } = buildRows(NODES, TASKS, view({ collapsed: new Set(['PH-1', 'WP-04']) }));
    expect(groupPaths(rows)).toEqual(['1', '2', '2.1', '2.2', '3', '3.1', '3.2']);
    expect(taskKeys(rows)).not.toContain('TASK-0007');
    expect(taskCount).toBe(12);
  });

  it('그룹 집계: 완료 수·예상 시간·진행률·완료 예상(기준 대비)', () => {
    const { rows } = buildRows(NODES, TASKS, view());
    const ph1 = rows[0];
    if (ph1?.kind !== 'group') throw new Error('Phase 행 없음');
    expect(ph1.agg).toBe('완료 3/4 · 예상 9.5h · 진행률 85%');
    expect(ph1.win).toEqual({ text: '완료 예상 11-05 (기준 11-05)', cls: 'sc sc-none' });
    const wp1 = rows[1];
    if (wp1?.kind !== 'group') throw new Error('WP 행 없음');
    expect(wp1.agg).toBe('완료 2/2 · 예상 2.5h · 진행률 100%');
  });

  it('1,000행도 모든 Task 행을 만든다(가상 스크롤의 원본 목록)', () => {
    const big = bulkList(1000);
    const { rows, taskCount } = buildRows(big.nodes, big.tasks, view());
    expect(taskCount).toBe(1000);
    expect(rows.filter((r) => r.kind === 'task')).toHaveLength(1000);
  });
});

describe('컬럼 설정(UI-03A)', () => {
  it('기본 8컬럼과 선택 「최근 변경」', () => {
    expect(COLS.map((c) => c.key)).toEqual(['kind', 'agent', 'status', 'priority', 'preds', 'pct', 'plan', 'est', 'updated']);
    expect([...DEFAULT_COLS]).toEqual(['kind', 'agent', 'status', 'priority', 'preds', 'pct', 'plan', 'est']);
  });
  it('grid 폭은 원본 값(P L2943–2948) 그대로', () => {
    expect(gridColumns(new Set(['kind', 'est']))).toBe('60px minmax(200px,2.4fr) minmax(100px,.7fr) minmax(100px,.55fr)');
  });
});

describe('Task 셀 표시(P taskRow L5159)', () => {
  const byKey = new Map(TASKS.map((t) => [t.taskKey, t]));
  const sched = new Map(SCHEDULE.tasks.map((t) => [t.taskKey, t]));
  const cells = (key: string) => {
    const task = byKey.get(key);
    if (!task) throw new Error(key);
    return taskCells(task, byKey, sched.get(key));
  };
  it('차단: 미완료 선행 표시', () => {
    expect(cells('TASK-0006').preds).toEqual({ kind: 'blocked', label: 'TASK-0005', tip: 'TASK-0005 Task CRUD API — 실행 중' });
    expect(cells('TASK-0008').preds).toMatchObject({ kind: 'blocked', label: 'TASK-0005 외 1' });
    expect(cells('TASK-0004').preds).toMatchObject({ kind: 'ok', count: 2 });
    expect(cells('TASK-0001').preds).toEqual({ kind: 'none' });
  });
  it('일정: 완료·진행·미착수 문구', () => {
    expect(cells('TASK-0001').plan).toMatchObject({ planL: '10-28 완료', scL: '기준 내 완료', scC: 'sc sc-ok', rangeL: '실제' });
    expect(cells('TASK-0004').plan).toMatchObject({ planL: '11-05', scL: '진행 · 기준 일정', rangeL: '범위 11-05 ~ 11-06' });
    expect(cells('TASK-0006').plan).toMatchObject({ planL: '11-06', scL: '기준 일정', scC: 'sc sc-none' });
    expect(cells('TASK-0004').est).toEqual({ estL: '4h', estR: '3~6h' });
    expect(cells('TASK-0009').checklist).toBe('—');
    expect(cells('TASK-0004').agent).toEqual({ name: 'Claude', init: 'Cl', cls: 'ag-mk ag-claude' });
  });
});

describe('Task 레일(UI-03D)', () => {
  it('접힘과 상관없이 필터에 맞는 Task를 WP 구분선과 함께 모두 보인다', () => {
    const items = railItems(NODES, TASKS, view({ collapsed: new Set(['PH-1']), filters: { ...EMPTY_FILTERS, agent: 'Codex' } }));
    expect(items).toEqual([
      { kind: 'wp', key: 'WP-02', label: '1.2 데이터 모델' },
      { kind: 'task', key: 'TASK-0003', task: expect.objectContaining({ taskKey: 'TASK-0003' }) },
      { kind: 'wp', key: 'WP-05', label: '3.1 Planning · Gate' },
      { kind: 'task', key: 'TASK-0010', task: expect.objectContaining({ taskKey: 'TASK-0010' }) },
      { kind: 'wp', key: 'WP-06', label: '3.2 Runner 연동' },
      { kind: 'task', key: 'TASK-0012', task: expect.objectContaining({ taskKey: 'TASK-0012' }) },
    ]);
  });
});

describe('머리 문구', () => {
  it('Task 수·완료·차단', () => {
    expect(wbsSubtitle(TASKS)).toBe('12 Tasks · 완료 3 · 차단 4 · Task ID는 고정, WBS 번호는 위치에 따라 자동 계산');
  });
  it('일정 요약(원본 schL)', () => {
    expect(scheduleLine(SCHEDULE, 10)).toBe('완료 예상 11-06 (범위 11-06 ~ 11-10) · 기준 v1 11-06 대비 0일 · 진행률 30% · 관측 가동률 69% · 동시 실행 한도 10 (하위 Agent 포함)');
    expect(scheduleLine(SCHEDULE, null)).toBe('완료 예상 11-06 (범위 11-06 ~ 11-10) · 기준 v1 11-06 대비 0일 · 진행률 30% · 관측 가동률 69%');
  });
});

describe('Gantt 좌표(UI-03C)', () => {
  it('전체 기간(시작 ~ max(비관·기준·목표·오늘)+3일)을 화면 폭 100%에 맞춘다', () => {
    const now = Date.parse('2026-11-05T20:00:00+09:00');
    const g = ganttGeometry(SCHEDULE, now);
    expect(g.days[0]?.date).toBe('2026-10-27');
    expect(g.days.at(-1)?.date).toBe('2026-12-21');
    expect(g.days.length).toBe(56);
    // 월요일과 첫날만 눈금 글자
    expect(g.days.filter((d) => d.label).map((d) => d.label).slice(0, 3)).toEqual(['10-27', '11-02', '11-09']);
    expect(g.days.find((d) => d.date === '2026-11-04')?.cls).toBe('gd bk past');
    expect(g.today).toBeCloseTo(((9 + 20 / 24) / 56) * 100, 3);
    const bar = g.task('TASK-0004');
    expect(bar.plan).toEqual({ left: `${((7 / 56) * 100).toFixed(3)}%`, width: `${((3 / 56) * 100).toFixed(3)}%` });
    expect(bar.cls).toBe('g-act run');
    expect(g.task('TASK-0001').cls).toBe('g-act done');
    expect(g.task('TASK-0001').range).toBeNull();
    expect(g.task('TASK-0006').cls).toBe('g-fc');
  });
});

describe('Task 생성 Wizard 검증(UAT-WIZ-01)', () => {
  const ok = { title: 'x', wbsNodeId: 'WP-01', type: 'Design', domain: 'DB', est: '4', fixStart: '', purpose: 'p', doneCond: 'd' };
  it('1단계: 제목·유형·주 영역·시간(0 초과 400 이하)·날짜 형식', () => {
    expect(wizardErrors({ ...ok, title: ' ', type: '', domain: '' })).toMatchObject({ title: true, type: true, domain: true });
    expect(wizardErrors({ ...ok, est: '0' }).est).toBe(true);
    expect(wizardErrors({ ...ok, est: '400.5' }).est).toBe(true);
    expect(wizardErrors({ ...ok, est: '400' }).est).toBe(false);
    expect(wizardErrors({ ...ok, est: 'abc' }).est).toBe(true);
    expect(wizardErrors({ ...ok, fixStart: '2026/11/05' }).fixStart).toBe(true);
    expect(wizardErrors({ ...ok, fixStart: '2026-11-05' }).fixStart).toBe(false);
    expect(wizardErrors({ ...ok, wbsNodeId: '' }).wp).toBe(true);
  });
  it('단계별 빠진 항목 문구', () => {
    expect(wizardMissing(1, wizardErrors({ ...ok, title: '', est: '0' }))).toEqual(['제목', '예상 소요 시간(숫자)']);
    expect(wizardMissing(2, wizardErrors({ ...ok, purpose: '', doneCond: '' }))).toEqual(['작업 목적', '완료 조건']);
    expect(wizardMissing(3, wizardErrors({ ...ok, purpose: '' }))).toEqual([]);
  });
});
