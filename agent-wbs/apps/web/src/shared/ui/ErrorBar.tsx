/**
 * 저장 오류 막대(SYS-02) — 원본 `.errbar` 모양 그대로.
 * 제목·코드·원인/조치·대상 동작·시각을 보이고, 다시 보내도 되는 오류(500·네트워크·응답 없음·503)에만 「다시 시도」를 둔다.
 * 400은 「다시 시도」 없이 고칠 항목을 보인다(UAT-STATE-07).
 */
import type { ApiError } from '../api/client.ts';
import { formatDateTime } from '../format.ts';
import { causeMessage, causeTitle, codeLabel } from './errors.ts';
import { ICON, Icon } from './Icon.tsx';

export interface ErrorBarState {
  error: ApiError;
  /** 하려던 동작. 예: 「Task 제목 저장」 */
  target: string;
  /** 제목 앞부분. 기본 「저장하지 못했습니다」 */
  failTitle?: string;
  at: number;
  /** 같은 요청을 다시 보낸다. 없으면 「다시 시도」를 보이지 않는다. */
  retry?: () => void;
  retrying?: boolean;
}

export function ErrorBar({ state, onClose }: { state: ErrorBarState; onClose: () => void }) {
  const { error, target, at, retry, retrying = false } = state;
  const fields = error.kind === 'validation' ? error.fieldErrors : [];
  return (
    <div className="errbar" role="alert">
      <Icon d={ICON.warning} />
      <div className="errbar-b">
        <b>{state.failTitle ?? '저장하지 못했습니다'} — {causeTitle(error)}</b> <span className="mono">{codeLabel(error)}</span>
        <div>{causeMessage(error)}</div>
        {fields.length > 0 && (
          <ul className="errbar-fields" aria-label="고칠 항목">
            {fields.map((field) => <li key={`${field.path}:${field.rule}`}><span className="mono">{field.path}</span> — {field.message}</li>)}
          </ul>
        )}
        {error.kind === 'rateLimited' && error.retryAfterSec !== null && <div>{error.retryAfterSec}초 뒤에 다시 시도할 수 있습니다.</div>}
        <div className="muted">대상: {target} · {formatDateTime(at)}</div>
      </div>
      <div className="errbar-a">
        {retry && (
          <button type="button" className="btn primary sm" onClick={retry} disabled={retrying}>
            {retrying ? <><span className="bspin" aria-hidden="true" />다시 시도 중…</> : '다시 시도'}
          </button>
        )}
        <button type="button" className="btn ghost sm" onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}
