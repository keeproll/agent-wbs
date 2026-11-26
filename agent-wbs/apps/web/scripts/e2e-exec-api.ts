/**
 * M3-06: 실제 API·전용 DB로 작업 실행 화면의 핵심 흐름을 시험한다(UAT-EXEC-UI·MSG-UI의 「API+E2E」 부분).
 * scripts/e2e-api.ts(M3-01)와 같은 순서이고, 다른 점은 두 가지다.
 * - DB 이름이 awbs_test_로 시작한다. demo seed(원본 Mock과 같은 Task·시도·메시지)는 시험 DB에만 넣을 수 있기 때문이다.
 * - `seed demo`로 active 프로젝트를 만든 뒤 Playwright `api-exec` 시험을 실행한다.
 *
 *   pnpm --filter @awbs/web e2e:api-exec
 *
 * 하는 일(끝나면 모두 지운다):
 * 1. 이 시험 전용 PostgreSQL 컨테이너(m306-e2e-pg-…)를 빈 포트에 띄운다. 개발용 awbs-postgres는 건드리지 않는다.
 * 2. migration → demo seed(system seed 포함) → auth CLI로 LAN 비밀번호 설정 → API 기동(LAN 모드) → auth CLI로 1회용 링크 발급.
 *    LAN 모드는 127.0.0.1이 아닌 주소에서만 켜지므로 API는 127.0.0.2(같은 PC의 다른 loopback 주소)에 띄운다.
 *    화면(preview 서버 127.0.0.1)이 API로 요청을 넘기므로 API가 보는 접속 주소는 127.0.0.1(loopback)이다.
 * 3. Playwright `api-exec` 시험을 실행한다.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const IMAGE = 'postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d';
const name = `m306-e2e-pg-${randomBytes(3).toString('hex')}`;
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
    '-e', 'POSTGRES_DB=awbs_test_m306', '-p', '127.0.0.1::5432', IMAGE], { stdio: ['ignore', 'ignore', 'inherit'] });
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'awbs_owner', '-d', 'awbs_test_m306']).status === 0) break;
    await sleep(500);
  }
  const apiPort = await freePort();
  const webPort = await freePort();
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_m306`,
    TEST_DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_m306`,
    AWBS_HOST: '127.0.0.2', AWBS_PORT: String(apiPort), AWBS_ALLOW_LAN: 'true',
    AWBS_ORIGIN: `http://127.0.0.1:${String(webPort)}`, LOG_LEVEL: 'warn',
  };
  const node = (args: string[], input?: string) => execFileSync('node', ['--conditions=awbs-source', ...args], { cwd: ROOT, env, input, encoding: 'utf8' });
  node(['packages/db/src/migrate-cli.ts']);
  node(['packages/db/src/seed-cli.ts', 'demo']);
  // 결함 우회(보고함): demo seed가 MSG-001~003을 넣고도 메시지 번호 counter를 올리지 않아 첫 새 메시지가 msg_key 중복(500)이 된다.
  // 서버·seed는 고치지 않고 이 시험 DB에서만 counter를 이미 있는 메시지 수에 맞춘다.
  execFileSync('docker', ['exec', name, 'psql', '-U', 'awbs_owner', '-d', 'awbs_test_m306', '-v', 'ON_ERROR_STOP=1', '-c',
    "insert into counters(project_id,kind,value) select project_id,'message',count(*) from messages group by project_id on conflict (project_id,kind) do update set value=excluded.value"],
  { stdio: ['ignore', 'ignore', 'inherit'] });
  node(['apps/api/src/platform/auth-cli.ts', 'set-password'], `${leadPassword}\n`);
  api = spawn('node', ['--conditions=awbs-source', 'apps/api/src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.2:${String(apiPort)}/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const token = (link: string) => new URL(link.trim()).hash.replace('#login-token=', '');
  const linkA = token(node(['apps/api/src/platform/auth-cli.ts', 'login-link']));
  const result = spawnSync('node', ['scripts/playwright.ts', 'api-exec', ...process.argv.slice(2).filter((a) => a !== '--')], {
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
