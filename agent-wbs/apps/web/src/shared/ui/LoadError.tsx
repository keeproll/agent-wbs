/**
 * 화면 불러오기 실패(SYS-01 오류 카드) — 원본 P L692–700 모양.
 * 메뉴 제목·원인(코드)·확인할 것·마지막으로 불러온 시각·「다시 시도」를 보인다(UAT-STATE-04).
 * 원본의 「503 SERVICE_UNAVAILABLE」은 계약 코드 `503 UNAVAILABLE`로 바꿔 쓴다(contracts §1.1).
 */
import { useApi } from '../api/ApiProvider.tsx';
import type { ApiError } from '../api/client.ts';
import { formatDateTime } from '../format.ts';
import { Page } from '../layout/Page.tsx';
import { BusyButton } from './BusyButton.tsx';
import { codeLabel } from './errors.ts';

function reason(error: ApiError): string {
  const code = codeLabel(error);
  if (error.kind === 'timeout' || error.kind === 'unavailable') {
    return `Agent WBS 서버가 응답하지 않습니다 (${code}). 서버가 실행 중인지, 같은 PC에서 돌고 있다면 PC가 켜져 있는지 확인하세요.`;
  }
  if (error.kind === 'network') {
    return `Agent WBS 서버에 연결할 수 없습니다 (${code}). 서버가 실행 중인지, 같은 PC에서 돌고 있다면 PC가 켜져 있는지 확인하세요.`;
  }
  const body = error.body?.error;
  return `서버가 요청을 처리하지 못했습니다 (${code}).${body ? ` ${body.message} ${body.fix}` : ' 잠시 후 다시 시도하세요.'}`;
}

export function LoadError({ title, error, onRetry, retrying }: { title: string; error: ApiError; onRetry: () => void; retrying: boolean }) {
  const { lastSuccessAt } = useApi();
  const last = lastSuccessAt === null ? '마지막으로 불러온 시각 없음(이번 접속에서 아직 불러오지 못함)' : `마지막으로 불러온 시각 ${formatDateTime(lastSuccessAt)}`;
  return (
    <Page title={title}>
      <section className="card load-err" aria-labelledby="load-err-t">
        <h3 id="load-err-t">{title} 화면을 불러오지 못했습니다</h3>
        <p>{reason(error)}</p>
        <p className="fhint">{last} — 저장하지 않은 변경은 없습니다. Runner는 서버와 별개로 동작하며, 서버가 복구되면 밀린 보고를 다시 보냅니다.</p>
        <div className="form-acts" style={{ justifyContent: 'flex-start' }}>
          <BusyButton busy={retrying} busyLabel="다시 불러오는 중…" onClick={onRetry}>다시 시도</BusyButton>
        </div>
      </section>
    </Page>
  );
}
