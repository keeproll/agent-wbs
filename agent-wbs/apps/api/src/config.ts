import { parseDatabaseUrl } from '@awbs/db';

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  poolMax: number;
  logLevel: string;
}

function integer(name: string, value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > max) {
    throw new Error(`${name}은 1~${String(max)} 정수여야 합니다.`);
  }
  return parsed;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const host = env.AWBS_HOST ?? '127.0.0.1';
  // LAN 공개는 비밀번호 로그인이 있어야 한다(architecture §4). 로그인은 M2-01에서 만든다.
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('AWBS_HOST는 127.0.0.1 또는 ::1이어야 합니다. LAN 공개는 비밀번호 로그인 구현 뒤에 지원합니다.');
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL은 ${LOG_LEVELS.join(', ')} 중 하나여야 합니다.`);
  return {
    host,
    port: integer('AWBS_PORT', env.AWBS_PORT, 3100, 65_535),
    databaseUrl: parseDatabaseUrl(env.DATABASE_URL),
    poolMax: integer('DB_POOL_MAX', env.DB_POOL_MAX, 10, 100),
    logLevel,
  };
}
