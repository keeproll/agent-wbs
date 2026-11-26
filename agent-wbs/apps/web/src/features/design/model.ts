/**
 * 설계 화면(UI-04)의 화면 없는 계산. 원본 dsVM(P L4859–4936)을 서버 계약(M6-05 shared/api routes/project.ts 설계 API) 모양에 맞춰 옮겼다.
 *
 * 원본과 다른 점(서버 계약 때문, README §4에 정리):
 * - 항목 상태는 담당 Task 상태에서 계산한다(G L452, P Sel.dsStat). 서버 목록의 status는 계약 파일 읽기 상태(ok·draft·error)라 따로 쓴다.
 * - 불일치에는 호환 판정 compat(compatible·breaking·unchecked)이 있다. unchecked는 「대조 안 함」이며 호환으로 보이지 않는다(G L1058).
 * - 계약 반영은 Runner job(design_apply)의 결과 커밋 보고 뒤에만 해결된다(contracts §2.3). 그 사이는 「계약 반영 대기」다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';

export type DecisionItem = ResponseOf<'listDecisions'>['items'][number];
export type DriftItem = ResponseOf<'listDrifts'>['items'][number];
export type Overview = ResponseOf<'getDesign'>;
export type FileItem = Overview['files'][number];
export type ComponentItem = Overview['components'][number];
export type LinkItem = Overview['links'][number];
export type IfaceItem = ResponseOf<'listInterfaces'>['items'][number];
export type DataItem = ResponseOf<'listDataItems'>['items'][number];
export type IfaceDetail = ResponseOf<'getInterface'>;
export type DataDetail = ResponseOf<'getDataItem'>;
export interface TaskInfo { status: string; verif: string }

export type Tab = 'map' | 'dec' | 'iface' | 'data' | 'own' | 'chg';
export const TABS: readonly [Tab, string][] = [['map', '구성도 · 계약 파일'], ['dec', '기술 결정'], ['iface', '인터페이스'], ['data', '데이터'], ['own', '소유권 · 흐름'], ['chg', '변경 · 불일치']];
export const isTab = (v: string | null): v is Tab => TABS.some(([k]) => k === v);

type Label = [string, string];

/** 담당 Task 상태 → 항목 상태(P Sel.dsStat L3884) */
export function taskStat(t: TaskInfo | undefined): Label {
  if (!t) return ['계획', 'vf v-none'];
  if (t.status === 'done') return t.verif === 'pass' ? ['검증됨', 'vf v-pass'] : ['구현됨', 'vf v-pass'];
  if (t.status === 'cancelled') return ['폐기', 'vf v-none'];
  if (['running', 'paused', 'qa', 'rework', 'verifying', 'gate'].includes(t.status)) return ['구현 중 · 브랜치', 'vf v-run'];
  return ['계획', 'vf v-none'];
}

/* ---- 기술 결정 ---- */
const AUTH: Record<string, Label> = { lead: ['팀장 지정', 'sc sc-ok'], agent: ['Agent 제안 → 팀장 승인', 'sc sc-none'], free: ['Agent 재량 (기록)', 'sc sc-none'] };
const LEVEL: Record<string, string> = { must: '필수', cond: '조건부 선호', ban: '금지' };
export const DECISION_STATUS: Record<string, Label> = {
  fixed: ['확정', 'vf v-pass'], approved: ['승인됨', 'vf v-pass'], pending: ['승인 대기', 'vf v-run'], rejected: ['반려', 'vf v-none'],
  noted: ['기록', 'vf v-none'], change: ['변경 제안 — 승인 대기', 'vf v-run'],
};
const COND_RESULT: Record<string, string> = { met: '충족', not_met: '미충족' };

