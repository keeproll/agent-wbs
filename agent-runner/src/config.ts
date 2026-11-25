import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Secret } from './security/secret.ts';

export interface Config {
  wbsUrl: string;
  token: Secret;
  home: string;
  logLevel: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** 오류 메시지에 입력값을 넣지 않는다(비밀값이 섞였을 수 있다). */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  const url = URL.parse(env.AWBS_URL || 'http://127.0.0.1:3100');
  if (
    !url ||
    !/^https?:$/.test(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    problems.push('AWBS_URL은 계정·질의 문자열이 없는 http(s) 주소여야 합니다.');
  }

  const token = env.AWBS_RUNNER_TOKEN?.trim() ?? '';
  if (!/^[\x21-\x7e]{32,}$/.test(token)) {
    problems.push('AWBS_RUNNER_TOKEN에 Agent WBS에서 발급한 Runner 토큰을 설정하세요.');
  }

  const home = env.AWBS_HOME || join(homedir(), '.agentwbs');
  if (!isAbsolute(home)) problems.push('AWBS_HOME은 절대 경로여야 합니다.');

  const logLevel = env.LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL은 ${LOG_LEVELS.join(', ')} 중 하나여야 합니다.`);

  if (!url || problems.length > 0) throw new ConfigError(problems.join('\n'));
  return { wbsUrl: url.href.replace(/\/+$/, ''), token: new Secret(token), home, logLevel };
}
