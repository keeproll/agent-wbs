/**
 * M3 통합: 서버 후속 2차 API에 새로 연결한 화면을 실제 API·전용 DB로 확인한다.
 * - 프로젝트 정보 편집(updateProject), 「지금 확인」(checkInputs), 변경 제안 단건 조회(getProposal)·「제외」(excludeProposalOp), Planning 표시 키(planningKey).
 *
 *   pnpm --filter @awbs/web e2e:api:m3int
 *
 * 하는 일(끝나면 모두 지운다): 이 시험 전용 PostgreSQL 컨테이너(m3int-e2e-pg-…)를 빈 포트에 띄우고,
 * migration → demo seed → 알림 1건(SQL) → auth CLI 비밀번호 → API(LAN 모드, 127.0.0.2) → Playwright `api-m3int`. 방식은 scripts/e2e-api-m307.ts와 같다.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const IMAGE = 'postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d';
const name = `m3int-e2e-pg-${randomBytes(3).toString('hex')}`;
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
    '-e', 'POSTGRES_DB=awbs_test_m3int', '-p', '127.0.0.1::5432', IMAGE], { stdio: ['ignore', 'ignore', 'inherit'] });
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'awbs_owner', '-d', 'awbs_test_m3int']).status === 0) break;
    await sleep(500);
  }
  const apiPort = await freePort();
  const webPort = await freePort();
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_m3int`,
    TEST_DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_m3int`,
    AWBS_HOST: '127.0.0.2', AWBS_PORT: String(apiPort), AWBS_ALLOW_LAN: 'true',
    AWBS_ORIGIN: `http://127.0.0.1:${String(webPort)}`, LOG_LEVEL: 'warn',
  };
  const node = (args: string[], input?: string) => execFileSync('node', ['--conditions=awbs-source', ...args], { cwd: ROOT, env, input, encoding: 'utf8' });
  node(['packages/db/src/migrate-cli.ts']);
  node(['packages/db/src/seed-cli.ts', 'demo']);
  // demo seed에는 열린 알림이 없다. 「확인」(ackAlert)을 실제 화면으로 시험하려고 반복 재작업 알림 1건을 넣는다(대시보드가 그 Task와 연결).
  execFileSync('docker', ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'awbs_owner', '-d', 'awbs_test_m3int'], {
    input: `insert into alerts(project_id,key,severity,target) select id,'rework-limit:TASK-0007','warn','{"taskKey":"TASK-0007","message":"자동 재작업 한도를 넘었습니다."}'::jsonb from projects;`,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  node(['apps/api/src/platform/auth-cli.ts', 'set-password'], `${leadPassword}\n`);
  api = spawn('node', ['--conditions=awbs-source', 'apps/api/src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.2:${String(apiPort)}/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const result = spawnSync('node', ['scripts/playwright.ts', 'api-m3int', ...process.argv.slice(2).filter((a) => a !== '--')], {
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
