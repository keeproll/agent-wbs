/**
 * M6-01 보고서 화면을 실제 API·전용 DB(demo seed)로 확인한다.
 *
 *   pnpm --filter @awbs/web e2e:api:report
 *
 * 하는 일(끝나면 모두 지운다): 이 시험 전용 PostgreSQL 컨테이너(report-e2e-pg-…)를 빈 포트에 띄우고,
 * migration → demo seed → 프로젝트 시작일을 원본 값(2026-10-27)으로 → API(LAN 모드, 127.0.0.2) → Playwright `api-report`.
 * 방식은 scripts/e2e-api-m3int.ts와 같다.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
// M6 통합: compose.yaml과 같은 Debian postgres:16(정렬 규칙을 맞춘다, M5·M7 통합 결정)과 track_commit_timestamp=on(M6-01 보고서 상태 이력 필수).
const IMAGE = 'postgres:16@sha256:07abc3f43c9395b0bdbbab36bc25ddb0e8d83cd4fcafb5fb7d6abe14ff156dd8';
const name = `report-e2e-pg-${randomBytes(3).toString('hex')}`;
const dbPassword = randomBytes(18).toString('base64url');

const freePort = () => new Promise<number>((done, fail) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => { if (address && typeof address === 'object') done(address.port); else fail(new Error('포트 없음')); });
  });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let api: ChildProcess | undefined;
const home = mkdtempSync(join(tmpdir(), 'awbs-report-e2e-home-'));
let exitCode = 1;
try {
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_USER=awbs_owner', '-e', `POSTGRES_PASSWORD=${dbPassword}`,
    '-e', 'POSTGRES_DB=awbs_test_report', '-e', 'LANG=C.UTF-8', '-p', '127.0.0.1::5432', IMAGE, '-c', 'track_commit_timestamp=on'], { stdio: ['ignore', 'ignore', 'inherit'] });
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
    AWBS_HOST: '127.0.0.2', AWBS_PORT: String(apiPort), AWBS_ALLOW_LAN: 'true', AWBS_PIN_TIME_ZONE: 'Asia/Seoul',
    AWBS_ORIGIN: `http://127.0.0.1:${String(webPort)}`, LOG_LEVEL: 'warn',
    // API가 쓰는 파일(Evidence·보고서 PDF, ~/.agentwbs/wbs)을 시험 전용 폴더에 둔다. 실제 사용자 폴더를 건드리지 않는다(M6-02).
    // HOME을 바꾸면 Playwright가 브라우저를 못 찾으므로 원래 설치 위치를 알려 준다.
    HOME: home, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright'),
  };
  const node = (args: string[]) => execFileSync('node', ['--conditions=awbs-source', ...args], { cwd: ROOT, env, encoding: 'utf8' });
  node(['packages/db/src/migrate-cli.ts']);
  const psql = (sql: string) => execFileSync('docker', ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'awbs_owner', '-d', 'awbs_test_report'], { input: sql, stdio: ['pipe', 'ignore', 'inherit'] });
  // 보고서는 기간 끝 시점의 상태를 이력에서 커밋 순서로 되살린다(owner 2026-11-27 아이템 13).
  // 원본 자료를 「프로젝트 시작(10-27) 전부터 이 상태였다」로 넣으려고, seed 동안만 커밋 시계를 과거로 옮긴다(관리자 전용 시험 설정).
  const shift = Math.floor((Date.parse('2026-10-20T00:00:00+09:00') - Date.now()) / 1000);
  psql(`alter database awbs_test_report set awbs.test_clock_offset='${String(shift)} seconds';`);
  node(['packages/db/src/seed-cli.ts', 'demo']);
  // 정기 보고서가 원본 기간(10-27~)부터 생기도록 시작일을 원본 값으로 맞춘다(P MOCK project.start). 보고서는 API worker가 아니라 시험이 만든다.
  execFileSync('docker', ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'awbs_owner', '-d', 'awbs_test_report'], {
    input: "update projects set start_date='2026-10-27', target_date='2026-11-12'; alter database awbs_test_report reset awbs.test_clock_offset;"
      // 실제 커밋 시각은 시험 시계로 옮길 수 없다. 준비 자료는 커밋 시계 값을 실제 커밋 시각으로 옮겨 적는다(관리자 전용 준비).
      + ' insert into commit_real(xid,stamp,committed_at,observed_at) select xid,committed_at,committed_at,committed_at from commit_log on conflict do nothing;',
    stdio: ['pipe', 'ignore', 'inherit'],
  });
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
    },
  });
  exitCode = result.status ?? 1;
} finally {
  api?.kill('SIGTERM');
  spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' }); // -v: 익명 볼륨까지 지운다(M6 통합, docker 규칙)
  rmSync(home, { recursive: true, force: true });
  process.exitCode = exitCode;
}
