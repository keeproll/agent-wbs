/**
 * 실제 API·실제 DB로 WBS 화면을 시험하고 200/1,000행 응답 시간을 잰다(M3-02, UAT-WIZ-02·UAT-WBS-05의 「API+E2E」).
 *
 *   pnpm --filter @awbs/web e2e:api-wbs
 *
 * 하는 일(끝나면 모두 지운다):
 * 1. 이 시험 전용 PostgreSQL 컨테이너(m302-e2e-pg-…)를 빈 포트에 띄운다. 개발용 DB는 건드리지 않는다.
 * 2. migration → system seed → demo seed(원본 Mock과 같은 Task 12건, 승인된 프로젝트) → LAN 비밀번호 설정 → API 기동(LAN 모드).
 *    demo seed는 시험용 DB 이름(awbs_test_…)에만 들어간다(packages/db test-database.ts의 안전장치).
 * 3. Playwright `api-wbs` 시험을 실행한다. 측정 결과는 AWBS_PERF_OUT 폴더에 남는다.
 *    1,000행은 API로 만든 Task 한 행을 복사해 이 전용 DB에 직접 넣는다(읽기 응답 측정용). 200행까지는 모두 API로 만든다.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const IMAGE = 'postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d';
const name = `m302-e2e-pg-${randomBytes(3).toString('hex')}`;
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
    '-e', 'POSTGRES_DB=awbs_test_m302', '-p', '127.0.0.1::5432', IMAGE], { stdio: ['ignore', 'ignore', 'inherit'] });
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'awbs_owner', '-d', 'awbs_test_m302']).status === 0) break;
    await sleep(500);
  }
  const apiPort = await freePort();
  const webPort = await freePort();
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_m302`,
    TEST_DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_m302`,
    AWBS_HOST: '127.0.0.2', AWBS_PORT: String(apiPort), AWBS_ALLOW_LAN: 'true',
    AWBS_ORIGIN: `http://127.0.0.1:${String(webPort)}`, LOG_LEVEL: 'warn',
  };
  const node = (args: string[], input?: string) => execFileSync('node', ['--conditions=awbs-source', ...args], { cwd: ROOT, env, input, encoding: 'utf8' });
  node(['packages/db/src/migrate-cli.ts']);
  node(['packages/db/src/seed-cli.ts', 'system']);
  node(['packages/db/src/seed-cli.ts', 'demo']);
  node(['apps/api/src/platform/auth-cli.ts', 'set-password'], `${leadPassword}\n`);
  api = spawn('node', ['--conditions=awbs-source', 'apps/api/src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.2:${String(apiPort)}/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const result = spawnSync('node', ['scripts/playwright.ts', 'api-wbs', ...process.argv.slice(2).filter((a) => a !== '--')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AWBS_E2E_PORT: String(webPort),
      AWBS_E2E_API: `http://127.0.0.2:${String(apiPort)}`,
      AWBS_E2E_PASSWORD: leadPassword,
      // 1,000행 측정 준비: 이 전용 컨테이너에 직접 행을 넣는다(API로 800건을 만들면 20분이 넘는다).
      AWBS_E2E_PG_CONTAINER: name,
    },
  });
  exitCode = result.status ?? 1;
} finally {
  // API가 먼저 끝난 뒤 DB를 지운다(DB가 먼저 사라지면 API 연결 풀이 예외로 죽는다).
  if (api && api.exitCode === null) {
    const exited = new Promise((r) => api?.once('exit', r));
    api.kill('SIGTERM');
    await Promise.race([exited, sleep(5_000)]);
  }
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  process.exitCode = exitCode;
}
