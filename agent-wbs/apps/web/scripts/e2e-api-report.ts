/**
 * M6-01 보고서 화면을 실제 API·전용 DB(demo seed)로 확인한다.
 *
 *   pnpm --filter @awbs/web e2e:api:report
 *
 * 하는 일(끝나면 모두 지운다): 이 시험 전용 PostgreSQL 컨테이너(report-e2e-pg-…)를 빈 포트에 띄우고,
 * migration → demo seed → 프로젝트 시작일을 원본 값(2026-10-27)으로 → auth CLI 비밀번호 → API(LAN 모드, 127.0.0.2) → Playwright `api-report`.
 * 방식은 scripts/e2e-api-m3int.ts와 같다.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const IMAGE = 'postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d';
const name = `report-e2e-pg-${randomBytes(3).toString('hex')}`;
const dbPassword = randomBytes(18).toString('base64url');
const leadPassword = `e2e-${randomBytes(9).toString('base64url')}`;

const freePort = () => new Promise<number>((done, fail) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => { if (address && typeof address === 'object') done(address.port); else fail(new Error('포트 없음')); });
  });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let api: ChildProcess | undefined;
let exitCode = 1;
try {
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_USER=awbs_owner', '-e', `POSTGRES_PASSWORD=${dbPassword}`,
    '-e', 'POSTGRES_DB=awbs_test_report', '-p', '127.0.0.1::5432', IMAGE], { stdio: ['ignore', 'ignore', 'inherit'] });
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'awbs_owner', '-d', 'awbs_test_report']).status === 0) break;
    await sleep(500);
  }
  const apiPort = await freePort();
  const webPort = await freePort();
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_report`,
    TEST_DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_report`,
    AWBS_HOST: '127.0.0.2', AWBS_PORT: String(apiPort), AWBS_ALLOW_LAN: 'true',
    AWBS_ORIGIN: `http://127.0.0.1:${String(webPort)}`, LOG_LEVEL: 'warn',
  };
  const node = (args: string[], input?: string) => execFileSync('node', ['--conditions=awbs-source', ...args], { cwd: ROOT, env, input, encoding: 'utf8' });
  node(['packages/db/src/migrate-cli.ts']);
  const psql = (sql: string) => execFileSync('docker', ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'awbs_owner', '-d', 'awbs_test_report'], { input: sql, stdio: ['pipe', 'ignore', 'inherit'] });
  // 보고서는 기간 끝 시점의 상태를 이력에서 커밋 순서로 되살린다(owner 2026-11-27 아이템 13).
  // 원본 자료를 「프로젝트 시작(10-27) 전부터 이 상태였다」로 넣으려고, seed 동안만 커밋 시계를 과거로 옮긴다(관리자 전용 시험 설정).
  const shift = Math.floor((Date.parse('2026-10-20T00:00:00+09:00') - Date.now()) / 1000);
  psql(`alter database awbs_test_report set awbs.test_clock_offset='${String(shift)} seconds';`);
  node(['packages/db/src/seed-cli.ts', 'demo']);
  // 정기 보고서가 원본 기간(10-27~)부터 생기도록 시작일을 원본 값으로 맞춘다(P MOCK project.start). 보고서는 API worker가 아니라 시험이 만든다.
  execFileSync('docker', ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'awbs_owner', '-d', 'awbs_test_report'], {
    input: "update projects set start_date='2026-10-27', target_date='2026-11-12'; alter database awbs_test_report reset awbs.test_clock_offset;",
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  node(['apps/api/src/platform/auth-cli.ts', 'set-password'], `${leadPassword}\n`);
  api = spawn('node', ['--conditions=awbs-source', 'apps/api/src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.2:${String(apiPort)}/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const result = spawnSync('node', ['scripts/playwright.ts', 'api-report', ...process.argv.slice(2).filter((a) => a !== '--')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AWBS_E2E_PORT: String(webPort),
      AWBS_E2E_API: `http://127.0.0.2:${String(apiPort)}`,
      AWBS_E2E_PASSWORD: leadPassword,
    },
  });
  exitCode = result.status ?? 1;
} finally {
  api?.kill('SIGTERM');
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  process.exitCode = exitCode;
}
