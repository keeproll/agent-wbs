/** WBS 표·레일·상세 머리가 함께 쓰는 작은 표시 조각(원본 클래스 그대로). */
import { statusOf } from './model.ts';

/** 원본 인라인 아이콘(P L800·862·884·885·805) */
export const WBS_ICON = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  caret: 'M9 6l6 6-6 6',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z',
  check: 'M5 12l4 4 10-10',
  expand: 'M4 12h16M14 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
} as const;

export function SmIcon({ d }: { d: string }) {
  return <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
}

export function StatusPill({ status }: { status: unknown }) {
  const st = statusOf(status);
  return <span className={`st ${st.c}`} title={st.tip}><span className="st-d" aria-hidden="true" />{st.l}</span>;
}
