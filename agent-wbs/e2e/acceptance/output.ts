import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 기본 실행끼리 증거가 섞이지 않게 원자적으로 새 폴더를 만든다. 보관 경로는 명시할 때만 쓴다. */
export function acceptanceOutput(explicit?: string): string {
  const out = explicit ?? mkdtempSync(join(tmpdir(), 'awbs-acceptance-'));
  mkdirSync(out, { recursive: true });
  return out;
}
