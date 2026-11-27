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

test('전용 계정 격리: AWBS_AGENT_USER=awbs-agent면 agentRoot는 고정 /srv/agentwbs, 없으면 null, 다른 값은 설정 오류', () => {
  expect(loadConfig({ AWBS_RUNNER_TOKEN }).agentRoot).toBeNull();
  expect(loadConfig({ AWBS_RUNNER_TOKEN, AWBS_AGENT_USER: 'awbs-agent' }).agentRoot).toBe('/srv/agentwbs');
  expect(() => loadConfig({ AWBS_RUNNER_TOKEN, AWBS_AGENT_USER: 'root' })).toThrow('AWBS_AGENT_USER');
});

test('조정자 결정 7: CI 실행기(AWBS_CI_AUTO)는 기본 꺼짐, 1일 때만 켜짐, 다른 값은 설정 오류', () => {
  const base = { AWBS_WBS_URL: 'http://127.0.0.1:3100', AWBS_RUNNER_TOKEN: 'awbs_rt_' + 'a'.repeat(40) };
  expect(loadConfig(base).ciAuto).toBe(false);
  expect(loadConfig({ ...base, AWBS_CI_AUTO: '0' }).ciAuto).toBe(false);
  expect(loadConfig({ ...base, AWBS_CI_AUTO: '1' }).ciAuto).toBe(true);
  expect(() => loadConfig({ ...base, AWBS_CI_AUTO: 'yes' })).toThrow('AWBS_CI_AUTO');
});

test('시도 흐름(AWBS_ATTEMPT_AUTO)은 기본 꺼짐, 1일 때만 켜짐(GitHub 저장소 설정 필요), 다른 값은 설정 오류', () => {
  const base = { AWBS_WBS_URL: 'http://127.0.0.1:3100', AWBS_RUNNER_TOKEN: 'awbs_rt_' + 'a'.repeat(40) };
  const github = { ...base, AWBS_GITHUB_REPO: 'https://github.com/o/r' };
  expect(loadConfig(github).attemptAuto).toBe(false);
  expect(loadConfig({ ...github, AWBS_ATTEMPT_AUTO: '0' }).attemptAuto).toBe(false);
  expect(loadConfig({ ...github, AWBS_ATTEMPT_AUTO: '1' }).attemptAuto).toBe(true);
  expect(() => loadConfig({ ...github, AWBS_ATTEMPT_AUTO: 'on' })).toThrow('AWBS_ATTEMPT_AUTO');
  expect(() => loadConfig({ ...base, AWBS_ATTEMPT_AUTO: '1' })).toThrow('AWBS_GITHUB_REPO');
});
