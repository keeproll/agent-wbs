import { expect, test, vi } from 'vitest';
import { assertTestDatabaseUrl, parseDatabaseUrl, recreateTestDatabase } from '../src/index.ts';

// 보호 조건이 깨져도 실제 DB에 닿지 않도록 비어 있는 포트를 쓴다.
const base = 'postgres://u:secret@127.0.0.1:1';

test('awbs_test_ DB는 허용한다', () => {
  expect(assertTestDatabaseUrl(`${base}/awbs_test_m0_abc123`)).toBe('awbs_test_m0_abc123');
});

test.each([
  ['개발 DB', `${base}/awbs_dev`],
  ['관리 DB', `${base}/postgres`],
  ['접두어만', `${base}/awbs_test_`],
  ['접두어가 중간', `${base}/x_awbs_test_a`],
  ['인코딩 우회', `${base}/awbs_test_a%2Fb`],
  ['하위 경로', `${base}/awbs_test_a/awbs_dev`],
  ['대문자', `${base}/AWBS_TEST_a`],
  ['접속 대상 덮어쓰기', `${base}/awbs_test_a?host=db.example`],
  ['원격 호스트', 'postgres://u:secret@db.example/awbs_test_a'],
  ['호스트 없음', 'postgres:///awbs_test_a'],
  ['빈 값', ''],
  ['URL 아님', 'awbs_test_a'],
])('%s은 거부하고 비밀번호를 노출하지 않는다: %s', async (_label, url) => {
  expect(() => assertTestDatabaseUrl(url)).toThrow();
  await expect(recreateTestDatabase(url)).rejects.not.toThrow(/secret/);
});

test('거부할 때는 DB에 접속하지 않는다', async () => {
  const { default: pg } = await import('pg');
  const connect = vi.spyOn(pg.Client.prototype, 'connect');
  await expect(recreateTestDatabase(`${base}/awbs_dev`)).rejects.toThrow('awbs_test_');
  expect(connect).not.toHaveBeenCalled();
});

test('잘못된 DATABASE_URL 오류에 비밀번호가 없다', () => {
  expect(() => parseDatabaseUrl('postgres://u:secret@host:notaport/db')).toThrow(
    expect.not.objectContaining({ message: expect.stringContaining('secret') as string }),
  );
});
