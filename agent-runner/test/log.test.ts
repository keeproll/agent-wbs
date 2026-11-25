import { expect, test } from 'vitest';
import { createLogger } from '../src/log.ts';
import { createRedactor } from '../src/security/redact.ts';

const TOKEN = 'runner-token-value-0123456789';

function capture() {
  const lines: string[] = [];
  const log = createLogger('info', createRedactor([TOKEN]), { write: (line) => lines.push(line) });
  return { log, lines };
}

test('메시지·필드·오류·child 어디에 있어도 가린다', () => {
  const { log, lines } = capture();
  log.info(`메시지 ${TOKEN}`);
  log.info({ a: { b: { c: { authorization: 'zzz-secret' } } } }, '깊은 필드');
  log.error({ err: new Error(`실패 ${TOKEN}`, { cause: new Error(`원인 ${TOKEN}`) }) }, '오류');
  log.child({ password: 'zzz-secret' }).info('child');
  log.info('형식 %s %o', TOKEN, { botToken: 'zzz-secret' });
  expect(lines).toHaveLength(5);
  expect(lines.join('')).not.toMatch(/runner-token-value|zzz-secret/);
  for (const line of lines) expect(JSON.parse(line)).toMatchObject({ name: 'agent-runner' });
});

test('순환 객체도 기록한다', () => {
  const { log, lines } = capture();
  const loop: Record<string, unknown> = { password: 'zzz-secret' };
  loop.self = loop;
  log.info({ loop });
  expect(lines.join('')).not.toContain('zzz-secret');
});
