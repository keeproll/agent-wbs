import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { APP_LOGIN, appLoginSafe, assertAppPassword, checkAppLogin, ensureAppLogin } from '../src/app-login.ts';
import { createPool, recreateTestDatabase, seedSystem } from '../src/index.ts';

// M8-06: 운영 앱은 관리자(superuser)가 아니라 awbs_app 권한만 물려받는 로그인으로 접속한다.
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_applogin';
const url = dbUrl.href;
const pool = createPool(url, { max: 2, onError: () => undefined });
const password = randomBytes(18).toString('hex');

async function asApp<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const appUrl = new URL(url);
  appUrl.username = APP_LOGIN;
  appUrl.password = password;
  const client = new pg.Client({ connectionString: appUrl.href });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

beforeAll(async () => {
  await recreateTestDatabase(url);
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  await seedSystem(pool);
});
afterAll(async () => {
  await pool.query(`drop role if exists ${APP_LOGIN}`);
  await pool.end();
});

test('비밀번호 형식: 짧거나 특수문자가 있으면 거부', () => {
  expect(() => assertAppPassword('short')).toThrow();
  expect(() => assertAppPassword(`${'a'.repeat(30)}'`)).toThrow();
  expect(assertAppPassword(password)).toBe(password);
});

test('ensure로 만든 앱 로그인은 관리자가 아니고 이력을 지우거나 보호 장치를 끌 수 없다', async () => {
  const client = await pool.connect();
  try { await ensureAppLogin(client, password); await ensureAppLogin(client, password); } finally { client.release(); }
  const check = await asApp(checkAppLogin);
  expect(check).toEqual({
    currentUser: APP_LOGIN, superuser: false, historyWritable: [],
    historyDeleteBlocked: true, setRoleBlocked: true, disableTriggerBlocked: true, membershipSafe: true,
  });
  expect(appLoginSafe(check)).toBe(true);
  // 앱이 하는 일(awbs_app 권한)은 그대로 된다: 읽기와 보고서 기준점 함수.
  await asApp(async (c) => {
    expect((await c.query('select count(*)::int as n from public.app_settings')).rows[0]).toEqual({ n: 1 });
    await c.query('select public.awbs_report_anchor()');
  });
});

test('ADMIN 옵션이 남아 있으면 앱이 스스로 SET을 켤 수 있다 — 검사가 잡고 ensure가 고친다', async () => {
  await pool.query(`grant awbs_app to ${APP_LOGIN} with admin true, inherit true, set false`);
  const before = await asApp(checkAppLogin);
  expect(before.membershipSafe).toBe(false);
  expect(appLoginSafe(before)).toBe(false);
  // 리뷰 재현: ADMIN이 남으면 앱 로그인이 자기 멤버십의 SET을 켜고 SET ROLE에 성공한다.
  await asApp(async (c) => {
    await c.query(`grant awbs_app to ${APP_LOGIN} with set true`);
    await c.query('set role awbs_app');
  });
  const client = await pool.connect();
  try { await ensureAppLogin(client, password); } finally { client.release(); }
  const options = await pool.query<{ admin_option: boolean; inherit_option: boolean; set_option: boolean }>(
    `select m.admin_option, m.inherit_option, m.set_option from pg_auth_members m
     where m.member=(select oid from pg_roles where rolname=$1) and m.roleid=(select oid from pg_roles where rolname='awbs_app')`, [APP_LOGIN]);
  expect(options.rows).toEqual([{ admin_option: false, inherit_option: true, set_option: false }]);
  expect(appLoginSafe(await asApp(checkAppLogin))).toBe(true);
  await asApp(async (c) => {
    await expect(c.query(`grant awbs_app to ${APP_LOGIN} with set true`)).rejects.toMatchObject({ code: '42501' });
  });
});

test('ensure는 실수로 준 다른 역할을 회수하고 SET ROLE 불가를 되살린다', async () => {
  await pool.query(`grant awbs_data_owner to ${APP_LOGIN}`);
  await pool.query(`grant awbs_app to ${APP_LOGIN} with set true`);
  expect(appLoginSafe(await asApp(checkAppLogin))).toBe(false);
  const client = await pool.connect();
  try { await ensureAppLogin(client, password); } finally { client.release(); }
  const parents = await pool.query<{ rolname: string; admin_option: boolean; inherit_option: boolean; set_option: boolean }>(
    `select r.rolname, m.admin_option, m.inherit_option, m.set_option from pg_auth_members m join pg_roles r on r.oid=m.roleid
     where m.member=(select oid from pg_roles where rolname=$1)`, [APP_LOGIN]);
  expect(parents.rows).toEqual([{ rolname: 'awbs_app', admin_option: false, inherit_option: true, set_option: false }]);
  expect(appLoginSafe(await asApp(checkAppLogin))).toBe(true);
});