export function decisionView(x: DecisionItem) {
  const [authL, authC] = AUTH[x.authority] ?? ['—', 'sc sc-none'];
  const [stL, stC] = DECISION_STATUS[x.status] ?? ['—', 'vf v-none'];
  const result = x.conditionResult ? COND_RESULT[x.conditionResult] : undefined;
  return {
    id: x.id, tdKey: x.tdKey, authL: x.level ? `${authL} · ${LEVEL[x.level] ?? x.level}` : authL, authC, stL, stC,
    pending: x.status === 'pending' || x.status === 'change',
    isChg: x.status === 'change',
    chgL: x.status === 'change' && x.change ? `${x.choice} → ${x.change.choice} — ${x.change.reason}` : '',
    // 원본 canChg(P L4903): 재량이 아니고 확정·승인된 것, 팀장 지정은 조건부 선호만(필수·금지는 Agent도 팀장 화면도 바꾸지 않는다)
    canChg: x.authority !== 'free' && ['approved', 'fixed'].includes(x.status) && !(x.authority === 'lead' && x.level !== 'cond'),
    rowC: x.status === 'rejected' ? 'dec-row off' : 'dec-row',
    condL: x.condition ? `${x.condition}${result ? ` (조건 충족 판단: ${result})` : ''}` : '',
  };
}

const GROUPS: [string, string][] = [['lead', '팀장 지정 — 필수 · 조건부 선호 · 금지'], ['agent', 'Agent 제안 → 팀장 승인'], ['free', 'Agent 재량 — 기록만']];
export function decisionGroups(decs: readonly DecisionItem[]) {
  return GROUPS.map(([k, l]) => ({ k, l, rows: decs.filter((x) => x.authority === k) })).filter((g) => g.rows.length > 0);
}
/** 호환을 깨는 계약 반영에 붙일 수 있는 결정: 팀장이 승인한(approved) 결정(서버 resolve 검사와 같다) */
export const approvedDecisions = (decs: readonly DecisionItem[]) => decs.filter((x) => x.status === 'approved');
export const pendingDecisions = (decs: readonly DecisionItem[]) => decs.filter((x) => x.status === 'pending' || x.status === 'change');

/* ---- 불일치 ---- */
const COMPAT: Record<string, Label> = { compatible: ['호환', 'sc sc-ok'], breaking: ['호환 깨짐', 'sc sc-bad'], unchecked: ['대조 안 함', 'sc sc-warn'] };
export const compatLabel = (compat: string): Label => COMPAT[compat] ?? ['—', 'sc sc-none'];

const short = (sha: unknown) => (typeof sha === 'string' ? sha.slice(0, 7) : '');
const resolution = (d: DriftItem): Record<string, unknown> => (d.resolution && typeof d.resolution === 'object' ? d.resolution as Record<string, unknown> : {});

export function driftView(d: DriftItem) {
  const r = resolution(d);
  const open = d.status === 'open';
  const waiting = open && typeof r.jobId === 'string' && r.jobId !== '';
  const unchecked = d.compat === 'unchecked';
  const [compatL, compatC] = compatLabel(d.compat);
  let stL: string; let stC: string;
  if (!open) [stL, stC] = ['해결됨', 'vf v-pass'];
  else if (waiting) [stL, stC] = ['계약 반영 대기', 'vf v-run'];
  else if (unchecked) [stL, stC] = ['대조 안 함', 'vf v-run'];
  else [stL, stC] = ['미해결', 'vf v-fail'];
  let resL = '';
  if (waiting) resL = `계약 반영 요청됨 — Runner가 결과 커밋을 보고하고 대조가 일치해야 해결됩니다 (job ${short(r.jobId)})`;
  else if (!open && r.how === 'contract') resL = `계약에 반영 — 결과 커밋 ${short(r.resultCommit) || '—'}`;
  else if (!open && r.how === 'code') resL = `코드 수정 요청 → ${d.taskKey ?? '담당 Task'} 메시지로 전달`;
  else if (!open && r.resolvedBy === 'comparison') resL = `다음 대조에서 일치 확인 — 커밋 ${short(r.commit) || '—'}`;
  return {
    open, waiting, stL, stC, compatL, compatC, resL,
    canContract: open && !waiting && !unchecked,
    canCode: open && !waiting && d.taskKey !== null,
    // 결과를 모르는 job(실패·취소 포함)은 같은 요청을 다시 보낼 수 있다. 아직 진행 중이면 서버가 409로 거부한다.
    canRetry: waiting,
    needsDecision: d.compat === 'breaking',
    note: unchecked ? '코드에서 실제 명세를 추출하지 못해 대조하지 않았습니다 — 불일치 0건이 아닙니다. 추출 방법이 생기면 다음 병합 때 대조합니다.' : '',
  };
}

