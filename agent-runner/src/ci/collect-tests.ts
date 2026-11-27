import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { CommandResult } from '../readiness/command.ts';

/*
 * ① 시험 목록 수집기의 기본 구현(조정자 결정 2).
 *
 * ①은 main에 고정한 pipeline.yaml의 unit·contract 명령마다 「어떤 시험이 있는지」를 개발 전·후 두 번 모은다(시험 삭제 감지, M7-06).
 * 이 수집기는 그 명령에서 「목록만 내는 명령」을 만들어 같은 실행기(전용 계정이면 래퍼 ci-run)로 돌리고, 출력에서 시험 식별자를 읽는다.
 *
 * 받는 모양(우리 저장소 형식)만 다룬다. 다른 모양은 추측하지 않고 「수집 불가」로 실패한다.
 * - 명령: `pnpm <스크립트> [인자…]` 또는 `pnpm run <스크립트> [인자…]`.
 * - 그 스크립트(작업 폴더의 package.json `scripts`)가 다음 중 하나:
 *   - `vitest [run] [옵션…]`
 *   - `node scripts/vitest.ts [옵션…]`(우리 저장소의 vitest 감싸기, 옵션을 그대로 vitest에 넘김)
 *   - `playwright test [옵션…]`
 * - 목록 명령:
 *   - vitest: `pnpm exec vitest list <옵션…> <인자…> --json` → `[{name,file}]`.
 *     `--json`은 반드시 맨 끝에 둔다. 뒤에 다른 값이 오면 vitest가 그 값을 「결과를 쓸 파일」로 읽어 그 파일을 덮어쓴다(실제 재현).
 *   - playwright: `pnpm exec playwright test <옵션…> <인자…> --list --reporter=json` → JSON 보고서의 suites·specs·tests.
 * - 식별자: `<작업 폴더 기준 파일 경로>::<시험 이름>`(playwright는 ` [프로젝트]`를 붙인다). ①이 앞에 단계 이름을 붙인다.
 *
 * 왜 스크립트를 실행해 보지 않고 글자로 읽나: 목록을 얻으려고 시험 자체를 돌리면 느리고, 시험이 바뀌었는지 볼 때마다 부수 효과가 생긴다.
 * 왜 셸 기호가 있으면 거부하나: `a && b`·변수·따옴표가 들어간 스크립트는 어느 부분이 시험 실행기인지 글자만으로 확정할 수 없다.
 */

export type CollectExecute = (argv: readonly string[], cwd: string, signal?: AbortSignal) => Promise<CommandResult>;

export class TestCollectionError extends Error {
  override name = 'TestCollectionError';
  constructor(reason: string) { super(`시험 목록 수집 불가: ${reason}`); }
}

const SHELL = /["'`$|&;<>(){}*?!~\\\n\r]/;
const SCRIPT = /^[A-Za-z0-9:._-]{1,100}$/;

/** 작업 폴더 package.json의 스크립트 글자. 없거나 셸 기호가 있으면 수집 불가. */
async function scriptWords(cwd: string, name: string): Promise<string[]> {
  if (!SCRIPT.test(name)) throw new TestCollectionError('pnpm 스크립트 이름 모양이 아닙니다.');
  let scripts: unknown;
  try { scripts = (JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts; }
  catch { throw new TestCollectionError('작업 폴더의 package.json을 읽지 못했습니다.'); }
  const text = scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>)[name] : undefined;
  if (typeof text !== 'string' || text.trim() === '') throw new TestCollectionError(`package.json에 ${name} 스크립트가 없습니다.`);
  if (SHELL.test(text)) throw new TestCollectionError(`${name} 스크립트에 셸 기호가 있어 시험 실행기를 확정할 수 없습니다.`);
  return text.trim().split(/\s+/);
}

/** 시험 명령(argv)에서 목록 명령을 만든다. 정해진 모양이 아니면 수집 불가. */
export async function listCommand(argv: readonly string[], cwd: string): Promise<{ kind: 'vitest' | 'playwright'; argv: string[] }> {
  if (argv[0] !== 'pnpm') throw new TestCollectionError('pnpm 명령이 아닙니다.');
  const rest = argv[1] === 'run' ? argv.slice(2) : argv.slice(1);
  const [script, ...extra] = rest;
  if (!script || script.startsWith('-')) throw new TestCollectionError('pnpm 스크립트 이름이 없습니다.');
  // `pnpm test -- <필터>`의 `--`는 pnpm이 지운다. 목록 명령에서도 지운다.
  const passed = extra.filter((arg) => arg !== '--');
  const words = await scriptWords(cwd, script);
  if (words[0] === 'vitest') {
    const options = words.slice(words[1] === 'run' ? 2 : 1).filter((word) => word !== '--run');
    return { kind: 'vitest', argv: ['pnpm', 'exec', 'vitest', 'list', ...options, ...passed, '--json'] };
  }
  if (words[0] === 'node' && words[1] === 'scripts/vitest.ts') {
    return { kind: 'vitest', argv: ['pnpm', 'exec', 'vitest', 'list', ...words.slice(2), ...passed, '--json'] };
  }
  if (words[0] === 'playwright' && words[1] === 'test') {
    return { kind: 'playwright', argv: ['pnpm', 'exec', 'playwright', 'test', ...words.slice(2), ...passed, '--list', '--reporter=json'] };
  }
  throw new TestCollectionError(`${script} 스크립트가 vitest·playwright 형식이 아닙니다.`);
}

function fileId(cwd: string, file: unknown): string {
  if (typeof file !== 'string' || file === '') throw new TestCollectionError('목록 항목에 파일 경로가 없습니다.');
  const path = isAbsolute(file) ? relative(cwd, file) : file;
  if (path === '' || path.startsWith('..') || isAbsolute(path)) throw new TestCollectionError('목록의 파일이 작업 폴더 밖입니다.');
  return path;
}

function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout.trim()); }
  catch { throw new TestCollectionError('목록 출력이 JSON이 아닙니다.'); }
}

