import { test, expect } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('env:init은 PC별 비밀 키를 공유하고 기존 env를 덮어쓰지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf3-env-'));
  try {
    const envs: string[] = [];
    for (const name of ['one', 'two']) {
      const worktree = join(root, name);
      await mkdir(join(worktree, 'scripts'), { recursive: true });
      await cp(new URL('../env-init.ts', import.meta.url), join(worktree, 'scripts/env-init.ts'));
      await cp(new URL('../../.env.example', import.meta.url), join(worktree, '.env.example'));
      const run = () => promisify(execFile)(process.execPath, [join(worktree, 'scripts/env-init.ts')], { env: { ...process.env, AWBS_HOME: join(root, 'home') } });
      await run();
      const before = await readFile(join(worktree, '.env'), 'utf8');
      envs.push(before);
      await run();
      expect(await readFile(join(worktree, '.env'), 'utf8')).toBe(before);
      expect((await stat(join(worktree, '.env'))).mode & 0o777).toBe(0o600);
    }
    const key = /^AWBS_SECRET_KEY=([a-f0-9]{64})$/m.exec(envs[0] ?? '')?.[1];
    expect(key).toBeDefined();
    expect(envs[1]).toContain(`AWBS_SECRET_KEY=${key}`);
    expect((await stat(join(root, 'home/wbs/secret-key'))).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
