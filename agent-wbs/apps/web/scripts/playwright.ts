// `pnpm e2e -- <이름>`의 `--`를 Playwright가 「파일 이름 필터」로 받지 못해 전체를 실행하므로 여기서 지운다(scripts/vitest.ts와 같은 이유).
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const acceptance = args[0] === 'acceptance';
const result = spawnSync(acceptance ? process.execPath : 'playwright', acceptance
  ? ['../../e2e/acceptance/run.ts', ...args.slice(1)] : ['test', ...args],
{ stdio: 'inherit', shell: !acceptance && process.platform === 'win32' });
process.exitCode = result.status ?? 1;
