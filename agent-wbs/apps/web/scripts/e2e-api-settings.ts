/**
 * 실제 API·전용 DB로 설정 화면(M3-08)의 핵심 흐름을 시험한다(UAT의 「API+E2E」).
 *
 *   pnpm --filter @awbs/web e2e:api-settings
 *
 * scripts/e2e-api.ts(M3-01, 로그인 시험)와 같은 순서로 환경을 만든다. 공통 스크립트를 고치지 않으려고 따로 둔다.
 * 다른 점: 컨테이너 이름(m308-e2e-pg-…)과 실행할 시험(api-settings)뿐이다.
 *
 * 하는 일(끝나면 모두 지운다):
 * 1. 이 시험 전용 PostgreSQL 컨테이너(m308-e2e-pg-…)를 빈 포트에 띄운다. 개발용 awbs-postgres는 건드리지 않는다.
 * 2. migration → system seed → auth CLI로 LAN 비밀번호 설정 → API 기동(LAN 모드) → auth CLI로 1회용 링크 발급.
 *    LAN 모드는 127.0.0.1이 아닌 주소에서만 켜지므로 API는 127.0.0.2(같은 PC의 다른 loopback 주소)에 띄운다.
 *    화면(preview 서버 127.0.0.1)이 API로 요청을 넘기므로 API가 보는 접속 주소는 127.0.0.1(loopback)이다.
 * 3. Playwright `api-settings` 시험을 실행한다.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
// M6 통합: compose.yaml과 같은 Debian postgres:16(정렬 규칙을 맞춘다, M5·M7 통합 결정)과 track_commit_timestamp=on(M6-01 보고서 상태 이력 필수).
const IMAGE = 'postgres:16@sha256:07abc3f43c9395b0bdbbab36bc25ddb0e8d83cd4fcafb5fb7d6abe14ff156dd8';
const name = `m308-e2e-pg-${randomBytes(3).toString('hex')}`;
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
    '-e', 'POSTGRES_DB=awbs_e2e', '-e', 'LANG=C.UTF-8', '-p', '127.0.0.1::5432', IMAGE, '-c', 'track_commit_timestamp=on'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'awbs_owner', '-d', 'awbs_e2e']).status === 0) break;
    await sleep(500);
  }
  const apiPort = await freePort();
  const webPort = await freePort();
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_e2e`,
    AWBS_HOST: '127.0.0.2', AWBS_PORT: String(apiPort), AWBS_ALLOW_LAN: 'true',
    AWBS_ORIGIN: `http://127.0.0.1:${String(webPort)}`, LOG_LEVEL: 'warn',
  };
  const node = (args: string[], input?: string) => execFileSync('node', ['--conditions=awbs-source', ...args], { cwd: ROOT, env, input, encoding: 'utf8' });
  node(['packages/db/src/migrate-cli.ts']);
  node(['packages/db/src/seed-cli.ts', 'system']);
  node(['apps/api/src/platform/auth-cli.ts', 'set-password'], `${leadPassword}\n`);
  api = spawn('node', ['--conditions=awbs-source', 'apps/api/src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.2:${String(apiPort)}/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const token = (link: string) => new URL(link.trim()).hash.replace('#login-token=', '');
  const linkA = token(node(['apps/api/src/platform/auth-cli.ts', 'login-link']));
  const result = spawnSync('node', ['scripts/playwright.ts', 'api-settings', ...process.argv.slice(2).filter((a) => a !== '--')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AWBS_E2E_PORT: String(webPort),
      AWBS_E2E_API: `http://127.0.0.2:${String(apiPort)}`,
      AWBS_E2E_LINK_TOKEN: linkA,
      AWBS_E2E_PASSWORD: leadPassword,
    },
  });
  exitCode = result.status ?? 1;
} finally {
  api?.kill('SIGTERM');
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  process.exitCode = exitCode;
}
