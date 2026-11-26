import { createConnection } from 'node:net';
import { createPool } from '@awbs/db';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loggerOptions } from '../src/log.ts';

let output = '';
const pool = createPool('postgres://u:p@127.0.0.1:1/awbs_test_x', { onError: () => undefined });
const app = buildApp(pool, {
  ...loggerOptions('trace'),
  stream: { write: (line: string) => void (output += line) },
});
app.addHook('preHandler', async (request) => {
  if (request.url.includes('boom=1')) throw Object.assign(new Error('고장'), { client: { secretKey: 'hunter2' } });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  output = '';
});

describe('요청 URL의 비밀값을 로그에 남기지 않는다', () => {
  test.each([
    ['정상 경로', '/health?password=hunter2&token=hunter2', 200],
    ['DB 실패', '/health/db?token=hunter2', 503],
    ['없는 경로의 query', '/nope?token=hunter2', 404],
    ['없는 경로의 path', '/bot123456:hunter2/sendMessage', 404],
    ['잘못된 URL', '/%zz?token=hunter2', 400],
    ['처리되지 않은 오류와 부가 객체', '/health?boom=1&token=hunter2', 500],
  ])('%s', async (_label, url, status) => {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(status);
    // Fastify는 URL을 해석하지 못한 요청을 기록하지 않는다.
    if (status !== 400) expect(output).toContain('"reqId"');
    expect(output).not.toContain('hunter2');
    expect(response.body).not.toContain('hunter2');
  });

  test('해석할 수 없는 HTTP 요청', async () => {
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    let wire = '';
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(Number(address.port), '127.0.0.1', () =>
        socket.write('GET /x?token=hunter2 HTTP/1.1\r\nAuthorization: Bearer hunter2\r\nbad header\r\n\r\n'),
      );
      socket.on('data', (chunk) => { wire += String(chunk); }).on('error', reject).on('close', () => {
        resolve();
      });
    });
    expect(output).toContain('client error');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain(JSON.stringify([...Buffer.from('hunter2')]).slice(1, -1));
    expect(wire).toContain('"code":"VALIDATION_FAILED"');
    expect(wire).not.toContain('hunter2');
  });
});

test('구조화 로그·메시지·오류의 비밀값을 가린다', () => {
  app.log.info({ authorization: 'Bearer hunter2', cookie: 'hunter2', password: 'hunter2', botToken: 'hunter2',
    nested: { password: 'hunter2', tokenSet: true } }, 'Bearer hunter2 /bot123:hunter2/send');
  app.log.error({ err: new Error('bare-secret-hunter2') }, '오류 확인');
  app.log.info('Bearer hunter2');
  expect(output).not.toContain('hunter2');
  expect(output).toContain('"tokenSet":true');
  expect(output).toContain('[REDACTED]');
});

test('찾을 수 있도록 method·route·상태는 남긴다', async () => {
  await app.inject('/health');
  expect(output).toContain('"method":"GET"');
  expect(output).toContain('"route":"/health"');
  expect(output).toContain('"statusCode":200');
});
