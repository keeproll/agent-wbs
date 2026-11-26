/**
 * 원본 프로토타입(prototype/uiux/Main.dc.html)의 <style> 블록을 그대로 옮겨
 * src/shared/styles/prototype.css를 만든다. 값은 한 글자도 바꾸지 않는다.
 *
 *   node apps/web/scripts/prototype-css.ts          # 다시 만들기
 *   node apps/web/scripts/prototype-css.ts --check  # 최신인지 확인만(다르면 종료 코드 1)
 *
 * 왜 손으로 옮기지 않나: 600줄이 넘는 CSS를 손으로 옮기면 빠뜨리거나 값을 바꾸기 쉽다.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PROTOTYPE = resolve(import.meta.dirname, '../../../../prototype/uiux/Main.dc.html');
export const OUTPUT = resolve(import.meta.dirname, '../src/shared/styles/prototype.css');

/**
 * 원본 줄 중 옮기지 않는 것. 이유를 함께 적는다.
 * - L14 @font-face: 원본은 ./assets 파일과 jsDelivr(외부 주소)를 쓴다. 제품은 번들한 pretendard-gov 1.3.9를 쓴다(fonts.css).
 * - L15: L14 설명 주석.
 */
export const SKIPPED_LINES: Readonly<Record<number, string>> = {
  14: '@font-face — fonts.css에서 번들 글꼴로 대신 정의',
  15: 'L14 설명 주석',
};

export function buildPrototypeCss(html: string): string {
  const lines = html.split('\n');
  const start = lines.findIndex((line) => line.trim() === '<style>');
  const end = lines.findIndex((line, i) => i > start && line.trim() === '</style>');
  if (start < 0 || end < 0) throw new Error('원본에서 <style> 블록을 찾지 못했습니다.');
  const sha = createHash('sha256').update(html).digest('hex');
  const out = [
    '/*',
    ' * 자동 생성 파일 — 직접 고치지 마세요. (apps/web/scripts/prototype-css.ts)',
    ` * 원본: prototype/uiux/Main.dc.html <style> L${String(start + 2)}–L${String(end)}`,
    ` * 원본 SHA-256: ${sha}`,
    ' * 각 줄 앞의 L번호는 원본 줄 번호다(docs/ui/design-tokens.md 부록과 같은 표기).',
    ' * 제품이 원본과 다르게 해야 하는 규칙은 product.css에 따로 적는다.',
    ' */',
  ];
  for (let i = start + 1; i < end; i++) {
    const no = i + 1;
    const skipped = SKIPPED_LINES[no];
    out.push(skipped ? `/* L${String(no)} 옮기지 않음: ${skipped} */` : `/* L${String(no)} */ ${lines[i] ?? ''}`);
  }
  return `${out.join('\n')}\n`;
}

if (import.meta.main) {
  const css = buildPrototypeCss(readFileSync(PROTOTYPE, 'utf8'));
  if (process.argv.includes('--check')) {
    if (readFileSync(OUTPUT, 'utf8') !== css) {
      process.stderr.write('prototype.css가 원본과 다릅니다. node apps/web/scripts/prototype-css.ts로 다시 만드세요.\n');
      process.exitCode = 1;
    }
  } else {
    writeFileSync(OUTPUT, css);
  }
}
