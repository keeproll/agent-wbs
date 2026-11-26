import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseRepoUrl, type GithubMode, type RepoRef } from './github/client.ts';
import { Secret } from './security/secret.ts';

export interface Config {
  wbsUrl: string;
  token: Secret;
  home: string;
  logLevel: string;
  /** GitHub 연결(선택). 저장소 주소가 없으면 GitHub 확인·보고를 하지 않는다. */
  github: { repo: RepoRef; mode: GithubMode; baseUrl?: string } | null;
  /** false면 CLI 최신 확인·유휴 적용(M4-05)을 끈다. 기본 true. */
  cliUpdates: boolean;
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

  let github: Config['github'] = null;
  if (env.AWBS_GITHUB_REPO) {
    const repo = parseRepoUrl(env.AWBS_GITHUB_REPO);
    const mode = env.AWBS_GITHUB_MODE || 'gh';
    if (!repo) problems.push('AWBS_GITHUB_REPO는 https://github.com/<owner>/<repo> 형식이어야 합니다.');
    if (mode !== 'gh' && mode !== 'token') problems.push('AWBS_GITHUB_MODE는 gh 또는 token이어야 합니다.');
    // GitHub API 주소(기본 https://api.github.com). GitHub Enterprise·시험용 fake에만 바꾼다. 계정·질의 문자열은 받지 않는다.
    const api = env.AWBS_GITHUB_API_URL ? URL.parse(env.AWBS_GITHUB_API_URL) : null;
    if (env.AWBS_GITHUB_API_URL && (!api || !/^https?:$/.test(api.protocol) || api.username || api.password || api.search || api.hash)) {
      problems.push('AWBS_GITHUB_API_URL은 계정·질의 문자열이 없는 http(s) 주소여야 합니다.');
    }
    if (repo && (mode === 'gh' || mode === 'token')) github = { repo, mode, ...(api && { baseUrl: api.href.replace(/\/+$/, '') }) };
  }
  const cliUpdates = env.AWBS_CLI_UPDATE !== '0';

  if (!url || problems.length > 0) throw new ConfigError(problems.join('\n'));
  return { wbsUrl: url.href.replace(/\/+$/, ''), token: new Secret(token), home, logLevel, github, cliUpdates };
}
