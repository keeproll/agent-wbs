import { inspect } from 'node:util';
import { expect, test } from 'vitest';
import { createRedactor } from '../src/security/redact.ts';
import { Secret } from '../src/security/secret.ts';

const redact = createRedactor(['runner-token-value-0123456789']);
const TG = '123456789:AAfakefakefakefakefakefakefakefake_-';

test.each([
  ['Bearer', 'Authorization: Bearer abc.def-123', 'abc.def-123'],
  ['Telegram URL', `https://api.telegram.org/bot${TG}/sendMessage`, 'AAfake'],
  ['Telegram 토큰', `token ${TG}`, 'AAfake'],
  ['GitHub 토큰', `push ghp_${'a'.repeat(36)}`, 'aaaa'],
  ['GitHub fine-grained', `github_pat_${'b'.repeat(40)}`, 'bbbb'],
  ['URL 계정', 'clone https://user:hunter2@github.com/a/b.git', 'hunter2'],
  ['질의 문자열', 'GET /x?token=qwerty&a=1', 'qwerty'],
  ['개인키', '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----', 'MIIabc'],
  ['문자열 속 JSON', '응답 {"botToken": "a\\"hunter2","ok":false}', 'hunter2'],
  ['헤더 줄', 'HTTP/1.1 200\nSet-Cookie: sid=hunter2; Path=/', 'hunter2'],
  ['환경 변수', 'env GITHUB_TOKEN=hunter2 git push', 'hunter2'],
  ['알려진 값', 'x=runner-token-value-0123456789;', 'runner-token-value'],
])('%s 문자열을 가린다', (_label, input, leaked) => {
  expect(redact(input)).toContain('[REDACTED]');
  expect(redact(input)).not.toContain(leaked);
});

test('깊은 객체·배열의 비밀 키를 가린다', () => {
  expect(
    redact({
      headers: { Authorization: 'x', cookie: 'a=b', 'Set-Cookie': ['s=1'] },
      list: [{ botToken: 't', password: { nested: 1 }, GITHUB_TOKEN: 'g' }],
    }),
  ).toEqual({
    headers: { Authorization: '[REDACTED]', cookie: '[REDACTED]', 'Set-Cookie': '[REDACTED]' },
    list: [{ botToken: '[REDACTED]', password: '[REDACTED]', GITHUB_TOKEN: '[REDACTED]' }],
  });
});

test('비밀이 아닌 값은 그대로 둔다', () => {
  const value = {
    tokensUsed: 10,
    tokenSet: true,
    last4: 'abcd',
    at: '2026-11-25T12:34:56.123456Z',
    url: 'http://127.0.0.1:3100/api/runner',
    path: '/robot/arm',
    nothing: null,
  };
  expect(redact(value)).toEqual(value);
});

test('Secret은 reveal 외의 방법으로 값이 나오지 않는다', () => {
  const secret = new Secret('hunter2');
  expect(secret.reveal()).toBe('hunter2');
  expect([String(secret), JSON.stringify({ secret }), inspect({ secret })].join()).not.toContain('hunter2');
});
