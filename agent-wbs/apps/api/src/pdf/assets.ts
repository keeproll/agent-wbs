/**
 * PDF 자산: 화면 CSS(`prototype.css`)와 글꼴 파일(Pretendard GOV 1.3.9 고정 굵기 4개).
 *
 * 어디서 읽나:
 * - 빌드 산출물(`apps/api/dist`)에서 실행할 때는 **빌드가 복사해 둔 `dist/pdf/assets/`만** 읽는다.
 *   왜: 운영에는 api만 배포한다. 웹 소스(`apps/web/src`)나 글꼴 패키지가 없어도 PDF를 만들 수 있어야 한다.
 * - 소스(`apps/api/src`)에서 실행할 때(개발·시험)는 웹 CSS와 글꼴 패키지를 바로 읽는다. 복사본이 없으니 원본을 쓴다.
 * - 빌드는 `copyPdfAssets()`로 복사한다(`scripts/copy-pdf-assets.ts`, `pnpm --filter @awbs/api build`).
 *
 * CSS를 복사하지 않고 웹 파일 하나를 원본으로 두는 이유: 화면과 PDF가 같은 CSS를 써야 하기 때문이다(G L410).
 */
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 글꼴 굵기별 파일 이름. HTML은 `/fonts/PretendardGOV-<이름>.woff2`로 요청하고 렌더러가 응답한다. */
export const FONT_FILES = { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold' } as const;
const fontFile = (name: string) => `PretendardGOV-${name}.woff2`;

export interface PdfAssets { css: string; fonts: ReadonlyMap<string, Buffer> }

/** 이 모듈 위치로 읽을 곳을 정한다. `/src/pdf/`에서 실행하면 소스, 그 밖(빌드 산출물)은 옆의 `assets/` 폴더다. */
export function assetSource(moduleUrl: string): { kind: 'bundled' | 'source'; dir: string } {
  const here = dirname(fileURLToPath(moduleUrl));
  return /[/\\]src[/\\]pdf$/.test(here) ? { kind: 'source', dir: here } : { kind: 'bundled', dir: join(here, 'assets') };
}

/** 원본 위치(빌드가 복사할 때와 소스 실행 때만 쓴다). */
function sources() {
  const css = fileURLToPath(new URL('../../../web/src/shared/styles/prototype.css', import.meta.url));
  const fonts = join(dirname(createRequire(import.meta.url).resolve('pretendard-gov/package.json')), 'dist', 'web', 'static', 'woff2');
  return { css, fonts };
}

/** 자산 폴더(`prototype.css`, `fonts/*.woff2`)에서 읽는다. 하나라도 없으면 실패한다. */
export function loadPdfAssets(dir: string): PdfAssets {
  return read(join(dir, 'prototype.css'), join(dir, 'fonts'));
}

function read(cssPath: string, fontDir: string): PdfAssets {
  const files = [cssPath, ...Object.values(FONT_FILES).map((name) => join(fontDir, fontFile(name)))];
  const lost = files.filter((path) => !existsSync(path));
  if (lost.length) throw new Error(`PDF 자산이 없습니다: ${lost.join(', ')} — api를 다시 빌드하세요(pnpm --filter @awbs/api build).`);
  return {
    css: readFileSync(cssPath, 'utf8'),
    fonts: new Map(Object.values(FONT_FILES).map((name) => [`/fonts/${fontFile(name)}`, readFileSync(join(fontDir, fontFile(name)))])),
  };
}

let loaded: PdfAssets | undefined;
/** 실행 중 한 번만 읽는다. */
export function pdfAssets(): PdfAssets {
  if (loaded) return loaded;
  const where = assetSource(import.meta.url);
  if (where.kind === 'bundled') loaded = loadPdfAssets(where.dir);
  else { const s = sources(); loaded = read(s.css, s.fonts); }
  return loaded;
}

/** 빌드 때 자산을 outDir에 복사한다. */
export async function copyPdfAssets(outDir: string): Promise<void> {
  const s = sources();
  await mkdir(join(outDir, 'fonts'), { recursive: true });
  await copyFile(s.css, join(outDir, 'prototype.css'));
  for (const name of Object.values(FONT_FILES)) await copyFile(join(s.fonts, fontFile(name)), join(outDir, 'fonts', fontFile(name)));
}
