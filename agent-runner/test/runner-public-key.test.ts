import { execFileSync, spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('최초 등록 명령은 실제 상태의 ID·X25519 공개키만 만들고 기존 파일은 덮어쓰지 않는다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awbs-enroll-'));
  const publicKey = join(home, 'runner.pub.pem');
  const script = join(import.meta.dirname, '../scripts/runner-public-key.ts');
  const env = { ...process.env, AWBS_HOME: home };
  try {
    const runnerId = execFileSync(process.execPath, [script, publicKey], { env, encoding: 'utf8' }).trim();
    const state = JSON.parse(await readFile(join(home, 'state/runner.json'), 'utf8')) as { runnerId: string };
    expect(runnerId).toBe(state.runnerId);
    const pem = await readFile(publicKey, 'utf8');
    expect(createPublicKey(pem).asymmetricKeyType).toBe('x25519');
    expect(pem).not.toContain('PRIVATE KEY');
    expect((await stat(publicKey)).mode & 0o777).toBe(0o600);
    const repeated = spawnSync(process.execPath, [script, publicKey], { env, encoding: 'utf8' });
    expect(repeated.status).toBe(1);
    expect(repeated.stdout).toBe('');
    expect(await readFile(publicKey, 'utf8')).toBe(pem);
    expect(spawnSync(process.execPath, [script, 'relative.pem'], { env }).status).toBe(1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
