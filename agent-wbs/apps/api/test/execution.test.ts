import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { checkEvidence, multipartBody } from '../src/execution/evidence.ts';

test('execution: Task 조회를 먼저 가져와도 모듈 초기화가 순환하지 않는다', () => {
  const module = new URL('../src/tasks/read.ts',import.meta.url).href;
  const imported = spawnSync(process.execPath,['--conditions=awbs-source','--input-type=module','--eval',`await import(${JSON.stringify(module)})`],{ encoding:'utf8' });
  expect(imported.status,imported.stderr).toBe(0);
});

test('execution: 실제 multipart 파일은 바이트·해시·크기를 보존하며 클라이언트 파일명을 쓰지 않는다', async () => {
  const file = Buffer.from('한글\u0000증거');
  const form = new FormData();
  form.set('file',new Blob([file]),'../../outside.html'); form.set('kind','로그');
  form.set('size',String(file.length)); form.set('fence','1');
  const request = new Request('http://localhost',{ method:'POST',body:form });
  const body = await multipartBody(request.headers.get('content-type') ?? '',Buffer.from(await request.arrayBuffer()));
  expect(body).toEqual({ file,kind:'로그',size:13,fence:1 });
  const hash = createHash('sha256').update(file).digest('hex');
  expect(() => checkEvidence(body.file,hash,13)).not.toThrow();
  expect(() => checkEvidence(body.file,'0'.repeat(64),13)).toThrow();
  expect(() => checkEvidence(body.file,hash,1)).toThrow();
  expect(() => checkEvidence('file',hash,13)).toThrow();
});

test.each(['중복','소수','음수','비정상 파일'])('execution: %s multipart 메타데이터는 입력 오류다', async kind => {
  const form = new FormData();
  form.set('file',kind === '비정상 파일' ? '파일 아님' : new Blob(['a']));
  form.set('size',kind === '소수' ? '1.5' : kind === '음수' ? '-1' : '1'); form.set('fence','1');
  if (kind === '중복') form.append('size','1');
  const request = new Request('http://localhost',{ method:'POST',body:form });
  await expect(multipartBody(request.headers.get('content-type') ?? '',Buffer.from(await request.arrayBuffer()))).rejects.toMatchObject({ code:'VALIDATION_FAILED' });
});
