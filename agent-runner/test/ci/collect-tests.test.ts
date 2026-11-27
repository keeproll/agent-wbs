// 조정자 결정 2: ① 시험 목록 수집 기본 구현. 형식이 맞지 않으면 추측하지 않고 「수집 불가」.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createTestCollector, listCommand, parsePlaywrightList, parseVitestList, type CollectExecute } from '../../src/ci/collect-tests.ts';
import { createRunCommand, probeEnv } from '../../src/readiness/command.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function project(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'collect-')); roots.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts }));
  return dir;
}

test.each([
  ['vitest run', { test: 'vitest run --config vitest.config.ts' }, ['pnpm', 'test', '--', 'unit'], ['pnpm', 'exec', 'vitest', 'list', '--config', 'vitest.config.ts', 'unit', '--json']],
  ['우리 저장소 감싸기', { test: 'node scripts/vitest.ts --config vitest.db.config.ts' }, ['pnpm', 'run', 'test'], ['pnpm', 'exec', 'vitest', 'list', '--config', 'vitest.db.config.ts', '--json']],
  ['playwright', { e2e: 'playwright test -c e2e.config.ts' }, ['pnpm', 'e2e'], ['pnpm', 'exec', 'playwright', 'test', '-c', 'e2e.config.ts', '--list', '--reporter=json']],
] as const)('목록 명령: %s (--json은 맨 끝)', async (_name, scripts, argv, expected) => {
  expect((await listCommand(argv, await project(scripts))).argv).toEqual(expected);
});

test.each([
  ['pnpm이 아님', { test: 'vitest' }, ['npm', 'test']],
  ['스크립트 없음', { lint: 'eslint .' }, ['pnpm', 'test']],
  ['셸 기호(&&)', { test: 'pnpm build && vitest run' }, ['pnpm', 'test']],
  ['변수', { test: 'vitest run $ARGS' }, ['pnpm', 'test']],
  ['다른 실행기', { test: 'jest' }, ['pnpm', 'test']],
  ['스크립트 이름 대신 옵션', { test: 'vitest' }, ['pnpm', '--filter', 'x', 'test']],
] as const)('수집 불가: %s', async (_name, scripts, argv) => {
  await expect(listCommand(argv, await project(scripts))).rejects.toThrow('시험 목록 수집 불가');
});

test('vitest 목록: 작업 폴더 기준 경로 :: 이름. 밖 파일·빈 이름·JSON 아님은 수집 불가', () => {
  const cwd = '/w/ci-1';
  expect(parseVitestList(JSON.stringify([{ name: 'a > b', file: '/w/ci-1/test/x.test.ts' }, { name: 'c', file: 'test/y.test.ts' }]), cwd)).toEqual(['test/x.test.ts::a > b', 'test/y.test.ts::c']);
  expect(() => parseVitestList(JSON.stringify([{ name: 'a', file: '/etc/x.ts' }]), cwd)).toThrow('작업 폴더 밖');
  expect(() => parseVitestList(JSON.stringify([{ name: '', file: 'x.ts' }]), cwd)).toThrow('수집 불가');
  expect(() => parseVitestList('> pnpm banner\n[]', cwd)).toThrow('JSON이 아닙니다');
  expect(() => parseVitestList('{}', cwd)).toThrow('배열');
});

test('playwright 목록: 중첩 describe 이름과 프로젝트를 붙인다', () => {
  const report = { suites: [{ title: 'e2e/a.spec.ts', file: 'e2e/a.spec.ts', specs: [{ title: '첫 화면', file: 'e2e/a.spec.ts', tests: [{ projectName: 'chromium' }] }],
    suites: [{ title: '로그인', file: 'e2e/a.spec.ts', specs: [{ title: '성공', file: 'e2e/a.spec.ts', tests: [{ projectName: 'chromium' }, { projectName: 'mobile' }] }] }] }] };
  expect(parsePlaywrightList(JSON.stringify(report), '/w')).toEqual(['e2e/a.spec.ts::첫 화면 [chromium]', 'e2e/a.spec.ts::로그인 > 성공 [chromium]', 'e2e/a.spec.ts::로그인 > 성공 [mobile]']);
  expect(() => parsePlaywrightList('{"suites":{}}', '/w')).toThrow('suites');
});

test('수집기는 같은 실행기로 목록 명령을 돌리고, 0이 아닌 종료·중복 식별자는 수집 불가', async () => {
  const cwd = await project({ test: 'vitest run' });
  const execute = vi.fn<CollectExecute>(async () => ({ code: 0, stdout: JSON.stringify([{ name: 'a', file: join(cwd, 't.test.ts') }]), stderr: '' }));
  expect(await createTestCollector(execute)(['pnpm', 'test'], cwd)).toEqual(['t.test.ts::a']);
  expect(execute).toHaveBeenCalledWith(['pnpm', 'exec', 'vitest', 'list', '--json'], cwd, undefined);
  execute.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'x' });
  await expect(createTestCollector(execute)(['pnpm', 'test'], cwd)).rejects.toThrow('종료 코드 1');
  execute.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([{ name: 'a', file: 't.ts' }, { name: 'a', file: 't.ts' }]), stderr: '' });
  await expect(createTestCollector(execute)(['pnpm', 'test'], cwd)).rejects.toThrow('두 번');
});

test('실제 vitest(이 저장소, node scripts/vitest.ts)로 목록을 모은다: 출력 형식이 계약과 같고 시험 파일을 바꾸지 않는다', async () => {
  const cwd = resolve(import.meta.dirname, '../..');
  const run = createRunCommand({ env: probeEnv(process.env), timeoutMs: 60_000 });
  // 점검 명령 실행기는 작업 폴더를 받지 않으므로 pnpm -C로 이 저장소 폴더에서 돌린다.
  const ids = await createTestCollector((argv) => run('pnpm', ['-C', cwd, ...argv.slice(1)]))(['pnpm', 'test', 'test/config.test.ts'], cwd);
  expect(ids.length).toBeGreaterThanOrEqual(3);
  expect(ids).toContain('test/config.test.ts::기본값');
}, 60_000);

test('방어 점검 9: package.json이 링크·FIFO면 따라가거나 기다리지 않고 수집 불가', async () => {
  const { mkfifo } = { mkfifo: (p: string) => import('node:child_process').then(({ execFileSync }) => execFileSync('mkfifo', [p])) };
  const linked = await project({});
  const secret = join(linked, 'secret.json');
  await writeFile(secret, JSON.stringify({ scripts: { test: 'vitest run' } }));
  await rm(join(linked, 'package.json'));
  await import('node:fs/promises').then(({ symlink }) => symlink(secret, join(linked, 'package.json')));
  await expect(listCommand(['pnpm', 'test'], linked)).rejects.toThrow('package.json');
  const fifo = await project({});
  await rm(join(fifo, 'package.json'));
  await mkfifo(join(fifo, 'package.json'));
  await expect(listCommand(['pnpm', 'test'], fifo)).rejects.toThrow('package.json');
});
