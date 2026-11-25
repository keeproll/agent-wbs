// contracts/openapi.json 생성(기본) 또는 drift 검사(--check)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { OPERATIONS, renderOpenApi } from '../packages/shared/src/api/index.ts';

const target = new URL('../contracts/openapi.json', import.meta.url);
const next = renderOpenApi(OPERATIONS);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // 파일이 없으면 drift로 본다.
  }
  if (current !== next) {
    console.error('contracts/openapi.json이 스키마와 다릅니다. `pnpm openapi:generate`를 실행해 커밋하세요.');
    process.exitCode = 1;
  }
} else {
  mkdirSync(new URL('.', target), { recursive: true });
  writeFileSync(target, next);
}
