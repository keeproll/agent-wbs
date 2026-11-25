import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const main = join(import.meta.dirname, '../src/main.ts');

function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--conditions=awbs-source', main], {
    env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/awbs_test_x', ...env },
  });
  const state = { output: '' };
  child.stdout.on('data', (chunk) => (state.output += String(chunk)));
  child.stderr.on('data', (chunk) => (state.output += String(chunk)));
  return { child, state };
}

test.each([[['SIGTERM']], [['SIGINT']], [['SIGTERM', 'SIGINT']]] as const)(
  'DB 재시도 중 %s는 오류 없이 종료 코드 0',
  async (signals) => {
    const { child, state } = start({});
    const closed = once(child, 'close') as Promise<[number | null, string | null]>;
    while (!state.output.includes('DB 연결 재시도')) await once(child.stdout, 'data');
    for (const signal of signals) child.kill(signal);
    expect(await closed).toEqual([0, null]);
    expect(state.output).not.toMatch(/기동 실패|more than once|after calling end/);
  },
);

test('신호 없이 DB에 끝내 연결하지 못하면 3회 재시도 후 종료 코드 1', async () => {
  const { child, state } = start({});
  expect(await once(child, 'close')).toEqual([1, null]);
  expect(state.output.match(/DB 연결 재시도/g)).toHaveLength(3);
  expect(state.output).toContain('기동 실패');
});
