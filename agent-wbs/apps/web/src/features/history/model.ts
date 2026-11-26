/**
 * 이력 화면(UI-10)의 화면 없는 계산. 원본 hVM(P L6448–6460)을 옮기고, 원본에 없던 기간 필터(MM-18)를 더했다.
 *
 * 어디서 거르나:
 * - 기간(from·to): 서버(GET /api/history?from&to). 날짜는 Asia/Seoul 기준이고 두 날짜 모두 포함이다.
 *   왜 서버인가: 기간 밖의 이력을 내려받을 필요가 없고, 날짜 경계(시간대)는 서버 규칙 하나로 정해야 한다(UAT-HISTORY-01).
 * - 유형·주체·Task ID·검색: 화면. 받은 기간 안의 이력 전체에서 거른다.
 *   왜 화면인가: 선택지(유형·주체 버튼)를 받은 이력에서 만들고, 「전체 N건 중」을 함께 보여 주려면 기간 안의 전체가 필요하다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';

export type HistoryItem = ResponseOf<'listHistory'>['items'][number];

export interface HistoryFilter {
  q: string;
  task: string;
  kind: string;
  actor: string;
  /** YYYY-MM-DD 또는 빈칸 */
  from: string;
  to: string;
}
export const EMPTY_HISTORY_FILTER: HistoryFilter = { q: '', task: '', kind: '', actor: '', from: '', to: '' };

/** 원본처럼 최신 300건만 그린다(P L6458). 나머지는 건수 문구로 알린다. */
export const MAX_ROWS = 300;

/** 최신순. 같은 시각이면 id 내림차순(서버 정렬과 같은 규칙) */
export const sortHistory = (items: readonly HistoryItem[]): HistoryItem[] =>
  [...items].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));

export function filterHistory(items: readonly HistoryItem[], f: HistoryFilter): HistoryItem[] {
  const q = f.q.trim().toLowerCase();
  const task = f.task.trim().toUpperCase();
  return sortHistory(items).filter((h) =>
    (!f.kind || h.kind === f.kind)
    && (!f.actor || h.actor === f.actor)
    && (!task || (h.taskKey ?? '').includes(task))
    && (!q || `${h.text} ${h.before ?? ''} ${h.after ?? ''}`.toLowerCase().includes(q)));
}

/** 유형·주체 버튼. 받은 이력에 실제로 있는 값만, 처음 나온 순서로(P uniq L6450) */
export function historyOptions(items: readonly HistoryItem[]): { kinds: string[]; actors: string[] } {
  const uniq = (values: string[]) => values.filter((v, i) => values.indexOf(v) === i);
  return { kinds: uniq(items.map((h) => h.kind)), actors: uniq(items.map((h) => h.actor)) };
}

export function countLabel(shown: number, total: number): string {
  return `이력 ${String(shown)}건${shown !== total ? ` (전체 ${String(total)}건 중)` : ''}${shown > MAX_ROWS ? ` · 최신 ${String(MAX_ROWS)}건 표시` : ''}`;
}

/** 「이전 → 이후」 칸(P L6459) */
export const diffText = (h: HistoryItem): string =>
  h.before || h.after ? `${h.before || '—'} → ${h.after || '—'}` : '';

export const isFiltered = (f: HistoryFilter): boolean =>
  Boolean(f.q.trim() || f.task.trim() || f.kind || f.actor || f.from || f.to);

/** 끝 날짜가 시작보다 빠르면 서버가 400(range)으로 거부한다. 보내기 전에 같은 문구로 막는다. */
export function rangeProblem(from: string, to: string): string | null {
  return from && to && to < from ? '끝 날짜가 시작 날짜보다 빠릅니다.' : null;
}
