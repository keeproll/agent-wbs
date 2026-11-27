import { lutimes, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { pruneEvidence, RETENTION_DAYS } from '../../src/ci/night/retention.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-27T00:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let root: string; let runs: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ci-retention-')); runs = join(root, 'runs'); await mkdir(runs); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function run(n: number, finishedAt: number | null, mtime = finishedAt ?? NOW) {
  const dir = join(runs, id(n)); await mkdir(dir);
  await writeFile(join(dir, 'e2e-1.log'), 'log');
  if (finishedAt !== null) await writeFile(join(dir, 'run.json'), JSON.stringify({ runId: id(n), finishedAt: new Date(finishedAt).toISOString() }));
  await utimes(dir, mtime / 1000, mtime / 1000);
}

test('기본 30일이 지난 근거 폴더만 지운다', async () => {
  expect(RETENTION_DAYS).toBe(30);
  await run(1, NOW - 31 * DAY); await run(2, NOW - 29 * DAY);
  expect(await pruneEvidence(runs, NOW)).toEqual([id(1)]);
  expect(await readdir(runs)).toEqual([id(2)]);
});

test('경계 근처는 시계 오차 여유(5초) 안이면 남긴다', async () => {
  await run(1, NOW - 30 * DAY - 4_000); await run(2, NOW - 30 * DAY - 6_000);
  expect(await pruneEvidence(runs, NOW)).toEqual([id(2)]);
});

test('끝 기록이 없으면 폴더 수정 시각으로 판단하고, 진행 중 실행은 남긴다', async () => {
  await run(1, null, NOW - 40 * DAY); await run(2, null, NOW - DAY); await run(3, NOW - 40 * DAY);
  expect(await pruneEvidence(runs, NOW, { keep: new Set([id(3)]) })).toEqual([id(1)]);
  expect((await readdir(runs)).sort()).toEqual([id(2), id(3)]);
});

test('실행 ID 형식이 아니거나 symlink면 건드리지 않는다', async () => {
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'x');
  await symlink(outside, join(runs, id(9)));
  await lutimes(join(runs, id(9)), (NOW - 99 * DAY) / 1000, (NOW - 99 * DAY) / 1000);
  await mkdir(join(runs, 'notes')); await utimes(join(runs, 'notes'), (NOW - 99 * DAY) / 1000, (NOW - 99 * DAY) / 1000);
  expect(await pruneEvidence(runs, NOW)).toEqual([]);
  expect(await readdir(outside)).toEqual(['keep']);
  expect((await readdir(runs)).sort()).toEqual([id(9), 'notes'].sort());
});

test('끝 기록이 손상되면 지우지 않는다', async () => {
  await run(1, null, NOW - 40 * DAY); await writeFile(join(runs, id(1), 'run.json'), '{');
  expect(await pruneEvidence(runs, NOW)).toEqual([]);
  await writeFile(join(runs, id(1), 'run.json'), JSON.stringify({ finishedAt: 'not a date' }));
  expect(await pruneEvidence(runs, NOW)).toEqual([]);
});

test('폴더가 없으면 아무것도 하지 않는다', async () => {
  expect(await pruneEvidence(join(root, 'none'), NOW)).toEqual([]);
});
