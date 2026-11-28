import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import type { TestProject } from 'vitest/node';
import { createPool } from '../../packages/db/src/index.ts';

const run = promisify(execFile);

/** 다른 시험·운영 DB를 재시작하지 않도록 이 명령이 만든 컨테이너만 쓴다. */
export default async function setup(project: TestProject) {
  const container = `awbs-m802-${randomUUID()}`;
  const password = randomUUID();
  const cleanup = async () => { await run('docker', ['rm', '-f', '-v', container]); };
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('시험 포트를 찾지 못했습니다.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  try {
    // Docker의 임의 포트(빈 HostPort)는 재시작 때 바뀐다. 시험 도중 주소가 바뀌지 않게 고정한다.
    await run('docker', ['run', '-d', '--name', container, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'LANG=C.UTF-8',
      '-p', `127.0.0.1:${String(port)}:5432`, 'postgres:16', '-c', 'track_commit_timestamp=on']);
    const { stdout } = await run('docker', ['port', container, '5432/tcp']);
    if (stdout.trim() !== `127.0.0.1:${String(port)}` || port === 25432) throw new Error('전용 시험 DB 포트를 확인할 수 없습니다.');
    const url = `postgres://postgres:${password}@127.0.0.1:${String(port)}/awbs_test_m802`;
    const deadline = performance.now() + 30_000;
    for (;;) {
      try { await run('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch (error) { if (performance.now() >= deadline) throw error; await pause(100); }
    }
    const admin = new URL(url); admin.pathname = '/postgres';
    const pool = createPool(admin.href, { onError: () => undefined });
    try {
      const result = await pool.query<{ version: string; enabled: string }>("select version(),current_setting('track_commit_timestamp') enabled");
      if (!/PostgreSQL 16.*Debian/.test(result.rows[0]?.version ?? '') || result.rows[0]?.enabled !== 'on') throw new Error('Debian PostgreSQL 16·track_commit_timestamp=on이 필요합니다.');
    } finally { await pool.end(); }
    project.provide('testDatabaseUrl', url);
    project.provide('resilienceContainer', container);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
