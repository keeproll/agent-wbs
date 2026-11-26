/**
 * 모달 틀 — 원본 `.overlay > .modal` 모양 그대로, 원본에 없던 키보드 처리를 더했다(MM-29, UAT-STATE-10).
 *
 * - 열리면 포커스가 모달 안으로 들어가고 Tab/Shift+Tab이 모달 안에서만 돈다(포커스 가두기).
 * - Esc는 `onCancel`을 부른다(취소와 같다).
 * - 닫히면 모달을 열었던 컨트롤로 포커스를 돌려준다.
 * - 제목 ID는 useId로 만들어 화면 안에서 겹치지 않는다(원본 cf-t 중복 결함).
 */
import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  title: ReactNode;
  /** 제목 오른쪽 작은 글씨(예: `409 VERSION_CONFLICT`) */
  meta?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  onCancel: () => void;
  /** sm = 480px(원본 .modal.sm). 원본은 모달마다 폭이 달라 style로 덮어쓴다(MOD-01은 620px). */
  size?: 'sm' | 'lg';
  style?: CSSProperties;
  /** 확인을 요구하는 창은 alertdialog(원본과 같다) */
  role?: 'dialog' | 'alertdialog';
  /** 처음 포커스할 요소를 고르는 CSS 선택자. 없으면 첫 컨트롤 */
  initialFocus?: string;
}

export function Modal({ title, meta, children, footer, onCancel, size = 'sm', style, role = 'alertdialog', initialFocus }: ModalProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  useEffect(() => { cancel.current = onCancel; });

  // 화면에 그리기 전에(useLayoutEffect) 포커스와 Esc·Tab 처리를 붙인다. 창이 보이는 순간부터 Esc가 듣는다.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = ref.current;
    const target = (initialFocus ? box?.querySelector<HTMLElement>(initialFocus) : null) ?? box?.querySelector<HTMLElement>(FOCUSABLE) ?? box;
    target?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); cancel.current(); return; }
      if (event.key !== 'Tab' || !box) return;
      // 모달 안 컨트롤 + 모달 위에 뜬 오류 막대의 버튼(다시 시도·닫기)을 한 바퀴로 돈다.
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE), ...document.querySelectorAll<HTMLElement>(`.errbar[role="alert"] :is(${FOCUSABLE})`)];
      event.preventDefault();
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = at === -1 ? (event.shiftKey ? items.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [initialFocus]);

  return (
    <div className="overlay">
      <div ref={ref} className={size === 'sm' ? 'modal sm' : 'modal'} role={role} aria-modal="true" aria-labelledby={titleId} style={style} tabIndex={-1}>
        <div className="modal-h">
          <h2 id={titleId}>{title}</h2>
          {meta}
        </div>
        <div className="modal-b">{children}</div>
        <div className="modal-f">
          <span className="sp" />
          {footer}
        </div>
      </div>
    </div>
  );
}
