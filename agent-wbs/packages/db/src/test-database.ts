import pg from 'pg';
import { parseDatabaseUrl } from './pool.ts';

const TEST_DB_NAME = /^awbs_test_[a-z0-9_]{1,53}$/;

/** 파괴적 작업이 개발·운영 DB에 닿지 않도록 하는 안전장치. 통과한 DB 이름을 돌려준다. */
export function assertTestDatabaseUrl(value: string | undefined): string {
  const url = new URL(parseDatabaseUrl(value, 'TEST_DATABASE_URL'));
  // `?host=` 같은 질의는 URL 본문의 접속 대상을 덮어쓸 수 있다.
  if (url.search || url.hash) {
    throw new Error('TEST_DATABASE_URL에는 질의 문자열을 쓸 수 없습니다.');
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`테스트 거부: 로컬이 아닌 호스트입니다 (${url.hostname}).`);
  }
  const name = url.pathname.slice(1);
  if (!TEST_DB_NAME.test(name)) {
    throw new Error(`테스트 거부: DB 이름이 awbs_test_로 시작하지 않습니다 (${name}).`);
  }
  return name;
}

/** 실제로 연결된 DB를 다시 확인한다. */
export async function assertConnectedToTestDatabase(client: pg.ClientBase | pg.Pool): Promise<void> {
  const result = await client.query<{ name: string }>('select current_database() as name');
  const name = result.rows[0]?.name ?? '';
  if (!TEST_DB_NAME.test(name)) {
    throw new Error(`테스트 거부: 연결된 DB가 awbs_test_ DB가 아닙니다 (${name}).`);
  }
}

/** 테스트 DB를 지우고 빈 DB로 다시 만든다. 허용된 이름이 아니면 접속하지 않는다. */
export async function recreateTestDatabase(value: string | undefined): Promise<string> {
  const name = assertTestDatabaseUrl(value);
  const admin = new URL(value as string);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.href, connectionTimeoutMillis: 3_000 });
  await client.connect();
  try {
    await client.query(`drop database if exists ${client.escapeIdentifier(name)} with (force)`);
    await client.query(`create database ${client.escapeIdentifier(name)} template template0 encoding 'UTF8' lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'`);
  } finally {
    await client.end();
  }
  return value as string;
}
