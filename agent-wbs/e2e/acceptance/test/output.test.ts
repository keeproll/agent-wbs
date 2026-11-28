import { existsSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { acceptanceOutput } from '../output.ts';

const created: string[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  // 기본값이 기존 보관 경로로 회귀해도 그 안의 증거를 지우지 않는다.
  for (const dir of new Set(created.splice(0))) if (existsSync(dir)) rmdirSync(dir);
});

test('기본 출력은 저장소 밖의 새 폴더다. 다음 실행도 이전 증거와 섞이지 않는다', () => {
  const first = acceptanceOutput(); created.push(first);
  const second = acceptanceOutput(); created.push(second);
  expect(first).not.toBe(second);
  for (const dir of created) {
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(resolve(import.meta.dirname, '../../../..'))).toBe(false);
  }
});

test('보관 경로는 명시했을 때만 사용하고 하위 폴더도 만든다', () => {
  const root = mkdtempSync(join(tmpdir(), 'awbs-output-test-')); roots.push(root);
  const explicit = join(root, 'archive', 'chosen-run');
  expect(acceptanceOutput(explicit)).toBe(explicit);
  expect(existsSync(explicit)).toBe(true);
});
