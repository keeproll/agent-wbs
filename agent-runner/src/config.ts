import { homedir } from 'node:os';
import { agentIsolationConfig } from './cli/dedicated-user.ts';
import { isAbsolute, join } from 'node:path';
import { parseRepoUrl, type GithubMode, type RepoRef } from './github/client.ts';
import { Secret } from './security/secret.ts';
import { PaidCalls } from './exec/paid-calls.ts';

export interface GithubSettings {
  repo: RepoRef;
  mode: GithubMode;
  baseUrl?: string;
  /** 공개 설정만 받는다. 개인키는 전용 ssh-agent의 메모리에 둔다. */
  systemKey?: { id: number; socket: string; knownHosts: string };
}

export interface Config {
  wbsUrl: string;
  token: Secret;
  home: string;
  logLevel: string;
  /** GitHub 연결(선택). 저장소 주소가 없으면 GitHub 확인·보고를 하지 않는다. */
  github: GithubSettings | null;
  /** false면 CLI 최신 확인·유휴 적용(M4-05)을 끈다. 기본 true. */
  cliUpdates: boolean;
  /**
   * Agent 전용 OS 계정 격리(Q-08)를 쓰면 Agent 작업 영역(고정 `/srv/agentwbs`), 아니면 null.
   * 이때 CLI 설치(`cli/`)·작업 폴더(`worktrees/`)·입력 사본(`inputs/`)은 Runner 홈이 아니라 이 영역에 둔다(isolation.md §12).
   */
  agentRoot: string | null;
  /**
   * 실제 CI 실행기(integrate·ci_retry)를 켤지. `AWBS_CI_AUTO=1`일 때만 true(조정자 결정 7, 기본 꺼짐).
   * 왜: CI는 Agent 코드를 실행하는 경로라, 켜는 것은 owner가 명시적으로 정한다.
   */
  ciAuto: boolean;
  /**
   * 시도 흐름(AttemptFlow: dev·qa·rework·reverify 실행)을 켤지. `AWBS_ATTEMPT_AUTO=1`일 때만 true(기본 꺼짐, CI 자동과 같은 방식).
   * 왜: 실제 Claude·Codex 호출(유료)이 시작되는 경로다. M8 실호출 전까지는 owner가 명시적으로 켤 때만 돈다.
   */
  attemptAuto: boolean;
  planningAuto: boolean;
  agentCallLimit: number;
  agentMaxEffort: string;
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
  const keyId = env.AWBS_SYSTEM_DEPLOY_KEY_ID;
  const socket = env.AWBS_SYSTEM_SSH_AUTH_SOCK;
  const knownHosts = env.AWBS_SYSTEM_SSH_KNOWN_HOSTS;
  if (keyId || socket || knownHosts) {
    if (!github) problems.push('시스템 키 설정에는 AWBS_GITHUB_REPO가 필요합니다.');
    if (!keyId || !/^[1-9]\d*$/.test(keyId) || !Number.isSafeInteger(Number(keyId)) || !socket || !knownHosts) {
      problems.push('시스템 키 번호·소켓·서버 키 목록을 모두 설정하세요.');
    } else if (!isAbsolute(socket) || !isAbsolute(knownHosts)) {
      problems.push('시스템 SSH 소켓과 서버 키 목록은 절대 경로여야 합니다.');
    } else if (github) github.systemKey = { id: Number(keyId), socket, knownHosts };
  }
  const cliUpdates = env.AWBS_CLI_UPDATE !== '0';
  const ciAuto = env.AWBS_CI_AUTO === '1';
  if (env.AWBS_CI_AUTO !== undefined && !['0', '1', ''].includes(env.AWBS_CI_AUTO)) problems.push('AWBS_CI_AUTO는 1(켜기) 또는 0(끄기)만 쓸 수 있습니다.');
  const attemptAuto = env.AWBS_ATTEMPT_AUTO === '1';
  if (env.AWBS_ATTEMPT_AUTO !== undefined && !['0', '1', ''].includes(env.AWBS_ATTEMPT_AUTO)) problems.push('AWBS_ATTEMPT_AUTO는 1(켜기) 또는 0(끄기)만 쓸 수 있습니다.');
  if (attemptAuto && !github) problems.push('AWBS_ATTEMPT_AUTO=1에는 GitHub 저장소 설정(AWBS_GITHUB_REPO)이 필요합니다. 작업 폴더를 만들 로컬 clone을 그 저장소로 찾습니다.');
  const planningAuto = env.AWBS_PLANNING_AUTO === '1';
  if (env.AWBS_PLANNING_AUTO !== undefined && !['0', '1', ''].includes(env.AWBS_PLANNING_AUTO)) problems.push('AWBS_PLANNING_AUTO는 1(켜기) 또는 0(끄기)만 쓸 수 있습니다.');
  if (planningAuto && (!github || !env.AWBS_PLANNING_CODEX_MODEL || !env.AWBS_PLANNING_CLAUDE_MODEL)) problems.push('Planning 자동 실행에는 GitHub 저장소와 AWBS_PLANNING_CODEX_MODEL·AWBS_PLANNING_CLAUDE_MODEL을 설정하세요.');
  if (env.AWBS_CALL_LIMIT !== undefined && env.AWBS_AGENT_CALL_LIMIT !== undefined && env.AWBS_CALL_LIMIT !== env.AWBS_AGENT_CALL_LIMIT) problems.push('AWBS_CALL_LIMIT와 이전 이름 AWBS_AGENT_CALL_LIMIT의 값이 다릅니다.');
  const callLimit = env.AWBS_CALL_LIMIT ?? env.AWBS_AGENT_CALL_LIMIT ?? '0';
  const agentCallLimit = Number(callLimit);
  const agentMaxEffort = env.AWBS_AGENT_MAX_EFFORT ?? 'high';
  try { new PaidCalls(home, /^\d+$/.test(callLimit) ? agentCallLimit : NaN, agentMaxEffort); }
  catch (error) { problems.push((error as Error).message); }
  let agentRoot: string | null = null;
  try {
    agentRoot = agentIsolationConfig(env)?.root ?? null;
  } catch (error) {
    problems.push((error as Error).message);
  }

  if (!url || problems.length > 0) throw new ConfigError(problems.join('\n'));
  return { wbsUrl: url.href.replace(/\/+$/, ''), token: new Secret(token), home, logLevel, github, cliUpdates, agentRoot, ciAuto, attemptAuto, planningAuto, agentCallLimit, agentMaxEffort };
}
