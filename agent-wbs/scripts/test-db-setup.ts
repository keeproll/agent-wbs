import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import { createPool, recreateTestDatabase } from '../packages/db/src/index.ts';

/** 대상 DB가 awbs_test_가 아니면 어떤 테스트도 시작하지 않는다. */
export default async function setup(project: TestProject): Promise<void> {
  const envFile = resolve(import.meta.dirname, '../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = await recreateTestDatabase(process.env.TEST_DATABASE_URL);
  // M6-01 보고서 상태 이력은 실제 커밋 시각(track_commit_timestamp)을 쓴다. 꺼진 서버에서는 「T 전 커밋」을 정확히 가를 수 없다.
  // compose.yaml과 같은 설정으로 시험 컨테이너를 띄운다: docker run … -e LANG=C.UTF-8 postgres:16(Debian) -c track_commit_timestamp=on
  const pool = createPool(url, { max: 1, onError: () => undefined });
  try {
    const on = (await pool.query<{ v: string }>("select current_setting('track_commit_timestamp') v")).rows[0]?.v;
    if (on !== 'on') throw new Error('시험 DB 서버의 track_commit_timestamp가 꺼져 있습니다. 컨테이너를 `-c track_commit_timestamp=on`으로 다시 띄우세요(compose.yaml 참고).');
  } finally { await pool.end(); }
  project.provide('testDatabaseUrl', url);
}
