/**
 * 처리 중 표시가 있는 버튼(로딩 5종 중 「버튼 안 진행 표시」, G§0.3).
 * busy 동안 버튼 안에 작은 스피너와 「…중」 문구를 보이고 비활성으로 만들어 두 번 누르기를 막는다.
 */
import type { ButtonHTMLAttributes } from 'react';

export interface BusyButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy: boolean;
  /** 처리 중 문구. 예: 「저장 중…」 */
  busyLabel: string;
  variant?: 'primary' | 'danger' | 'ghost' | 'default';
  small?: boolean;
}

export function BusyButton({ busy, busyLabel, variant = 'primary', small = false, children, disabled, className, type = 'button', ...rest }: BusyButtonProps) {
  const cls = ['btn', variant === 'default' ? '' : variant, small ? 'sm' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button {...rest} type={type} className={cls} disabled={busy || disabled} aria-busy={busy || undefined}>
      {busy ? (
        <>
          <span className="bspin" aria-hidden="true" />
          {busyLabel}
        </>
      ) : children}
    </button>
  );
}