/** 항목 행·상세에 붙일 표시. 열린 불일치(대조함)가 먼저, 대조 안 함만 있으면 그것. */
export function driftMark(drifts: readonly DriftItem[], itemKey: string): Label | null {
  const mine = drifts.filter((d) => d.itemKey === itemKey && d.status === 'open');
  if (mine.some((d) => d.compat !== 'unchecked')) return ['불일치', 'sc sc-bad'];
  if (mine.length) return ['대조 안 함', 'sc sc-warn'];
  return null;
}

/* ---- 요약·배지 ---- */
export function summaryLine(version: number | null, decs: readonly DecisionItem[], ifaceCount: number, dataCount: number, drifts: readonly DriftItem[]) {
  const pend = pendingDecisions(decs).length;
  const open = drifts.filter((d) => d.status === 'open');
  const real = open.filter((d) => d.compat !== 'unchecked').length;
  const unchecked = open.length - real;
  return `설계 v${String(version ?? 0)} · 기술 결정 ${String(decs.length)}${pend ? ` (승인 대기 ${String(pend)})` : ''} · 인터페이스 ${String(ifaceCount)} · 데이터 항목 ${String(dataCount)}`
    + `${real ? ` · 불일치 ${String(real)}` : ''}${unchecked ? ` · 대조 안 함 ${String(unchecked)}` : ''}`;
}
export function tabBadges(decs: readonly DecisionItem[], ifaceCount: number, dataCount: number, drifts: readonly DriftItem[]): Partial<Record<Tab, [number, string]>> {
  return {
    dec: [pendingDecisions(decs).length, 'tab-c alert'], iface: [ifaceCount, 'tab-c'], data: [dataCount, 'tab-c'],
    chg: [drifts.filter((d) => d.status === 'open').length, 'tab-c alert'],
  };
}

/* ---- 구성도·계약 파일 ---- */
const LAYERS = ['클라이언트', '서버', '팀장 PC', '데이터'];
const rejectedComp = (c: ComponentItem, decs: readonly DecisionItem[]) => c.decisionId !== null && decs.some((x) => x.id === c.decisionId && x.status === 'rejected');

export function layers(comps: readonly ComponentItem[], decs: readonly DecisionItem[]) {
  const names = [...LAYERS, ...comps.map((c) => c.layer).filter((l, i, a) => !LAYERS.includes(l) && a.indexOf(l) === i)];
  return names.map((l) => ({
    l,
    comps: comps.filter((c) => c.layer === l).map((c) => {
      const dc = decs.find((x) => x.id === c.decisionId);
      const cls = rejectedComp(c, decs) ? 'ds-comp off' : dc && (dc.status === 'pending' || dc.status === 'change') ? 'ds-comp pend' : 'ds-comp';
      return { id: c.id, name: c.name, tech: c.tech, note: c.note, cls, decL: dc ? `${dc.tdKey} ${(DECISION_STATUS[dc.status] ?? ['—'])[0]}` : '' };
    }),
  })).filter((x) => x.comps.length > 0);
}

export function visibleLinks(comps: readonly ComponentItem[], links: readonly LinkItem[], decs: readonly DecisionItem[]) {
  const byId = new Map(comps.map((c) => [c.id, c]));
  return links.filter((k) => {
    const a = byId.get(k.from); const b = byId.get(k.to);
    return a && b && !rejectedComp(a, decs) && !rejectedComp(b, decs);
  }).map((k) => ({ from: byId.get(k.from)?.name ?? k.from, to: byId.get(k.to)?.name ?? k.to, how: k.via, file: k.contractPath ?? '—' }));
}

const FILE_STATUS: Record<string, Label> = { ok: ['읽음', 'vf v-pass'], draft: ['브랜치 초안', 'vf v-run'], error: ['읽기 실패', 'vf v-fail'] };
export function fileRows(files: readonly FileItem[], drifts: readonly DriftItem[]) {
  return files.map((f) => {
    const [stL, stC] = FILE_STATUS[f.status] ?? ['—', 'vf v-none'];
    const commit = f.status === 'error' ? (f.sourceCommit ? `${short(f.sourceCommit)} (마지막 성공)` : '— (성공한 적 없음)') : short(f.sourceCommit ?? f.commit) || '—';
    const unchecked = drifts.some((d) => d.status === 'open' && d.compat === 'unchecked' && d.itemKey === `file:${f.path}`);
    return { path: f.path, kind: f.kind, format: f.format, commit, stL, stC, unchecked };
  });
}
export function parseErrors(files: readonly FileItem[]) {
  return files.filter((f) => f.status === 'error').map((f) =>
    `${f.path} — ${f.error ?? '읽기 실패'} · ${f.sourceCommit ? `마지막 성공 버전(${short(f.sourceCommit)})으로 표시합니다.` : '성공한 버전이 없어 항목을 표시하지 않습니다.'}`);
}

