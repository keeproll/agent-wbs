/**
 * 디자인 토큰 — 원본 프로토타입 값을 그대로 옮긴 이름표.
 *
 * - CSS에서는 `var(--ac)`처럼 CSS 변수(prototype.css의 :root)를 쓴다.
 * - 이 파일은 TypeScript 안에서 값이 꼭 필요할 때만 쓴다(예: SVG 차트 색, 레이아웃 계산).
 * - 값은 docs/ui/design-tokens.md와 원본 Main.dc.html이 정본이다. test/tokens.test.ts가 원본과 같은지 검사한다.
 */

/** 원본 L16 :root 색. 이름은 원본 약어 그대로(bg=배경, sf=표면, ln=경계, ink=글자, ac=강조, dg=위험, wn=경고, ok=성공). */
export const COLOR = {
  bg: '#F4F5F7',
  sf: '#FFFFFF',
  sf2: '#F8F9FB',
  ln: '#E1E4E9',
  ln2: '#C9CED6',
  ink: '#16191E',
  ink2: '#3E4651',
  ink3: '#5A6270',
  ac: '#2453CF',
  acbg: '#EAF0FD',
  dg: '#B42318',
  dgbg: '#FDEDEB',
  wn: '#8F4700',
  wnbg: '#FFF2E2',
  ok: '#1B7339',
  okbg: '#E5F3E9',
} as const;

/** 원본 L16 --font, L18 body. 고정폭 글꼴은 따로 쓰지 않는다(--mono = --font). */
export const FONT = {
  family: "'Pretendard GOV Variable','Pretendard GOV',-apple-system,BlinkMacSystemFont,system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif",
  bodySize: 13,
  lineHeight: 1.5,
} as const;

/** 원본 레이아웃 값(px). 출처 줄: hdr L28, nav L49–50·L644, page L58, modal L346–347. */
export const LAYOUT = {
  headerHeight: 64,
  navWidth: 180,
  navCollapsedWidth: 56,
  /** 760px 이하에서 펼친 메뉴 폭(L644) */
  navWidthNarrow: 60,
  narrowBreakpoint: 760,
  pagePadding: '20px 24px 0',
  modalWidth: 1080,
  modalSmWidth: 480,
  /** D-28: 이 폭 미만에서는 표 컨테이너만 가로 스크롤한다. */
  fullSupportWidth: 1280,
} as const;

/** 자주 쓰는 반경(원본 CSS 고유값 중 일부). 전체 목록은 design-tokens.md. */
export const RADIUS = {
  control: '6px',
  card: '8px',
  modal: '10px',
  pill: '999px',
  round: '50%',
} as const;

/** 원본 CSS의 그림자 값 */
export const SHADOW = {
  menu: '0 8px 24px rgba(0,0,0,.12)',
  modal: '0 20px 60px rgba(0,0,0,.25)',
  notice: '0 8px 24px rgba(0,0,0,.2)',
  chip: '0 4px 14px rgba(0,0,0,.18)',
} as const;

/** 움직임 값(원본 L579 skeleton, L594 topbar, L597 bspin) */
export const MOTION = {
  skeleton: '1.2s linear infinite',
  topbar: '0.9s ease-in-out infinite',
  spinner: '.7s linear infinite',
} as const;