/** `vitest list --json`: `[{name, file, location?}]` */
export function parseVitestList(stdout: string, cwd: string): string[] {
  const rows = parseJson(stdout);
  if (!Array.isArray(rows)) throw new TestCollectionError('vitest 목록이 배열이 아닙니다.');
  return rows.map((row: unknown) => {
    const item = row as { name?: unknown; file?: unknown } | null;
    if (!item || typeof item.name !== 'string' || item.name.trim() === '') throw new TestCollectionError('vitest 목록 항목에 시험 이름이 없습니다.');
    return `${fileId(cwd, item.file)}::${item.name}`;
  });
}

interface PwSuite { title?: unknown; file?: unknown; specs?: unknown; suites?: unknown }

/** `playwright test --list --reporter=json`: 보고서의 suites(중첩) → specs → tests(projectName). */
export function parsePlaywrightList(stdout: string, cwd: string): string[] {
  const report = parseJson(stdout) as { suites?: unknown } | null;
  if (!report || !Array.isArray(report.suites)) throw new TestCollectionError('playwright 보고서에 suites가 없습니다.');
  const out: string[] = [];
  const walk = (suite: PwSuite, titles: string[], file: string | undefined) => {
    const here = typeof suite.file === 'string' ? suite.file : file;
    // 파일 단위 suite의 제목은 파일 경로라 이름에 넣지 않는다.
    const path = typeof suite.title === 'string' && suite.title !== '' && suite.title !== suite.file ? [...titles, suite.title] : titles;
    if (suite.specs !== undefined && !Array.isArray(suite.specs)) throw new TestCollectionError('playwright specs 모양이 다릅니다.');
    for (const spec of (suite.specs ?? []) as { title?: unknown; file?: unknown; tests?: unknown }[]) {
      if (typeof spec.title !== 'string' || !Array.isArray(spec.tests)) throw new TestCollectionError('playwright spec 모양이 다릅니다.');
      const name = [...path, spec.title].join(' > ');
      const where = fileId(cwd, typeof spec.file === 'string' ? spec.file : here);
      for (const test of spec.tests as { projectName?: unknown }[]) {
        out.push(`${where}::${name}${typeof test.projectName === 'string' && test.projectName ? ` [${test.projectName}]` : ''}`);
      }
    }
    if (suite.suites !== undefined && !Array.isArray(suite.suites)) throw new TestCollectionError('playwright suites 모양이 다릅니다.');
    for (const child of (suite.suites ?? []) as PwSuite[]) walk(child, path, here);
  };
  for (const suite of report.suites as PwSuite[]) walk(suite, [], undefined);
  return out;
}

/**
 * ①의 `collectTests`. 목록 명령을 같은 실행기로 돌리고 식별자를 돌려준다.
 * 종료 코드가 0이 아니거나, 출력 모양이 다르거나, 같은 식별자가 두 번 나오면 수집 불가로 실패한다.
 */
export function createTestCollector(execute: CollectExecute) {
  return async (argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<string[]> => {
    const command = await listCommand(argv, cwd);
    const result = await execute(command.argv, cwd, signal);
    if (result.code !== 0) throw new TestCollectionError(`목록 명령이 종료 코드 ${String(result.code)}로 끝났습니다.`);
    const ids = command.kind === 'vitest' ? parseVitestList(result.stdout, cwd) : parsePlaywrightList(result.stdout, cwd);
    if (new Set(ids).size !== ids.length) throw new TestCollectionError('같은 시험 식별자가 두 번 나왔습니다(이름이 겹치는 시험).');
    return ids;
  };
}
