import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';

const AWBS_RUNNER_TOKEN = 'x'.repeat(43);

test('기본값', () => {
  const config = loadConfig({ AWBS_RUNNER_TOKEN, AWBS_URL: '', AWBS_HOME: '' });
  expect(config).toMatchObject({
    wbsUrl: 'http://127.0.0.1:3100',
    home: join(homedir(), '.agentwbs'),
    logLevel: 'info',
  });
  expect(config.token.reveal()).toBe(AWBS_RUNNER_TOKEN);
  expect(JSON.stringify(config)).not.toContain(AWBS_RUNNER_TOKEN);
});

test.each([
  ['토큰 없음', {}],
  ['짧은 토큰', { AWBS_RUNNER_TOKEN: 'hunter2' }],
  ['공백이 든 토큰', { AWBS_RUNNER_TOKEN: `${'x'.repeat(40)} hunter2` }],
  ['URL 계정', { AWBS_RUNNER_TOKEN, AWBS_URL: 'http://u:hunter2@127.0.0.1' }],
  ['URL 질의', { AWBS_RUNNER_TOKEN, AWBS_URL: 'http://127.0.0.1/?a=hunter2' }],
  ['http가 아님', { AWBS_RUNNER_TOKEN, AWBS_URL: 'file:///hunter2' }],
  ['URL 아님', { AWBS_RUNNER_TOKEN, AWBS_URL: 'hunter2' }],
  ['상대 경로', { AWBS_RUNNER_TOKEN, AWBS_HOME: 'hunter2' }],
  ['로그 수준', { AWBS_RUNNER_TOKEN, LOG_LEVEL: 'hunter2' }],
])('%s은 거부하고 입력값을 노출하지 않는다', (_label, env) => {
  const error = (() => {
    try {
      loadConfig(env);
      return undefined;
    } catch (caught) {
      return caught as Error;
    }
  })();
  expect(error?.name).toBe('ConfigError');
  expect(error?.message).not.toContain('hunter2');
});
