/**
 * 시각 비교 도구 — 원본 스크린샷과 구현 화면의 같은 영역을 잘라 픽셀 차이를 재고,
 * [원본 | 구현 | 차이] 세 장을 나란히 붙인 PNG를 남긴다.
 * 차이 픽셀: pixelmatch(threshold 0.1, 안티에일리어싱 무시)로 색 차이가 큰 픽셀.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export const BASELINE = process.env.AWBS_BASELINE_DIR ?? join(homedir(), '.cache/agent-wbs-baseline');
export const OUT = process.env.AWBS_VISUAL_OUT ?? join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M3-01/visual');

export interface Box { x: number; y: number; width: number; height: number }

function crop(png: PNG, box: Box): PNG {
  const out = new PNG({ width: box.width, height: box.height });
  PNG.bitblt(png, out, box.x, box.y, box.width, box.height, 0, 0);
  return out;
}

export interface VisualResult { name: string; ratio: number; diffPixels: number; size: string; file: string }

/** baselineBox와 actualBox는 크기가 달라도 된다(겹치는 왼쪽 위 기준 최소 크기로 비교). */
/** out: 결과를 남길 폴더. 기본은 M3-01 폴더(OUT). 다른 작업은 자기 폴더를 넘긴다(M3-05 추가, 기존 호출은 그대로). */
export function compareRegion(name: string, baselineFile: string, baselineBox: Box, actual: Buffer, actualBox: Box, out = OUT): VisualResult {
  const base = PNG.sync.read(readFileSync(join(BASELINE, baselineFile)));
  const ours = PNG.sync.read(actual);
  const width = Math.min(baselineBox.width, actualBox.width);
  const height = Math.min(baselineBox.height, actualBox.height);
  const a = crop(base, { ...baselineBox, width, height });
  const b = crop(ours, { ...actualBox, width, height });
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1, includeAA: false });
  const gap = 8;
  const sheet = new PNG({ width: width * 3 + gap * 2, height });
  sheet.data.fill(255);
  PNG.bitblt(a, sheet, 0, 0, width, height, 0, 0);
  PNG.bitblt(b, sheet, 0, 0, width, height, width + gap, 0);
  PNG.bitblt(diff, sheet, 0, 0, width, height, (width + gap) * 2, 0);
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.png`);
  writeFileSync(file, PNG.sync.write(sheet));
  return { name, ratio: diffPixels / (width * height), diffPixels, size: `${String(width)}×${String(height)}`, file };
}

export const hasBaseline = () => existsSync(BASELINE);

export function writeSummary(results: VisualResult[], notes: Record<string, string>, out = OUT): void {
  mkdirSync(out, { recursive: true });
  const lines = ['| 영역 | 크기 | 차이 픽셀 | 비율 | 기준 | 차이 원인 |', '|---|---|---:|---:|---|---|'];
  for (const r of results) lines.push(`| ${r.name} | ${r.size} | ${String(r.diffPixels)} | ${(r.ratio * 100).toFixed(2)}% | ${notes[`${r.name}:limit`] ?? ''} | ${notes[r.name] ?? ''} |`);
  writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
}
