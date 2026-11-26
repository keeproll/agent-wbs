/**
 * Task 일정 표시(요약·개요). 원본은 화면에서 일정을 직접 계산했지만(P L4250–4270),
 * 제품은 서버가 계산한 값(TaskSummary.schedule)만 보여 준다. 여기서는 「기준 대비」 문구만 원본 규칙대로 만든다.
 */
import type { TaskSummaryData } from './labels.ts';

/** P L3415 */
export const fmtH = (h: number) => `${String(Math.round(h * 10) / 10)}h`;
/** 'YYYY-MM-DD' → 'MM-DD'(원본 Cal.md) */
export const md = (date: string | null | undefined) => (date ? date.slice(5, 10) : '—');

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const NOT_STARTED = new Set(['planning', 'approval', 'ready']);

/** 기준 대비 문구·색(P L4264–4269). 서버 일정이 없으면 null */
export function slipState(t: Pick<TaskSummaryData, 'lifecycleStatus' | 'schedule'>): { l: string; c: string } | null {
  const sc = t.schedule;
  if (!sc?.end) return null;
  const isNew = !sc.baselineEnd;
  const slip = sc.baselineEnd ? dayDiff(sc.end, sc.baselineEnd) : 0;
  const status = String(t.lifecycleStatus);
  if (status === 'done') return { l: isNew ? '완료' : slip > 0 ? `지연 완료 +${String(slip)}일` : '기준 내 완료', c: slip > 0 && !isNew ? 'sc-warn' : 'sc-ok' };
  if (status === 'paused') return { l: '중단 · 재개 대기', c: 'sc-warn' };
  if (isNew) return { l: '신규 — 다음 기준 반영', c: 'sc-none' };
  if (slip > 0) return { l: `기준 대비 +${String(slip)}일`, c: 'sc-bad' };
  if (slip < 0) return { l: `기준보다 ${String(-slip)}일 빠름`, c: 'sc-ok' };
  const started = !NOT_STARTED.has(status);
  return { l: started ? '진행 · 기준 일정' : '기준 일정', c: started ? 'sc-ok' : 'sc-none' };
}
