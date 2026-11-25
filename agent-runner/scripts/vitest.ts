// `pnpm test -- <이름>`의 `--`를 vitest가 필터로 인식하지 못하고 전체를 실행하므로 여기서 제거한다.
import { startVitest } from 'vitest/node';
import { parseCLI } from 'vitest/node';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const { filter, options } = parseCLI(['vitest', 'run', ...args]);
const vitest = await startVitest('test', filter, { ...options, watch: false, run: true });
await vitest.close();
