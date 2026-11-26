/**
 * WBS 화면의 순수 계산(화면 없이 단위 시험한다).
 * 원본 로직: buildRows·taskRow·schedFields(P L5104–5195), wrailIds(P L5075), renderMain(P L6968–7088), wizErrs(P L6787).
 * 서버 계약 타입만 쓴다(ResponseOf). 화면 문구는 원본 그대로다.
 */
import type { QueryOf, ResponseOf } from '../../shared/api/contract.ts';

export type TaskList = ResponseOf<'listTasks'>;
export type TaskSummary = TaskList['tasks'][number];
export type WbsNode = TaskList['nodes'][number];
export type ScheduleData = ResponseOf<'getSchedule'>;
export type SchedTask = ScheduleData['tasks'][number];

/* ---------- 라벨(P LBL L2909–2934) ---------- */
export const TYPE_LABEL: Record<string, string> = {
  Analysis: '분석', Design: '설계', Implementation: '구현', Configuration: '구성', Test: '테스트', Verification: '검증', Documentation: '문서화', Integration: '통합',
};
export const DOMAIN_LABEL: Record<string, string> = {
  FE: 'Frontend', BE: 'Backend', DB: 'Database', DevOps: '개발·배포', API: 'API·연동', QA: '품질 검증', Architecture: '시스템 구조', Common: '공통',
};
export const STATUS: Record<string, { l: string; c: string; tip: string }> = {
  planning: { l: '계획 중', c: 's-plan', tip: 'Lifecycle: 계획 중 — 명세 작성 단계, 실행 요청 불가' },
  approval: { l: '승인 대기', c: 's-appr', tip: 'Planning Approval: 팀장 승인 대기 — 승인 전에는 WBS에 확정되지 않음' },
  ready: { l: '실행 대기', c: 's-ready', tip: 'Execution: 실행 대기 — 선행 조건 충족 시 Runner에 실행 요청 가능' },
  running: { l: '실행 중', c: 's-run', tip: 'Execution: Runner에서 Agent 세션 실행 중' },
  qa: { l: 'QA 진행', c: 's-qa', tip: 'Verification: 검증 Agent QA 진행 중' },
  rework: { l: '재작업 필요', c: 's-rework', tip: 'Verification: QA FAIL — 재작업 시도 필요' },
  verifying: { l: '검증 진행', c: 's-verif', tip: 'Verification: 재검증 진행 중' },
  gate: { l: 'Gate 대기', c: 's-verif', tip: 'Verification PASS — Completion Gate 확인 후 완료 처리' },
  paused: { l: '중단 · 재개 대기', c: 's-rework', tip: 'Execution: Runner 중지 · 사용량 한도 · 오류로 실행이 끊김 — 재개하면 같은 작업을 새 시도로 이어감' },
  done: { l: '완료', c: 's-done', tip: 'Completion Gate 통과 후 완료 처리됨' },
  failed: { l: '실패', c: 's-fail', tip: 'Execution: 실행 실패 — 원인 확인 필요' },
  cancelled: { l: '취소됨', c: 's-plan', tip: '승인된 Change Proposal로 취소됨 — 이력 보존' },
};
export const STATUS_ORDER = ['planning', 'approval', 'ready', 'running', 'paused', 'qa', 'rework', 'verifying', 'gate', 'failed', 'done', 'cancelled'];
/** 상태 필터의 「진행 중 (실행~Gate 대기)」 묶음(P L5080) */
const ACTIVE_STATUSES = ['running', 'paused', 'qa', 'rework', 'verifying', 'gate'];
export const PRIORITY = [{ l: '긴급', c: 'p0' }, { l: '높음', c: 'p1' }, { l: '보통', c: 'p2' }, { l: '낮음', c: 'p3' }];
export const VERIF: Record<string, { l: string; c: string }> = {
  none: { l: '미실시', c: 'v-none' }, running: { l: '검증 중', c: 'v-run' }, pass: { l: 'PASS', c: 'v-pass' }, fail: { l: 'FAIL', c: 'v-fail' }, blocked: { l: 'BLOCKED', c: 'v-blk' },
};
export const statusOf = (s: unknown) => STATUS[String(s)] ?? { l: String(s), c: 's-plan', tip: '' };
export const verifOf = (s: unknown) => VERIF[String(s)] ?? { l: String(s), c: 'v-none' };
export const priorityOf = (p: unknown) => PRIORITY[Number(p)] ?? { l: String(p), c: 'p2' };

