/** 원본과 같은 선 아이콘(.ico: 18×18, 선 굵기 1.7, viewBox 0 0 24 24). 아이콘 패키지는 쓰지 않는다(design-tokens §아이콘). */
export const ICON = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  warning: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  check: 'M5 12l4 4 10-10',
  close: 'M6 6l12 12M18 6L6 18',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
} as const;

export function Icon({ d, small = false }: { d: string; small?: boolean }) {
  return (
    <svg className={small ? 'ico sm' : 'ico'} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
