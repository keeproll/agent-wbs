/**
 * PDF 자산(화면 CSS·글꼴)을 api 빌드 산출물 안에 넣는 규칙(조정자 지시: api만 배포해도 동작).
 * - 빌드는 `copyPdfAssets(dist/pdf/assets)`로 웹 CSS와 글꼴 파일을 복사한다.
 * - 빌드 산출물(dist)에서 실행하면 그 복사본만 읽는다. 웹 소스(apps/web/src)를 찾지 않는다.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { assetSource, copyPdfAssets, FONT_FILES, loadPdfAssets } from '../src/pdf/assets.ts';

const root = await mkdtemp(join(tmpdir(), 'awbs-pdf-assets-'));
afterAll(() => rm(root, { recursive: true, force: true }));

test('복사한 자산 폴더만으로 CSS와 글꼴 4개를 읽는다(내용은 원본과 같다)', async () => {
  const dir = join(root, 'assets');
  await copyPdfAssets(dir);
  const assets = loadPdfAssets(dir);
  expect(assets.css).toBe(await readFile(new URL('../../web/src/shared/styles/prototype.css', import.meta.url), 'utf8'));
  expect([...assets.fonts.keys()]).toEqual(Object.values(FONT_FILES).map((name) => `/fonts/PretendardGOV-${name}.woff2`));
  for (const data of assets.fonts.values()) expect(data.subarray(0, 4).toString('latin1')).toBe('wOF2');
});

test('자산 폴더가 비었으면 바로 실패한다(다른 곳을 찾지 않는다)', () => {
  expect(() => loadPdfAssets(join(root, 'none'))).toThrow(/PDF 자산/);
});

test('빌드 산출물에서는 복사본만, 소스에서는 웹 소스를 읽는다', () => {
  expect(assetSource('file:///srv/awbs/apps/api/dist/pdf/assets.js')).toEqual({ kind: 'bundled', dir: '/srv/awbs/apps/api/dist/pdf/assets' });
  expect(assetSource('file:///repo/apps/api/src/pdf/assets.ts').kind).toBe('source');
});
