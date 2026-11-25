// src/api/generated/client.ts 생성(기본) 또는 drift 검사(--check)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateClient, type OpenApiDocument } from './client-codegen.ts';

const source = new URL('../../agent-wbs/contracts/openapi.json', import.meta.url);
const target = new URL('../src/api/generated/client.ts', import.meta.url);
const next = generateClient(JSON.parse(readFileSync(source, 'utf8')) as OpenApiDocument);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // 파일이 없으면 drift로 본다.
  }
  if (current !== next) {
    console.error('src/api/generated/client.ts가 openapi.json과 다릅니다. `pnpm client:generate`를 실행해 커밋하세요.');
    process.exitCode = 1;
  }
} else {
  mkdirSync(new URL('.', target), { recursive: true });
  writeFileSync(target, next);
}
