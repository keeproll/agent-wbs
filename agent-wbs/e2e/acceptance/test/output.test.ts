import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { acceptanceOutput } from '../output.ts';

const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
  const root = mkdtempSync(join(tmpdir(), 'awbs-output-test-')); created.push(root);
  const explicit = join(root, 'archive', 'chosen-run');
  expect(acceptanceOutput(explicit)).toBe(explicit);
  expect(existsSync(explicit)).toBe(true);
});
