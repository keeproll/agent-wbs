/**
 * 동시 수정 충돌 창(MOD-01) — 409 VERSION_CONFLICT를 받으면 연다.
 * 원본은 「마지막 이력 한 줄」을 보여 줬지만(MM-20) 제품은 서버가 돌려준 같은 대상의 변경 목록(details.changes)을 보인다.
 * 선택지: 최신 내용 불러오기(내 변경 버림) / 최신 내용에 내 변경 다시 적용.
 */
import type { ApiError } from '../api/client.ts';
import { formatDateTime } from '../format.ts';
import { BusyButton } from './BusyButton.tsx';
import { Modal } from './Modal.tsx';

export interface ConflictChange { at: string; actor: string; field: string; before: unknown; after: unknown }

/** 409 본문의 details.changes를 꺼낸다(contracts §1 「동시 수정」). 모양이 다르면 빈 목록. */
export function conflictChanges(error: ApiError): ConflictChange[] {
  const changes = (error.body?.error.details as { changes?: unknown } | undefined)?.changes;
  if (!Array.isArray(changes)) return [];
  return changes.filter((c): c is ConflictChange =>
    typeof c === 'object' && c !== null && typeof (c as ConflictChange).at === 'string' && typeof (c as ConflictChange).actor === 'string');
}

const show = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '없음';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

export interface ConflictModalProps {
  error: ApiError;
  /** 내 변경 설명. 예: 「Task 제목: 새 제목」 */
  mine: string;
  /** 내가 저장을 시도한 시각(ms) */
  at: number;
  onReload: () => void;
  onReapply: () => void;
  /** Esc: 아무것도 저장·폐기하지 않고 창만 닫는다. 입력은 그대로 남는다. */
  onClose: () => void;
  /** 다시 적용 요청을 보내는 중 */
  busy?: boolean;
}

export function ConflictModal({ error, mine, at, onReload, onReapply, onClose, busy = false }: ConflictModalProps) {
  const changes = conflictChanges(error);
  return (
    <Modal
      title="다른 변경이 먼저 저장되었습니다"
      meta={<span className="mono muted">{error.status} {error.code}</span>}
      style={{ width: 'min(620px,100%)' }}
      onCancel={onClose}
      initialFocus=".modal-f .btn"
      footer={(
        <>
          <button type="button" className="btn" onClick={onReload} disabled={busy}>최신 내용 불러오기 (내 변경 버림)</button>
          <BusyButton busy={busy} busyLabel="다시 적용 중…" onClick={onReapply}>최신 내용에 내 변경 다시 적용</BusyButton>
        </>
      )}
    >
      <p>내가 이 화면을 연 뒤 같은 대상이 먼저 변경되었습니다. 내 변경을 그대로 저장하면 먼저 저장된 내용을 덮어쓸 수 있어 저장을 멈췄습니다.</p>
      <div className="kv" style={{ gridTemplateColumns: '110px minmax(0,1fr)' }}>
        <span className="kv-l">먼저 저장된 변경</span>
        <span className="kv-v">
          {changes.length === 0 ? (
            <span className="muted">서버가 변경 기록을 보내지 않았습니다. 최신 내용을 불러와 확인하세요.</span>
          ) : (
            <ul className="cf-list">
              {changes.map((change, i) => (
                <li key={i}>
                  {formatDateTime(change.at)} · {change.actor} — {change.field}: {show(change.before)} → {show(change.after)}
                </li>
              ))}
            </ul>
          )}
        </span>
        <span className="kv-l">내 변경</span>
        <span className="kv-v">{mine} <span className="muted">(아직 저장되지 않음 · {formatDateTime(at)})</span></span>
      </div>
      <p className="fhint" style={{ marginTop: 10 }}>
        「최신 내용에 내 변경 다시 적용」은 먼저 저장된 내용을 불러온 뒤 내 변경을 그 위에 다시 저장합니다. 같은 항목을 둘 다 바꿨다면 내 값이 남습니다.
      </p>
    </Modal>
  );
}
