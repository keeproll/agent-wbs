// 전용 빈 DB부터 화면 인수 시험을 실행한다. 다른 작업의 서버·DB는 재사용하지 않는다.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import { writeCoverage } from './coverage.ts';
import { acceptanceOutput } from './output.ts';

const root = resolve(import.meta.dirname, '../..');
const web = join(root, 'apps/web');
const args = process.argv.slice(2);
const name = `awbs-m801-${randomBytes(4).toString('hex')}`;
const out = acceptanceOutput(process.env.AWBS_ACCEPTANCE_OUT);
console.log(`인수 시험 결과: ${out}`);
const supplements = writeCoverage(out).map(path => path.replace(/^agent-wbs\//, ''));
if (args.length === 0) assert(existsSync(process.env.AWBS_BASELINE_DIR ?? join(homedir(), '.cache/agent-wbs-baseline')), '프로토타입 비교 기준 이미지가 없습니다. AWBS_BASELINE_DIR을 확인하세요.');
const password = randomBytes(24).toString('base64url');
const image = 'postgres:16@sha256:07abc3f43c9395b0bdbbab36bc25ddb0e8d83cd4fcafb5fb7d6abe14ff156dd8';
const command = (file: string, argv: string[]) => execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const port = () => new Promise<number>((done, fail) => {
  const server = createServer(); server.on('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => address && typeof address === 'object' ? done(address.port) : fail(new Error('빈 포트 없음')));
  });
});
let child: ChildProcess | undefined;
let created = false;
let stopping = false;
const results: { command: string; exitCode: number }[] = [];
const stop = () => { stopping = true; child?.kill('SIGTERM'); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  const apiPort = await port(), webPort = await port();
  if (!args.includes('--list')) {
    command('docker', ['run', '-d', '--name', name, '-e', 'POSTGRES_USER=awbs_owner', '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', 'POSTGRES_DB=awbs_test_m801', '-e', 'LANG=C.UTF-8', '-p', '127.0.0.1::5432', image, '-c', 'track_commit_timestamp=on']);
    created = true;
    const start = performance.now();
    for (;;) {
      try { command('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'awbs_owner', '-d', 'awbs_test_m801']); break; }
      catch { assert(performance.now() - start < 30_000, '시험 DB 준비 시간 초과'); await setTimeout(100); }
    }
  }
  const dbPort = created ? command('docker', ['port', name, '5432/tcp']).split(':').at(-1) : '1';
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=awbs-source`,
    DATABASE_URL: `postgres://awbs_owner:${password}@127.0.0.1:${dbPort ?? ''}/awbs_test_m801`,
    AWBS_E2E_PORT: String(webPort), AWBS_E2E_API: `http://127.0.0.2:${String(apiPort)}`, AWBS_PORT: String(apiPort),
    AWBS_ACCEPTANCE_OUT: out, AWBS_ACCEPTANCE_JSON: join(out, 'playwright.json'),
    AWBS_VISUAL_OUT: join(out, 'visual/shell'), AWBS_VISUAL_OUT_M302: join(out, 'visual/wbs'),
    AWBS_VISUAL_OUT_M303: join(out, 'visual/task'), AWBS_VISUAL_OUT_M304: join(out, 'visual/project'),
    AWBS_VISUAL_OUT_M305: join(out, 'visual/planning'), AWBS_VISUAL_OUT_M307: join(out, 'visual/verify'),
    AWBS_VISUAL_OUT_M607: join(out, 'visual/design'), AWBS_VISUAL_OUT_M705: join(out, 'visual/ci'),
    AWBS_EXEC_VISUAL_OUT: join(out, 'visual/exec'), AWBS_SETTINGS_VISUAL_OUT: join(out, 'visual/settings'),
    AWBS_PERF_OUT: join(out, 'performance'),
    TEST_DATABASE_URL: `postgres://awbs_owner:${password}@127.0.0.1:${dbPort ?? ''}/awbs_test_m801_scenarios`,
  };
  const run = async (cwd: string, file: string, argv: string[]) => {
    assert(!stopping, '인수 시험이 중단됐습니다.');
    child = spawn(file, argv, { cwd, env: { ...env, AWBS_E2E_OUTPUT_DIR: join(out, 'artifacts', name, String(results.length)) }, stdio: 'inherit' });
    const [code] = await once(child, 'exit') as [number | null];
    results.push({ command: `${file} ${argv.join(' ')}`, exitCode: code ?? 1 });
    writeFileSync(join(out, 'commands.json'), JSON.stringify(results, null, 2));
  };
  await run(web, 'pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.acceptance.config.ts', ...args]);
  if (args.length === 0) {
    const report = JSON.parse(readFileSync(join(out, 'playwright.json'), 'utf8')) as { stats: { skipped: number } };
    if (report.stats.skipped) results.push({ command: '화면 인수 시험 건너뜀 검사', exitCode: 1 });
  }
  // 파일·제목을 고르는 인수는 부분 시험이다. 인수 없는 완료 명령만 아래 실제 API·Runner 보충 시험까지 모두 돈다.
  if (args.length === 0 && !results.some(r => r.exitCode !== 0)) {
    // 빈 DB를 매번 만드는 준비는 다른 작업의 동시 부하도 받는다. 본문의 판정·제한은 유지한다.
    await run(root, process.execPath, ['scripts/vitest.ts', '--config', 'vitest.scenario.config.ts', '--hookTimeout', '60000', ...supplements.filter(path => path.endsWith('.scenario.test.ts'))]);
    await run(root, process.execPath, ['scripts/vitest.ts', '--config', 'vitest.db.config.ts', ...supplements.filter(path => path.endsWith('.db.test.ts'))]);
    for (const script of ['e2e-api.ts', 'e2e-api-wbs.ts', 'e2e-api-task.ts', 'e2e-exec-api.ts', 'e2e-api-settings.ts', 'e2e-api-m307.ts', 'e2e-api-m3int.ts', 'e2e-api-report.ts', 'e2e-api-mail.ts']) {
      await run(web, process.execPath, [`scripts/${script}`]);
    }
  }
  process.exitCode = results.some(r => r.exitCode !== 0) ? 1 : 0;
} finally {
  if (created) command('docker', ['rm', '-f', '-v', name]);
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
}
