import { DEFAULT_PIN_TIME_ZONE } from './platform/date-pin.ts';
import { parseDatabaseUrl } from '@awbs/db';

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  poolMax: number;
  logLevel: string;
  lan: boolean;
  origin: string;
  pinTimeZone: string;
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
  const lan = host !== '127.0.0.1' && host !== '::1';
  if (lan && env.AWBS_ALLOW_LAN !== 'true') throw new Error('LAN 공개는 AWBS_ALLOW_LAN=true를 명시해야 합니다.');
  const port = integer('AWBS_PORT', env.AWBS_PORT, 3100, 65_535);
  const origin = env.AWBS_ORIGIN ?? (lan ? '' : `http://${host === '::1' ? '[::1]' : host}:${String(port)}`);
  const parsedOrigin = URL.parse(origin);
  if (!parsedOrigin || !['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
    throw new Error('AWBS_ORIGIN은 접속 주소의 Origin이어야 합니다. 예: http://192.168.1.2:3100');
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL은 ${LOG_LEVELS.join(', ')} 중 하나여야 합니다.`);
  const pinTimeZone = env.AWBS_PIN_TIME_ZONE ?? DEFAULT_PIN_TIME_ZONE;
  try { new Intl.DateTimeFormat('en-US', { timeZone: pinTimeZone }); }
  catch { throw new Error('AWBS_PIN_TIME_ZONE은 유효한 시간대여야 합니다. 예: Asia/Seoul'); }
  return {
    pinTimeZone,
    host,
    port,
    databaseUrl: parseDatabaseUrl(env.DATABASE_URL),
    poolMax: integer('DB_POOL_MAX', env.DB_POOL_MAX, 10, 100),
    logLevel,
    lan,
    origin,
  };
}