/* ---------- 날짜(Asia/Seoul 날짜 문자열 ↔ 일 번호) ---------- */
export const dayNo = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 864e5);
export const ymd = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
export const md = (date: string) => date.slice(5, 10);
export const fmtH = (h: number) => `${String(Math.round(h * 10) / 10)}h`;
/** 지금 시각의 서울 날짜 번호와 하루 중 비율 */
export function seoulNow(now: number): { day: number; frac: number } {
  const shifted = now + 9 * 3_600_000;
  const day = Math.floor(shifted / 864e5);
  return { day, frac: (shifted - day * 864e5) / 864e5 };
}

/* ---------- 필터·정렬 상태 ---------- */
export interface Filters { type: string; domain: string; status: string; agent: string; priority: string; phase: string; blocked: string; verif: string }
export const EMPTY_FILTERS: Filters = { type: '', domain: '', status: '', agent: '', priority: '', phase: '', blocked: '', verif: '' };
export type SortKey = 'wbs' | 'priority' | 'status' | 'updated';
export interface ViewState { search: string; filters: Filters; sort: SortKey; collapsed: ReadonlySet<string> }

export const filterCount = (v: Pick<ViewState, 'filters'>) => Object.values(v.filters).filter((x) => x !== '').length;
export const isFilterActive = (v: Pick<ViewState, 'filters' | 'search'>) => v.search.trim() !== '' || filterCount(v) > 0;

/**
 * 서버(GET /api/projects/:projectId/tasks)로 보내는 조건. 계약에는 status 하나와 q만 있다.
 * 「진행 중」 묶음은 여러 상태라 화면에서 거른다.
 */
export function serverQuery(v: Pick<ViewState, 'filters' | 'search'>): QueryOf<'listTasks'> {
  const q = v.search.trim();
  const status = v.filters.status;
  return { ...(q ? { q } : {}), ...(status && status !== 'active' ? { status } : {}) } as QueryOf<'listTasks'>;
}

/**
 * 화면에서 거르는 조건. 서버가 이미 거른 검색어·단일 상태는 다시 거르지 않는다.
 * 왜: 새 조건의 응답이 오기 전에는 이전 목록을 그대로 보여 줘야 한다(G§0.3, UAT-STATE-02-UI).
 */
function matcher(nodes: readonly WbsNode[], f: Filters) {
  const parent = new Map(nodes.map((n) => [n.id, n.parentId]));
  const underPhase = (nodeId: string, phase: string) => {
    for (let id: string | null | undefined = nodeId; id; id = parent.get(id)) if (id === phase) return true;
    return false;
  };
  return (t: TaskSummary) => {
    if (f.type && t.workType !== f.type) return false;
    if (f.domain && t.primaryDomain !== f.domain && !t.relatedDomains.map(String).includes(f.domain)) return false;
    if (f.status === 'active' && !ACTIVE_STATUSES.includes(String(t.lifecycleStatus))) return false;
    if (f.agent && t.assigneeAgent !== f.agent) return false;
    if (f.priority !== '' && String(t.priority) !== f.priority) return false;
    if (f.phase && !underPhase(t.wbsNodeId, f.phase)) return false;
    if (f.blocked === 'y' && !t.blocked) return false;
    if (f.blocked === 'n' && t.blocked) return false;
    if (f.verif && t.verifState !== f.verif) return false;
    return true;
  };
}

