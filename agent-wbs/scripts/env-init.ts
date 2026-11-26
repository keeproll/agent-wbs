// install 전에도 실행할 수 있도록 Node 내장 모듈만 쓴다.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const passwordFile = join(process.env.AWBS_HOME ?? join(homedir(), '.agentwbs'), 'wbs', 'dev-db-password');

function createOnce(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

// 볼륨은 PC에 하나뿐이므로 비밀번호도 worktree가 아니라 PC 단위로 보관한다.
mkdirSync(dirname(passwordFile), { recursive: true, mode: 0o700 });
createOnce(passwordFile, `${randomBytes(24).toString('hex')}\n`);
const password = readFileSync(passwordFile, 'utf8').trim();
if (!/^[A-Za-z0-9_-]+$/.test(password)) {
  throw new Error(`${passwordFile}은 영문·숫자·_·-만 포함해야 합니다.`);
}
// 같은 DB를 쓰는 worktree들은 같은 암호화 키를 써야 이미 저장한 토큰을 열 수 있다.
const secretFile = join(dirname(passwordFile), 'secret-key');
createOnce(secretFile, `${randomBytes(32).toString('hex')}\n`);
const secretKey = readFileSync(secretFile, 'utf8').trim();
if (!/^[a-fA-F0-9]{64}$/.test(secretKey)) throw new Error(`${secretFile}은 32바이트의 16진수 값이어야 합니다.`);

const repo = dirname(root);
const name = basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
const slug = `${name}_${createHash('sha256').update(repo).digest('hex').slice(0, 6)}`;

const env = readFileSync(join(root, '.env.example'), 'utf8')
  .replaceAll('CHANGE_ME', password)
  .replace('CHANGE_SECRET_KEY', secretKey)
  .replace('CHANGE_SLUG', slug);

console.log(
  createOnce(join(root, '.env'), env)
    ? `.env를 만들었습니다 (테스트 DB: awbs_test_${slug}).`
    : '.env가 이미 있어 바꾸지 않았습니다.',
);
