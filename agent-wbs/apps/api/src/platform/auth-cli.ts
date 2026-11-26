import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createPool } from '@awbs/db';
import { loadConfig } from '../config.ts';
import { issueLoginLink, issueRunnerToken, setPassword, revokeRunnerToken } from './credentials.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl, { onError: () => undefined });
try {
  const [command, runnerId, publicKeyPath] = process.argv.slice(2);
  switch (command) {
    case 'login-link': {
      const token = await issueLoginLink(pool);
      // fragment는 HTTP 요청과 서버 접근 로그로 전송되지 않는다. M3 화면이 읽고 즉시 지운다.
      process.stdout.write(`${config.origin}/#login-token=${token}\n`);
      break;
    }
    case 'set-password': {
      // 비밀번호가 프로세스 인수·명령 이력에 남지 않게 표준 입력으로만 받는다.
      const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      await setPassword(pool, password);
      process.stdout.write('LAN 비밀번호를 설정했습니다.\n');
      break;
    }
    case 'runner-token': {
      if (!runnerId || !publicKeyPath) throw new Error('Runner ID와 공개키 파일 경로가 필요합니다.');
      process.stdout.write(`${await issueRunnerToken(pool, runnerId, await readFile(publicKeyPath, 'utf8'))}\n`);
      break;
    }
    case 'revoke-runner': {
      const token = readFileSync(0, 'utf8').trim();
      await revokeRunnerToken(pool, token);
      process.stdout.write('Runner 토큰을 폐기했습니다.\n');
      break;
    }
    default: throw new Error('명령: login-link | set-password(표준 입력) | runner-token <ID> <공개키 파일> | revoke-runner(표준 입력)');
  }
} catch {
  process.stderr.write('인증 설정 실패: 명령·입력·DB 연결 상태를 확인하세요.\n');
  process.exitCode = 1;
} finally { await pool.end(); }
