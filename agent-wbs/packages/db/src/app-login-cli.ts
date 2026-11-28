/**
 * 운영 앱 DB 로그인 명령(M8-06). 운영 이미지 진입점(deploy/app-entrypoint.sh)이 부른다.
 *   ensure: 관리자 연결(DATABASE_URL)로 awbs_app_login을 만들거나 맞춘다. 비밀번호는 AWBS_APP_DB_PASSWORD.
 *   check:  앱 연결(DATABASE_URL)의 권한을 확인해 JSON 한 줄로 낸다. 안전하지 않으면 종료 코드 1.
 * 비밀번호·접속 주소는 출력하지 않는다.
 */
import pg from 'pg';
import { appLoginSafe, checkAppLogin, ensureAppLogin } from './app-login.ts';
import { parseDatabaseUrl } from './pool.ts';

const mode = process.argv[2];
if (mode !== 'ensure' && mode !== 'check') throw new Error('사용법: app-login-cli ensure | check');
const client = new pg.Client({ connectionString: parseDatabaseUrl(process.env.DATABASE_URL) });
await client.connect();
try {
  if (mode === 'ensure') {
    await ensureAppLogin(client, process.env.AWBS_APP_DB_PASSWORD ?? '');
    console.log('앱 DB 로그인(awbs_app_login) 준비 완료');
  } else {
    const check = await checkAppLogin(client);
    console.log(JSON.stringify(check));
    if (!appLoginSafe(check)) process.exitCode = 1;
  }
} finally {
  await client.end();
}
