/**
 * 공용 확인창(MOD-08) — 원본 `.modal.sm` + 취소/확인 두 버튼.
 * 확인을 누르기 전에는 아무것도 바꾸지 않는다. 위험한 동작은 빨간 버튼(danger)을 쓴다.
 * 직접 쓰기보다 `useConfirm()`(feedback.tsx)을 쓴다.
 */
import { Modal } from './Modal.tsx';

export interface ConfirmOptions {
  title: string;
  body: string;
  /** 확인 버튼 문구. 예: 「저장하지 않고 이동」 */
  ok: string;
  danger?: boolean;
}

export function ConfirmModal({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (ok: boolean) => void }) {
  return (
    <Modal
      title={options.title}
      onCancel={() => { onAnswer(false); }}
      footer={(
        <>
          <button type="button" className="btn" onClick={() => { onAnswer(false); }}>취소</button>
          <button type="button" className={options.danger ? 'btn danger' : 'btn primary'} onClick={() => { onAnswer(true); }}>{options.ok}</button>
        </>
      )}
    >
      <p>{options.body}</p>
    </Modal>
  );
}
