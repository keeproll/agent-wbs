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
/** out: 결과 폴더(기본 OUT). 마일스톤마다 다른 보관 폴더에 남길 때 준다. */
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

/**
 * 시도 머리의 지정 · 실제 하위 Agent 태그 영역(UAT-TASK-10). 구현은 요소 위치로, 원본은 「지정」 태그 왼쪽 위(원본 PNG에서 #EEF3FF로 잰 값)로 맞춘다.
 * 폭·높이는 구현의 「지정」부터 「실제」 태그 끝까지(+ 가장자리 2px). 태그 글자·폭·색이 다르면 차이가 커진다.
 */
export async function subagentTagBoxes(scope: import('@playwright/test').Locator, baseTopLeft: { x: number; y: number }): Promise<{ base: Box; ours: Box }> {
  const designated = scope.locator('.att-h .tag.sub'), used = scope.locator('.att-h span', { hasText: /^실제 / });
  // 태그가 없으면 기다리지 않고 바로 실패한다(boundingBox는 요소가 생길 때까지 시험 시간 끝까지 기다린다).
  if (!(await designated.count()) || !(await used.count())) throw new Error('지정·실제 하위 Agent 태그가 없다');
  const a = await designated.first().boundingBox();
  const b = await used.first().boundingBox();
  if (!a || !b) throw new Error('지정·실제 하위 Agent 태그 위치를 잴 수 없다');
  const pad = 2;
  const width = Math.round(b.x + b.width - a.x) + pad * 2, height = Math.round(Math.max(a.height, b.height)) + pad * 2;
  return {
    ours: { x: Math.round(a.x) - pad, y: Math.round(a.y) - pad, width, height },
    base: { x: baseTopLeft.x - pad, y: baseTopLeft.y - pad, width, height },
  };
}
