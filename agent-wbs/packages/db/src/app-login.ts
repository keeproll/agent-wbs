/**
 * 운영 앱 전용 DB 로그인(M8-06).
 *
 * 왜 따로 두나: 운영 API·worker가 관리자(superuser)로 접속하면 DB 제약과 보고서 이력 보호 장치를 끄고 지나갈 수 있다(data-model §6.1).
 * 그래서 마이그레이션·관리 작업은 관리자 로그인으로, 앱 실행은 `awbs_app` 권한만 물려받는 별도 로그인으로 한다.
 * - 로그인 역할 `awbs_app_login`은 `awbs_app`의 권한을 물려받기만 하고(INHERIT TRUE), `SET ROLE awbs_app`은 못 한다(SET FALSE).
 * - 관리자 접속 뒤 `SET ROLE`로 권한을 낮추는 방식은 쓰지 않는다. 같은 연결에서 `RESET ROLE`로 되돌릴 수 있기 때문이다.
 * - 비밀번호는 운영 비밀 파일(db-app-password)에서만 온다. 이 모듈은 비밀번호를 출력하지 않는다.
 */
import type pg from 'pg';

export const APP_LOGIN = 'awbs_app_login';
/** 보고서 이력과 커밋 시각 기록. 앱이 지우거나 비울 수 있으면 안 된다. */
export const HISTORY_TABLES = ['state_log', 'global_log', 'commit_log', 'commit_real'] as const;

export function assertAppPassword(password: string | undefined): string {
  if (!password || !/^[A-Za-z0-9_-]{24,}$/.test(password)) {
    throw new Error('앱 DB 비밀번호는 영문·숫자·_·- 24자 이상이어야 합니다(db-app-password).');
  }
  return password;
}

/** 관리자 연결로 앱 로그인을 만들거나 맞춘다. 여러 번 실행해도 결과가 같다. */
export async function ensureAppLogin(client: pg.ClientBase, password: string): Promise<void> {
  assertAppPassword(password);
  const role = client.escapeIdentifier(APP_LOGIN);
  const attributes = `LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`;
  await client.query('begin');
  try {
    const exists = (await client.query('select 1 from pg_catalog.pg_roles where rolname=$1', [APP_LOGIN])).rowCount;
    await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} ${attributes}`);
    // awbs_app 말고 다른 역할의 권한을 물려받지 않게 한다(예전에 실수로 준 관리자 역할 등).
    const parents = await client.query<{ name: string }>(
      `select r.rolname as name from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid
       where m.member=(select oid from pg_catalog.pg_roles where rolname=$1) and r.rolname<>'awbs_app'`, [APP_LOGIN]);
    for (const parent of parents.rows) await client.query(`REVOKE ${client.escapeIdentifier(parent.name)} FROM ${role}`);
    await client.query(`GRANT awbs_app TO ${role} WITH INHERIT TRUE, SET FALSE`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export interface AppLoginCheck {
  currentUser: string;
  superuser: boolean;
  /** 이력 표에 DELETE·TRUNCATE 권한이 하나라도 있는 표 */
  historyWritable: string[];
  /** 실제로 이력 행 삭제를 시도했을 때 권한 오류(42501)로 막혔는가 */
  historyDeleteBlocked: boolean;
  /** SET ROLE awbs_app / awbs_owner가 막혔는가 */
  setRoleBlocked: boolean;
  /** 이력 표의 트리거 끄기가 막혔는가 */
  disableTriggerBlocked: boolean;
}

async function blocked(client: pg.ClientBase, sql: string): Promise<boolean> {
  await client.query('begin');
  try {
    await client.query(sql);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === '42501';
  } finally {
    await client.query('rollback');
  }
}

/** 앱 연결이 정말로 제한된 권한인지 확인한다. 바꾸는 시도는 모두 되돌린다. */
export async function checkAppLogin(client: pg.ClientBase): Promise<AppLoginCheck> {
  const me = (await client.query<{ name: string; superuser: boolean }>(
    'select current_user as name, r.rolsuper as superuser from pg_catalog.pg_roles r where r.rolname=current_user')).rows[0];
  if (!me) throw new Error('현재 DB 사용자를 찾지 못했습니다.');
  const historyWritable: string[] = [];
  for (const table of HISTORY_TABLES) {
    const row = (await client.query<{ w: boolean }>(
      `select has_table_privilege(current_user, $1, 'DELETE') or has_table_privilege(current_user, $1, 'TRUNCATE') as w`, [`public.${table}`])).rows[0];
    if (row?.w) historyWritable.push(table);
  }
  return {
    currentUser: me.name,
    superuser: me.superuser,
    historyWritable,
    historyDeleteBlocked: await blocked(client, 'delete from public.state_log'),
    setRoleBlocked: await blocked(client, 'set role awbs_app') && await blocked(client, 'set role awbs_owner'),
    disableTriggerBlocked: await blocked(client, 'alter table public.state_log disable trigger all'),
  };
}

export function appLoginSafe(check: AppLoginCheck): boolean {
  return check.currentUser === APP_LOGIN && !check.superuser && check.historyWritable.length === 0
    && check.historyDeleteBlocked && check.setRoleBlocked && check.disableTriggerBlocked;
}