/* ---- 인터페이스·데이터 목록 ---- */
const IFACE_KINDS: [string, string][] = [['', '전체'], ['REST', 'REST'], ['WebSocket', 'WebSocket'], ['SSE', 'SSE'], ['Kafka', '이벤트 (Kafka)']];
export const kindCounts = (items: readonly IfaceItem[]) => IFACE_KINDS.map(([k, l]) => [k, l, items.filter((x) => !k || x.kind === k).length] as const);
export const STORES: [string, string][] = [['postgres', 'PostgreSQL'], ['neo4j', 'Neo4j'], ['questdb', 'QuestDB'], ['redis', 'Redis']];
export const storeCounts = (items: readonly DataItem[]) => STORES.map(([k, l]) => [k, l, items.filter((x) => x.store === k).length] as const);
const KIND_L: Record<string, string> = { postgres: 'PostgreSQL', neo4j: 'Neo4j', questdb: 'QuestDB', redis: 'Redis 키' };

export interface ListFilter { kind?: string; store?: string; q: string }
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * 목록 순서: 원본처럼 담당 Task 순(P Sel.dsRest·dsPg는 Task key 순), 같은 Task 안은 항목 key 순, 담당 Task 없음은 맨 뒤(조정자 결정 fix1-5).
 * 왜: 서버는 item_key 순으로 주지만, 팀장은 Task 단위로 설계를 본다. 이전·다음 이동도 이 순서를 따른다.
 */
const byTask = (a: { taskKey: string | null; key: string }, b: { taskKey: string | null; key: string }) =>
  (a.taskKey === null ? 1 : 0) - (b.taskKey === null ? 1 : 0) || cmp(a.taskKey ?? '', b.taskKey ?? '') || cmp(a.key, b.key);
export function itemRows(items: readonly (IfaceItem | DataItem)[], f: ListFilter, tasks: ReadonlyMap<string, TaskInfo>, drifts: readonly DriftItem[]) {
  const q = f.q.trim().toLowerCase();
  return [...items].sort(byTask).filter((x) => ('kind' in x ? !f.kind || x.kind === f.kind : !f.store || x.store === f.store))
    .filter((x) => !q || `${x.name} ${x.key}`.toLowerCase().includes(q))
    .map((x) => {
      const kind = 'kind' in x ? x.kind : x.store;
      const [stL, stC] = taskStat(x.taskKey ? tasks.get(x.taskKey) : undefined);
      return { key: x.key, name: x.name, kind, kindL: KIND_L[kind] ?? kind, stL, stC, task: x.taskKey ?? '—', taskKey: x.taskKey, fileError: x.status === 'error', mark: driftMark(drifts, x.key) };
    });
}
export type ItemRow = ReturnType<typeof itemRows>[number];

/** REST 상세의 「읽고 쓰는 테이블」: 서버는 이름 또는 `postgres:이름` 키를 준다. 데이터 탭 항목 key로 바꾼다. */
export function tableTarget(tables: readonly string[]) {
  const out = new Map<string, { n: string; key: string }>();
  for (const t of tables) {
    const key = t.startsWith('postgres:') ? t : `postgres:${t}`;
    if (!out.has(key)) out.set(key, { n: key.slice('postgres:'.length), key });
  }
  return [...out.values()];
}

/** 선택 행의 위치와 이전·다음 key */
export function position(rows: readonly { key: string }[], sel: string) {
  const i = rows.findIndex((r) => r.key === sel);
  return { i, label: `${String(i + 1)} / ${String(rows.length)}`, prev: i > 0 ? rows[i - 1]?.key ?? null : null, next: i >= 0 && i < rows.length - 1 ? rows[i + 1]?.key ?? null : null };
}
