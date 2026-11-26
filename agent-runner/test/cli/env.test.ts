import { describe, expect, test } from 'vitest';
import { sessionEnv } from '../../src/cli/env.ts';

const HOST: NodeJS.ProcessEnv = {
  PATH: '/usr/bin', HOME: '/home/u', USER: 'u', LANG: 'ko_KR.UTF-8', TMPDIR: '/tmp/x',
  CODEX_HOME: '/home/u/.codex', CLAUDE_CONFIG_DIR: '/home/u/.claude',
  AWBS_RUNNER_TOKEN: 'runner-secret', AWBS_HOME: '/home/u/.agentwbs', GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y',
  SSH_AUTH_SOCK: '/tmp/ssh.sock', SSH_AGENT_PID: '1', ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oa',
  AWS_SECRET_ACCESS_KEY: 'aws', NODE_OPTIONS: '--require /evil.js', LD_PRELOAD: '/evil.so',
};

describe('sessionEnv — Agent 세션 환경 변수 allowlist(architecture §4, G §9.5-4-1)', () => {
  test('Codex: 허용 목록만 넘기고 Claude 설정 폴더는 넘기지 않는다', () => {
    const env = sessionEnv('Codex', HOST);
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'USER']);
  });

  test('Claude: 자기 설정 폴더만 넘기고 Codex 폴더는 넘기지 않는다', () => {
    const env = sessionEnv('Claude', HOST);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
    expect(env.CODEX_HOME).toBeUndefined();
  });

  test.each(['Codex', 'Claude'] as const)('%s: 토큰·SSH agent·AWBS_*·API 키·주입 변수는 하나도 남지 않는다', (agent) => {
    const env = sessionEnv(agent, HOST);
    for (const name of ['AWBS_RUNNER_TOKEN', 'AWBS_HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'LD_PRELOAD']) {
      expect(env[name], name).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toMatch(/secret|ghp_|sk-|evil/);
  });

  test('CLI 자체 자동 업데이트는 항상 끈다(Runner만 버전을 바꾼다, §5.1)', () => {
    expect(sessionEnv('Claude', {})).toMatchObject({ DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' });
  });
});
