/**
 * 실제 API·전용 DB로 M3-07 핵심 흐름(검증·Evidence 연결·추가·고아 경고·Gate·이력·대시보드)을 시험한다.
 * 대시보드·Evidence 추가 API는 서버 후속 2차(keeproll/srv-followup2)에 있다. 그 서버가 들어간 checkout에서 실행한다. scripts/e2e-api.ts(M3-01)와 같은 방식이다.
 *
 *   pnpm --filter @awbs/web e2e:api:m307
 *
 * 하는 일(끝나면 모두 지운다):
 * 1. 이 시험 전용 PostgreSQL 컨테이너(m307-e2e-pg-…)를 빈 포트에 띄운다. 개발용 DB는 건드리지 않는다.
 * 2. migration → demo seed(원본 Mock 12 Task가 든 active 프로젝트) → auth CLI로 LAN 비밀번호 설정 → API 기동(LAN 모드).
 *    demo seed는 시험 DB 이름(awbs_test_…)에서만 돈다(packages/db test-database.ts).
 *    LAN 모드는 127.0.0.1이 아닌 주소에서만 켜지므로 API는 127.0.0.2(같은 PC의 다른 loopback 주소)에 띄운다.
 *    화면(preview 서버 127.0.0.1)이 API로 요청을 넘기므로 API가 보는 접속 주소는 127.0.0.1(loopback)이다.
 * 3. demo seed에는 Evidence가 없어 TASK-0007의 QA 검증에 Evidence 1건을 SQL로 넣는다(파일 내용은 시험하지 않음).
 * 4. Playwright `api-m307` 시험을 실행한다.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const IMAGE = 'postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d';
const name = `m307-e2e-pg-${randomBytes(3).toString('hex')}`;
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
    '-e', 'POSTGRES_DB=awbs_test_m307', '-p', '127.0.0.1::5432', IMAGE], { stdio: ['ignore', 'ignore', 'inherit'] });
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'awbs_owner', '-d', 'awbs_test_m307']).status === 0) break;
    await sleep(500);
  }
  const apiPort = await freePort();
  const webPort = await freePort();
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_m307`,
    TEST_DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_m307`,
    AWBS_HOST: '127.0.0.2', AWBS_PORT: String(apiPort), AWBS_ALLOW_LAN: 'true',
    AWBS_ORIGIN: `http://127.0.0.1:${String(webPort)}`, LOG_LEVEL: 'warn',
  };
  const node = (args: string[], input?: string) => execFileSync('node', ['--conditions=awbs-source', ...args], { cwd: ROOT, env, input, encoding: 'utf8' });
  node(['packages/db/src/migrate-cli.ts']);
  node(['packages/db/src/seed-cli.ts', 'demo']);
  execFileSync('docker', ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'awbs_owner', '-d', 'awbs_test_m307'], {
    input: `insert into evidence(project_id,task,attempt,verification,kind,storage_path,sha256,size)
      select v.project_id,a.task,a.id,v.id,'로그','e2e/vitest.txt',repeat('a',64),10
      from verifications v join task_attempts a on a.id=v.attempt join tasks t on t.id=a.task where t.task_key='TASK-0007';`,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  node(['apps/api/src/platform/auth-cli.ts', 'set-password'], `${leadPassword}\n`);
  api = spawn('node', ['--conditions=awbs-source', 'apps/api/src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.2:${String(apiPort)}/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const result = spawnSync('node', ['scripts/playwright.ts', 'api-m307', ...process.argv.slice(2).filter((a) => a !== '--')], {
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