function sorter(sort: SortKey) {
  return (a: TaskSummary, b: TaskSummary) => {
    if (sort === 'priority') return Number(a.priority) - Number(b.priority);
    if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
    if (sort === 'status') return STATUS_ORDER.indexOf(String(a.lifecycleStatus)) - STATUS_ORDER.indexOf(String(b.lifecycleStatus));
    return 0;
  };
}

/* ---------- 트리 ---------- */
interface Tree { roots: WbsNode[]; children: Map<string, WbsNode[]>; tasksOf: Map<string, TaskSummary[]> }
function tree(nodes: readonly WbsNode[], tasks: readonly TaskSummary[]): Tree {
  const byPath = (a: { wbsPath: string }, b: { wbsPath: string }) => a.wbsPath.localeCompare(b.wbsPath, undefined, { numeric: true });
  const children = new Map<string, WbsNode[]>();
  const roots: WbsNode[] = [];
  for (const n of [...nodes].sort(byPath)) {
    if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
    else roots.push(n);
  }
  const tasksOf = new Map<string, TaskSummary[]>();
  for (const t of [...tasks].sort(byPath)) if (!t.deletedAt) tasksOf.set(t.wbsNodeId, [...(tasksOf.get(t.wbsNodeId) ?? []), t]);
  return { roots, children, tasksOf };
}
function subtreeTasks(tr: Tree, n: WbsNode): TaskSummary[] {
  return [...(tr.tasksOf.get(n.id) ?? []), ...(tr.children.get(n.id) ?? []).flatMap((c) => subtreeTasks(tr, c))];
}

/* ---------- 표 행 ---------- */
export interface GroupRow {
  kind: 'group'; key: string; node: WbsNode; depth: number; open: boolean; agg: string; pct: number;
  win: { text: string; cls: string } | null; taskKeys: string[];
}
export interface TaskRow { kind: 'task'; key: string; task: TaskSummary; depth: number }
export type Row = GroupRow | TaskRow;

function groupAgg(tasks: TaskSummary[]): Pick<GroupRow, 'agg' | 'pct' | 'win'> {
  const done = tasks.filter((t) => t.lifecycleStatus === 'done').length;
  const scs = tasks.flatMap((t) => (t.schedule ? [t.schedule] : []));
  const est = scs.reduce((a, s) => a + s.estHours, 0);
  const pct = est ? Math.round(scs.reduce((a, s) => a + s.estHours * s.progressPct, 0) / est) : 0;
  const ends = scs.flatMap((s) => (s.end ? [dayNo(s.end)] : []));
  const bases = scs.flatMap((s) => (s.baselineEnd ? [dayNo(s.baselineEnd)] : []));
  let win: GroupRow['win'] = null;
  if (ends.length) {
    const fe = Math.max(...ends);
    const pe = bases.length ? Math.max(...bases) : fe;
    const slip = fe - pe;
    win = {
      text: `완료 예상 ${md(ymd(fe))} (기준 ${md(ymd(pe))}${slip !== 0 ? `, ${slip > 0 ? '+' : ''}${String(slip)}일` : ''})`,
      cls: slip > 0 ? 'sc sc-bad' : 'sc sc-none',
    };
  }
  return { agg: `완료 ${String(done)}/${String(tasks.length)} · 예상 ${fmtH(est)} · 진행률 ${String(pct)}%`, pct, win };
}

/**
 * 표의 행 목록(P buildRows L5104). 필터가 있으면 매칭 Task가 있는 그룹만, 없으면 빈 그룹도 보인다.
 * 정렬은 Work Package 안에서만 적용한다. 접힌 그룹의 Task도 결과 수에는 센다.
 */
