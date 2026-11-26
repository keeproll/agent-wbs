/**
 * 화면 일부(실행 기록·검증·메시지 등)의 조회 실패. 빈 기록처럼 보이지 않게 이유와 「다시 시도」를 그 영역에 보인다(M3-06 리뷰 #3).
 * 왜: 조회 실패를 「기록 없음」으로 보이면 실행 중인 Task에 새 실행을 요청하게 된다.
 */
import type { ApiError } from '../../shared/api/client.ts';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { codeLabel } from '../../shared/ui/errors.ts';

/** what은 조사까지 넣는다. 예: 「실행 기록을」 */
export function AreaError({ what, error, retrying, onRetry }: { what: string; error: ApiError | Error; retrying: boolean; onRetry: () => void }) {
  const code = 'kind' in error ? codeLabel(error) : error.message;
  return (
    <div className="banner danger" role="alert">
      <div className="banner-b"><b>{what} 불러오지 못했습니다</b> — {code}. 기록이 없는 것이 아니라 아직 읽지 못한 것입니다. 다시 시도하세요.</div>
      <BusyButton small variant="default" busy={retrying} busyLabel="다시 불러오는 중…" onClick={onRetry}>다시 시도</BusyButton>
    </div>
  );
}
