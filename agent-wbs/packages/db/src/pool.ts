import pg from 'pg';

export type Pool = pg.Pool;

/** 잘못된 URL 오류에는 비밀번호가 포함되므로 원본 값을 노출하지 않는다. */
export function parseDatabaseUrl(value: string | undefined, name = 'DATABASE_URL'): string {
  if (!value) throw new Error(`${name}이 없습니다. \`pnpm env:init\`으로 .env를 만드세요.`);
  const url = URL.parse(value);
  if (!url || !/^postgres(ql)?:$/.test(url.protocol) || url.pathname.length < 2) {
    throw new Error(`${name} 형식이 잘못되었습니다. postgres://user:password@host:port/db 형식이어야 합니다.`);
  }
  return value;
}

export function createPool(
  connectionString: string,
  options: { max?: number; onError: (error: Error) => void },
): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
  });
  // 유휴 연결이 끊기면 'error'가 발생한다. 처리하지 않으면 프로세스가 죽는다.
  pool.on('error', options.onError);
  return pool;
}

/** DB가 멈춰도 health가 매달리지 않도록 질의 시간을 제한한다. */
export async function pingDatabase(pool: Pool, timeoutMs = 2_000): Promise<number> {
  const started = performance.now();
  const query: pg.QueryConfig & { query_timeout: number } = {
    text: 'select 1',
    query_timeout: timeoutMs,
  };
  await pool.query(query);
  return Math.round(performance.now() - started);
}

// 잠시 뒤 성공할 수 있는 연결 오류. 인증 실패·없는 DB는 재시도하지 않는다.
const TRANSIENT = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P03']);

export async function waitForDatabase(
  pool: Pool,
  options: {
    retries?: number;
    delayMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
  } = {},
): Promise<void> {
  const { retries = 3, delayMs = 1_000, onRetry } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      await pingDatabase(pool);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      // pg-pool의 연결 시간 초과에는 code가 없다.
      const timedOut = error instanceof Error && /timeout/i.test(error.message);
      if (attempt > retries || !(TRANSIENT.has(code) || timedOut)) throw error;
      onRetry?.(attempt, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