export function buildRows(nodes: readonly WbsNode[], tasks: readonly TaskSummary[], v: ViewState, _schedule?: ScheduleData): { rows: Row[]; taskCount: number; active: boolean } {
  const tr = tree(nodes, tasks);
  const active = isFilterActive(v);
  const match = matcher(nodes, v.filters);
  const sort = sorter(v.sort);
  const rows: Row[] = [];
  let taskCount = 0;
  const visit = (n: WbsNode, depth: number, hidden: boolean): void => {
    const all = subtreeTasks(tr, n);
    const matched = all.filter(match);
    if (active && !matched.length) return;
    const open = !v.collapsed.has(n.id);
    if (!hidden) rows.push({ kind: 'group', key: n.id, node: n, depth, open, taskKeys: all.map((t) => t.taskKey), ...groupAgg(all) });
    const own = (tr.tasksOf.get(n.id) ?? []).filter(match);
    taskCount += own.length;
    const showChildren = !hidden && open;
    for (const c of tr.children.get(n.id) ?? []) visit(c, depth + 1, !showChildren);
    if (showChildren) for (const t of v.sort === 'wbs' ? own : [...own].sort(sort)) rows.push({ kind: 'task', key: t.taskKey, task: t, depth: depth + 1 });
  };
  for (const r of tr.roots) {
    if (v.filters.phase && r.id !== v.filters.phase && r.kind === 'phase') continue;
    visit(r, 0, false);
  }
  return { rows, taskCount, active };
}

/** 레일(P wrailIds L5075): 같은 필터·정렬, 접힘 무시, Work Package 구분선 */
export type RailItem = { kind: 'wp'; key: string; label: string } | { kind: 'task'; key: string; task: TaskSummary };
export function railItems(nodes: readonly WbsNode[], tasks: readonly TaskSummary[], v: ViewState): RailItem[] {
  const { rows } = buildRows(nodes, tasks, { ...v, collapsed: new Set() });
  const out: RailItem[] = [];
  let pending: GroupRow | null = null;
  for (const r of rows) {
    if (r.kind === 'group') { pending = r; continue; }
    if (pending) { out.push({ kind: 'wp', key: pending.key, label: `${pending.node.wbsPath} ${pending.node.title}` }); pending = null; }
    out.push({ kind: 'task', key: r.key, task: r.task });
  }
  return out;
}

