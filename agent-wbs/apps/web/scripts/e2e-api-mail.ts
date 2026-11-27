/**
 * M6-03 설정 → 보고서 · 메일 화면을 실제 API·전용 DB(demo seed)·로컬 가짜 SMTP로 확인한다(G§12 시나리오 25의 설정 화면 부분).
 *
 *   pnpm --filter @awbs/web e2e:api:mail
 *
 * 하는 일(끝나면 모두 지운다): 이 시험 전용 PostgreSQL 컨테이너(mail-e2e-pg-…)를 빈 포트에 띄우고,
 * migration → demo seed → 프로젝트 시작일을 원본 값(2026-10-27)으로 → auth CLI 비밀번호 → API(LAN 모드, 127.0.0.2)
 * → 보조 프로세스(e2e/fakes/mail-e2e-worker.ts: 가짜 SMTP·보고서 생성·메일 worker 반복) → Playwright `api-mail`.
 * 방식은 scripts/e2e-api-report.ts(M6-01)와 같다. 실제 메일 서버에는 연결하지 않는다(Q-13 미결).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
// M6 통합: compose.yaml과 같은 Debian postgres:16(정렬 규칙을 맞춘다, M5·M7 통합 결정)과 track_commit_timestamp=on(M6-01 보고서 상태 이력 필수).
const IMAGE = 'postgres:16@sha256:07abc3f43c9395b0bdbbab36bc25ddb0e8d83cd4fcafb5fb7d6abe14ff156dd8';
const name = `mail-e2e-pg-${randomBytes(3).toString('hex')}`;
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
let helper: ChildProcess | undefined;
const temp = mkdtempSync(join(tmpdir(), 'awbs-mail-e2e-'));
let exitCode = 1;
try {
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_USER=awbs_owner', '-e', `POSTGRES_PASSWORD=${dbPassword}`,
    '-e', 'POSTGRES_DB=awbs_test_mail', '-e', 'LANG=C.UTF-8', '-p', '127.0.0.1::5432', IMAGE, '-c', 'track_commit_timestamp=on'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'awbs_owner', '-d', 'awbs_test_mail']).status === 0) break;
    await sleep(500);
  }
  const apiPort = await freePort();
  const webPort = await freePort();
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_mail`,
    TEST_DATABASE_URL: `postgres://awbs_owner:${dbPassword}@127.0.0.1:${String(dbPort)}/awbs_test_mail`,
    AWBS_HOST: '127.0.0.2', AWBS_PORT: String(apiPort), AWBS_ALLOW_LAN: 'true',
    AWBS_ORIGIN: `http://127.0.0.1:${String(webPort)}`, LOG_LEVEL: 'warn',
    // SMTP 비밀번호 암호화 키(이 시험 전용, 끝나면 DB와 함께 사라진다)
    AWBS_SECRET_KEY: randomBytes(32).toString('hex'),
  };
  const node = (args: string[], input?: string) => execFileSync('node', ['--conditions=awbs-source', ...args], { cwd: ROOT, env, input, encoding: 'utf8' });
  node(['packages/db/src/migrate-cli.ts']);
  node(['packages/db/src/seed-cli.ts', 'demo']);
  // 정기 보고서가 원본 기간(10-27~)부터 생기도록 시작일을 원본 값으로 맞춘다(P MOCK project.start). 보고서는 API worker가 아니라 시험이 만든다.
  execFileSync('docker', ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'awbs_owner', '-d', 'awbs_test_mail'], {
    // Q-13 결정 A: 접속 주소를 넣어 둔다. 내부 수신자 메일에는 링크가 있고, 외부 수신자 메일에는 링크가 0건인지 화면 시험이 함께 본다.
    input: "update projects set start_date='2026-10-27', target_date='2026-11-12'; update app_settings set app_url='http://127.0.0.1:5173/';",
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  node(['apps/api/src/platform/auth-cli.ts', 'set-password'], `${leadPassword}\n`);
  api = spawn('node', ['--conditions=awbs-source', 'apps/api/src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.2:${String(apiPort)}/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const portFile = join(temp, 'smtp.json');
  helper = spawn('node', ['--conditions=awbs-source', 'e2e/fakes/mail-e2e-worker.ts'], { cwd: ROOT, env: { ...env, SMTP_PORT_FILE: portFile }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 120 && !existsSync(portFile); i++) await sleep(250);
  const fake = JSON.parse(readFileSync(portFile, 'utf8')) as { smtpPort: number; controlPort: number; user: string; password: string };
  const result = spawnSync('node', ['scripts/playwright.ts', 'api-mail', ...process.argv.slice(2).filter((a) => a !== '--')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AWBS_E2E_PORT: String(webPort),
      AWBS_E2E_API: `http://127.0.0.2:${String(apiPort)}`,
      AWBS_E2E_PASSWORD: leadPassword,
      AWBS_E2E_SMTP: JSON.stringify(fake),
    },
  });
  exitCode = result.status ?? 1;
} finally {
  helper?.kill('SIGTERM');
  api?.kill('SIGTERM');
  rmSync(temp, { recursive: true, force: true });
  spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' }); // -v: 익명 볼륨까지 지운다(M6 통합, docker 규칙)
  process.exitCode = exitCode;
}
