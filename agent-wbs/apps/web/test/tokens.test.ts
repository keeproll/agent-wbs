import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrototypeCss, OUTPUT, PROTOTYPE } from '../scripts/prototype-css.ts';
import { COLOR, FONT, LAYOUT, RADIUS, SHADOW, MOTION } from '../src/shared/tokens/tokens.ts';

const html = readFileSync(PROTOTYPE, 'utf8');
const css = readFileSync(OUTPUT, 'utf8');
/** 원본 L16 :root 변수 */
const root = Object.fromEntries(
  [...(/:root\{([^}]*)\}/.exec(html)?.[1] ?? '').matchAll(/--([\w-]+):([^;]+)/g)].map((m) => [m[1], m[2]]),
);

describe('디자인 토큰(tokens)', () => {
  it('prototype.css는 원본 <style>을 그대로 옮긴 최신 파일이다', () => {
    expect(css).toBe(buildPrototypeCss(html));
  });

  it('TS 색 토큰은 원본 :root 값과 같다', () => {
    const expected = Object.fromEntries(Object.entries(root).filter(([k]) => k !== 'font' && k !== 'mono'));
    expect(COLOR).toEqual(expected);
  });

  it('글꼴·레이아웃·반경·그림자 토큰은 원본 CSS에 그대로 있다', () => {
    expect(FONT.family).toBe(root.font);
    for (const rule of [
      `.hdr{height:${LAYOUT.headerHeight}px`,
      `.nav{width:${LAYOUT.navWidth}px`,
      `.nav.collapsed{width:${LAYOUT.navCollapsedWidth}px}`,
      `.page{flex:1;display:flex;flex-direction:column;min-height:0;padding:${LAYOUT.pagePadding}}`,
      `.modal{width:min(${LAYOUT.modalWidth}px,100%)`,
      `.modal.sm{width:min(${LAYOUT.modalSmWidth}px,100%)}`,
      `.nav{width:${LAYOUT.navWidthNarrow}px}`,
    ]) expect(css).toContain(rule);
    for (const value of Object.values(RADIUS)) expect(css).toContain(`border-radius:${value}`);
    for (const value of Object.values(SHADOW)) expect(css).toContain(`box-shadow:${value}`);
    expect(css).toContain(`@media (max-width:${String(LAYOUT.narrowBreakpoint)}px)`);
    expect(css).toContain(`animation:skm ${MOTION.skeleton}`);
  });
});