/* ---------- 컬럼(P COLS L2943) ---------- */
export type ColKey = 'kind' | 'agent' | 'status' | 'priority' | 'preds' | 'pct' | 'plan' | 'est' | 'updated';
export const COLS: readonly { key: ColKey; label: string; head: string; w: string; title?: string }[] = [
  { key: 'kind', label: '유형 · 영역', head: '유형 · 영역', w: 'minmax(100px,.7fr)' },
  { key: 'agent', label: '담당 Agent', head: '담당', w: 'minmax(92px,.6fr)' },
  { key: 'status', label: '상태 · 검증', head: '상태 · 검증', w: 'minmax(104px,.8fr)' },
  { key: 'priority', label: '우선순위', head: '우선순위', w: 'minmax(64px,.45fr)' },
  { key: 'preds', label: '선행 Task', head: '선행 Task', w: 'minmax(92px,.8fr)' },
  { key: 'pct', label: '진행률 · 체크리스트', head: '진행 · 체크리스트', w: 'minmax(104px,.7fr)' },
  { key: 'plan', label: '완료 예상 · 기준 대비', head: '완료 예상 · 기준 대비', w: 'minmax(132px,.85fr)', title: '완료 예상일(범위) · 최신 기준 일정 대비' },
  { key: 'est', label: '예상 실행', head: '예상 실행', w: 'minmax(100px,.55fr)', title: 'Agent 실행 시간 — 예상 (낙관~비관)' },
  { key: 'updated', label: '최근 변경', head: '최근 변경', w: 'minmax(84px,.6fr)' },
];
export const DEFAULT_COLS: ReadonlySet<ColKey> = new Set(['kind', 'agent', 'status', 'priority', 'preds', 'pct', 'plan', 'est']);
export const gridColumns = (cols: ReadonlySet<ColKey>) => ['60px minmax(200px,2.4fr)', ...COLS.filter((c) => cols.has(c.key)).map((c) => c.w)].join(' ');
/** 모든 열이 잘리지 않는 최소 폭(px). 1280 미만에서 이 폭보다 좁으면 표 상자 안에서 가로 스크롤한다. */
export const minTableWidth = (cols: ReadonlySet<ColKey>) => 60 + 200 + COLS.filter((c) => cols.has(c.key)).reduce((a, c) => a + Number(/minmax\((\d+)px/.exec(c.w)?.[1] ?? 0), 0);

/* ---------- Task 셀 ---------- */
export const agentMark = (a: unknown) => {
  const name = a == null ? '' : String(a);
  return { name: name || '—', init: name === 'Claude' ? 'Cl' : name === 'Codex' ? 'Cx' : name.slice(0, 2), cls: `ag-mk${name === 'Claude' ? ' ag-claude' : name === 'Codex' ? ' ag-codex' : ''}` };
};

export interface PlanCell { planL: string; scL: string; scC: string; rangeL: string; tip: string }
export function planCell(task: TaskSummary, sc: SchedTask | undefined): PlanCell {
  if (!sc) return { planL: task.lifecycleStatus === 'cancelled' ? '취소됨' : '—', scL: task.lifecycleStatus === 'cancelled' ? '취소' : '계산 전', scC: 'sc sc-none', rangeL: '', tip: '' };
  const slip = sc.slipDays ?? 0;
  let scL: string;
  let scC: string;
  if (sc.done) { scL = sc.isNew ? '완료' : slip > 0 ? `지연 완료 +${String(slip)}일` : '기준 내 완료'; scC = slip > 0 && !sc.isNew ? 'sc-warn' : 'sc-ok'; }
  else if (task.lifecycleStatus === 'paused') { scL = '중단 · 재개 대기'; scC = 'sc-warn'; }
  else if (sc.isNew) { scL = '신규 — 다음 기준 반영'; scC = 'sc-none'; }
  else if (slip > 0) { scL = `기준 대비 +${String(slip)}일`; scC = 'sc-bad'; }
  else if (slip < 0) { scL = `기준보다 ${String(-slip)}일 빠름`; scC = 'sc-ok'; }
  else { scL = sc.started ? '진행 · 기준 일정' : '기준 일정'; scC = sc.started ? 'sc-ok' : 'sc-none'; }
  const rangeY = `${sc.lo} ~ ${sc.hi}`;
  const planY = sc.baselineStart && sc.baselineEnd ? `${sc.baselineStart} ~ ${sc.baselineEnd}` : '';
  return {
    planL: sc.done ? `${md(sc.end)} 완료` : md(sc.end), scL, scC: `sc ${scC}`,
    rangeL: sc.done ? '실제' : `범위 ${md(sc.lo)} ~ ${md(sc.hi)}`,
    tip: `${sc.isNew ? '기준 미포함' : `기준 ${planY}`} · ${sc.done ? '실제 ' : '전망 '}${sc.start} ~ ${sc.end}${sc.done ? '' : ` (범위 ${rangeY})`}`,
  };
}

export type PredCell = { kind: 'none' } | { kind: 'blocked'; label: string; tip: string } | { kind: 'ok'; count: number; tip: string };
export function predCell(task: TaskSummary, byKey: ReadonlyMap<string, TaskSummary>): PredCell {
  if (!task.preds.length) return { kind: 'none' };
  if (task.blocked && task.lifecycleStatus !== 'done') {
    const open = task.preds.filter((k) => byKey.get(k)?.lifecycleStatus !== 'done');
    const bl = open.length ? open : task.preds;
    const first = bl[0] ?? '';
    return {
      kind: 'blocked', label: bl.length === 1 ? first : `${first} 외 ${String(bl.length - 1)}`,
      tip: bl.map((k) => { const p = byKey.get(k); return p ? `${k} ${p.title} — ${statusOf(p.lifecycleStatus).l}` : k; }).join('\n'),
    };
  }
  return { kind: 'ok', count: task.preds.length, tip: task.preds.join(', ') };
}

export function taskCells(task: TaskSummary, byKey: ReadonlyMap<string, TaskSummary>, sc: SchedTask | undefined) {
  const pct = sc?.progressPct ?? task.schedule?.progressPct ?? 0;
  const est = sc ?? task.schedule;
  return {
    agent: agentMark(task.assigneeAgent),
    preds: predCell(task, byKey),
    plan: planCell(task, sc),
    pct,
    pctL: est ? `${String(pct)}%` : '—',
    checklist: task.checklist.total ? `${String(task.checklist.done)}/${String(task.checklist.total)}` : '—',
    est: est ? { estL: fmtH(est.estHours), estR: `${String(est.loHours)}~${String(est.hiHours)}h` } : { estL: '—', estR: '' },
  };
}

/* ---------- 머리 문구 ---------- */
export function wbsSubtitle(tasks: readonly TaskSummary[]): string {
  const live = tasks.filter((t) => !t.deletedAt);
  const done = live.filter((t) => t.lifecycleStatus === 'done').length;
  const blocked = live.filter((t) => t.blocked).length;
  return `${String(live.length)} Tasks · 완료 ${String(done)} · 차단 ${String(blocked)} · Task ID는 고정, WBS 번호는 위치에 따라 자동 계산`;
}
/** 원본 schL(P L7081). 동시 실행 한도를 모르면(Runner 상태 없음) 그 부분은 뺀다. */
export function scheduleLine(s: ScheduleData, limit: number | null): string {
  const p = s.project;
  const base = p.baselineEnd ? ` · 기준 v${String(p.baselineVersion)} ${md(p.baselineEnd)} 대비 ${p.slipDays > 0 ? '+' : ''}${String(p.slipDays)}일` : '';
  const tail = limit === null ? '' : ` · 동시 실행 한도 ${String(limit)} (하위 Agent 포함)`;
  return `완료 예상 ${md(p.end)} (범위 ${md(p.lo)} ~ ${md(p.hi)})${base} · 진행률 ${String(Math.round(p.progressPct))}% · 관측 가동률 ${String(Math.round(s.capacity.rate * 100))}%${tail}`;
}

/* ---------- Gantt(P L6969–6980, schedFields L5175) ---------- */
export interface GanttDay { date: string; label: string; cls: string; tip: string }
export interface Span { left: string; width: string }
export interface GanttBar { plan: Span | null; fc: Span; range: Span | null; cls: string; planTip: string; fcTip: string }
export function ganttGeometry(s: ScheduleData, now: number) {
  const today = seoulNow(now);
  const starts = [s.project.start, ...s.tasks.flatMap((t) => [t.start, ...(t.baselineStart ? [t.baselineStart] : [])])].map(dayNo);
  const s0 = Math.min(...starts);
  const tgt = s.project.target ? dayNo(s.project.target) : null;
  const end = Math.max(dayNo(s.project.hi), s.project.baselineEnd ? dayNo(s.project.baselineEnd) : 0, tgt ?? 0, today.day) + 3;
  const D = end - s0 + 1;
  const pc = (n: number) => `${((n / D) * 100).toFixed(3)}%`;
  const span = (a: number, b: number): Span => ({ left: pc(a - s0), width: pc(Math.max(1, b - a + 1)) });
  const blackout = new Map(s.blackouts.map((b) => [b.date, b.note]));
  const days: GanttDay[] = [];
  for (let n = s0; n <= end; n++) {
    const date = ymd(n);
    const bo = blackout.get(date);
    const monday = new Date(n * 864e5).getUTCDay() === 1;
    days.push({
      date, label: monday || n === s0 ? md(date) : '',
      cls: `gd${bo !== undefined ? ' bk' : ''}${n < today.day ? ' past' : ''}${n === today.day ? ' td' : ''}${n === tgt ? ' tg' : ''}`,
      tip: `${date}${bo !== undefined ? ` — 작업 불가: ${bo}` : ''}${n === tgt ? ' — 목표일' : ''}`,
    });
  }
  const byKey = new Map(s.tasks.map((t) => [t.taskKey, t]));
  const task = (key: string): GanttBar => {
    const t = byKey.get(key);
    if (!t) return { plan: null, fc: { left: '0%', width: '0%' }, range: null, cls: 'g-fc', planTip: '', fcTip: '' };
    const fs = dayNo(t.start);
    const fe = dayNo(t.end);
    const plan = t.baselineStart && t.baselineEnd ? span(dayNo(t.baselineStart), dayNo(t.baselineEnd)) : null;
    const range = `${t.lo} ~ ${t.hi}`;
    return {
      plan, fc: span(fs, fe), range: t.done ? null : span(dayNo(t.lo), dayNo(t.hi)),
      cls: t.done ? 'g-act done' : t.started ? 'g-act run' : 'g-fc',
      planTip: plan ? `기준 ${t.baselineStart ?? ''} ~ ${t.baselineEnd ?? ''}` : '',
      fcTip: `${t.done ? '실제 ' : t.started ? '진행 · 완료 예상 ' : '완료 예상 '}${t.start} ~ ${t.end}${t.done ? '' : ` · 범위 ${range}`} · 진행률 ${String(t.progressPct)}%`,
    };
  };
  /** 그룹 요약 막대: 기준 시작 ~ max(기준 끝, 예상 끝) */
  const group = (keys: readonly string[]): Span | null => {
    const ts = keys.flatMap((k) => { const t = byKey.get(k); return t ? [t] : []; });
    if (!ts.length) return null;
    const ps = Math.min(...ts.map((t) => dayNo(t.baselineStart ?? t.start)));
    const pe = Math.max(...ts.map((t) => Math.max(dayNo(t.baselineEnd ?? t.end), dayNo(t.end))));
    return span(ps, pe);
  };
  return {
    days, D, task, group,
    today: ((today.day - s0 + today.frac) / D) * 100,
    target: tgt === null ? null : ((tgt - s0 + 1) / D) * 100,
    trackSize: `${(100 / D).toFixed(4)}% 100%`,
  };
}

/* ---------- Task 생성 Wizard(P wizErrs L6787) ---------- */
export interface WizardDraft { title: string; wbsNodeId: string; type: string; domain: string; est: string; fixStart: string; purpose: string; doneCond: string }
export function wizardErrors(d: WizardDraft) {
  const est = d.est.trim();
  return {
    title: !d.title.trim(), wp: !d.wbsNodeId, type: !d.type, domain: !d.domain,
    est: !/^\d+(\.\d+)?$/.test(est) || Number(est) <= 0 || Number(est) > 400,
    fixStart: d.fixStart.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(d.fixStart.trim()),
    purpose: !d.purpose.trim(), doneCond: !d.doneCond.trim(),
  };
}
export type WizardErrors = ReturnType<typeof wizardErrors>;
const STEP_FIELDS: Record<number, [keyof WizardErrors, string][]> = {
  1: [['title', '제목'], ['wp', '상위 Work Package'], ['type', '작업 유형'], ['domain', '주 기술 영역'], ['est', '예상 소요 시간(숫자)'], ['fixStart', '고정 시작일 형식']],
  2: [['purpose', '작업 목적'], ['doneCond', '완료 조건']],
};
export const wizardMissing = (step: number, e: WizardErrors) => (STEP_FIELDS[step] ?? []).filter(([k]) => e[k]).map(([, l]) => l);
/** 한 줄에 한 항목(P lines) */
export const lines = (text: string) => text.split('\n').map((x) => x.trim()).filter(Boolean);
