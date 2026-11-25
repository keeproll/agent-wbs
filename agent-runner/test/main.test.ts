import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const main = join(import.meta.dirname, '../src/main.ts');

test('설정이 없으면 종료 코드 2', () => {
  const result = spawnSync(process.execPath, [main], { env: {}, encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('AWBS_RUNNER_TOKEN');
});

test('SIGTERM으로 정상 종료하고 토큰을 남기지 않는다', async () => {
  const token = 'y'.repeat(43);
  const child = spawn(process.execPath, [main], { env: { AWBS_RUNNER_TOKEN: token, HOME: '/tmp' } });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  await once(child.stdout, 'data');
  child.kill('SIGTERM');
  const [code] = (await once(child, 'close')) as [number | null];
  expect(code).toBe(0);
  expect(output).toContain('SIGTERM');
  expect(output).not.toContain(token);
});
