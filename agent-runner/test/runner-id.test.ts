import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { State } from '../src/state/state.ts';

const cli = join(import.meta.dirname, '../src/runner-id-cli.ts');
const base = () => process.env.AWBS_TEST_TMP ?? tmpdir();
beforeAll(async () => { await mkdir(base(), { recursive: true }); });

function run(home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // 토큰 없이도 동작해야 한다(환경 변수는 AWBS_HOME과 PATH만).
    const child = spawn(process.execPath, [cli], { env: { AWBS_HOME: home, PATH: process.env.PATH ?? '' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.once('error', reject);
    child.once('close', (code) => { resolve({ code, stdout, stderr }); });
  });
}

test('runner-id: 처음이면 상태를 만들고 그 runnerId를 내며, 다시 실행해도 같은 값이다', async () => {
  const home = await mkdtemp(join(base(), 'runner-id-'));
  try {
    const first = await run(home);
    expect(first.code).toBe(0);
    const id = first.stdout.trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const file = join(home, 'state', 'runner.json');
    expect((JSON.parse(await readFile(file, 'utf8')) as { runnerId: string }).runnerId).toBe(id);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const before = await readFile(file, 'utf8');
    const second = await run(home);
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe(id);
    // 있는 상태 파일은 덮어쓰지 않는다.
    expect(await readFile(file, 'utf8')).toBe(before);
    // Runner가 여는 상태도 같은 식별자다.
    const state = await State.open(home);
    try { expect(state.snapshot.runnerId).toBe(id); } finally { await state.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('runner-id: Runner가 데이터 폴더를 쓰는 중이면 종료 코드 3으로 멈춘다', async () => {
  const home = await mkdtemp(join(base(), 'runner-id-lock-'));
  const state = await State.open(home);
  try {
    const result = await run(home);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Runner를 멈춘 뒤');
  } finally {
    await state.close();
    await rm(home, { recursive: true, force: true });
  }
});
