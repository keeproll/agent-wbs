/**
 * 빈 목록 안내 — 두 가지를 꼭 구분한다(G§0.3 「빈 목록 안내」).
 * - none: 아직 기록이 없음. 무엇이 생기면 여기에 보이는지 안내한다.
 * - filtered: 조건에 맞는 결과 없음. 필터를 바꾸라고 안내하고 「필터 초기화」를 둔다.
 * 원본 `.empty-st`(P L139, 예: P L895 「조건에 맞는 Task가 없습니다.」) 모양.
 */
import type { ReactNode } from 'react';

export type EmptyStateProps =
  | { kind: 'none'; message: string; hint?: ReactNode }
  | { kind: 'filtered'; message: string; onReset: () => void };

export function EmptyState(props: EmptyStateProps) {
  return (
    <div className="empty-st" role="status" data-empty={props.kind}>
      {props.message}{' '}
      {props.kind === 'filtered'
        ? <button type="button" className="btn sm" onClick={props.onReset}>필터 초기화</button>
        : props.hint && <div className="fhint">{props.hint}</div>}
    </div>
  );
}
