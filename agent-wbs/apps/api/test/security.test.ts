import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { tokenHash } from '../src/platform/credentials.ts';
import { redact } from '../src/platform/redact.ts';
import { createPool } from '@awbs/db';
import { buildApp } from '../src/app.ts';

describe('security 비밀값과 기동 설정', () => {
  test.each(['/api/unlisted', '/internal/unlisted'])('권한 선언 없는 %s 경로는 등록할 수 없다', async (url) => {
    const pool = createPool('postgres://u:p@127.0.0.1:1/awbs_test_unused', { onError: () => undefined });
    const app = buildApp(pool);
    try {
      expect(() => app.post(url, () => ({ reached: true }))).toThrow('권한');
    } finally { await app.close(); await pool.end(); }
  });
  test('토큰은 SHA-256 해시로 보관한다', () => {
    expect(tokenHash('a')).toMatch(/^[a-f0-9]{64}$/);
  });

  test('LAN은 명시적 허용과 정확한 Origin 설정이 필요하다', () => {
    const env = { DATABASE_URL: 'postgres://u:p@127.0.0.1:26471/awbs_test_m201', AWBS_HOST: '0.0.0.0' };
    expect(() => loadConfig(env)).toThrow();
    expect(() => loadConfig({ ...env, AWBS_ALLOW_LAN: 'true' })).toThrow();
    expect(loadConfig({ ...env, AWBS_ALLOW_LAN: 'true', AWBS_ORIGIN: 'http://192.168.1.2:3100' }))
      .toMatchObject({ lan: true, origin: 'http://192.168.1.2:3100' });
  });

  test('중첩 비밀 필드와 문자열 안의 인증 정보도 가린다', () => {
    const result = JSON.stringify(redact({
      authorization: 'Bearer hunter2', cookie: 'awbs_session=hunter2', password: 'hunter2', pin: 'hunter2',
      nested: { botToken: 'hunter2', tokenSet: true },
      message: 'Bearer hunter2 /bot123:hunter2/send postgres://u:hunter2@localhost/db ?token=hunter2',
    }));
    expect(result).not.toContain('hunter2');
    expect(result).toContain('"tokenSet":true');
  });
});
