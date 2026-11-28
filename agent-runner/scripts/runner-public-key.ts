import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { generateRunnerKeyPair } from '../src/github/credential.ts';
import { State } from '../src/state/state.ts';

/** 최초 CLI 승인의 공개키와 Runner ID를 만든다. 개인키는 메모리 밖으로 내보내지 않는다. */
const home = process.env.AWBS_HOME || join(homedir(), '.agentwbs');
try {
  const path = process.argv[2];
  if (!path || !isAbsolute(path) || !isAbsolute(home)) throw new Error();
  const state = await State.open(home);
  try {
    await writeFile(path, generateRunnerKeyPair().publicKey, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${state.snapshot.runnerId}\n`);
  } finally { await state.close(); }
} catch {
  process.stderr.write('공개키 생성 실패: Runner를 중지하고, 아직 없는 공개키 파일의 절대 경로와 AWBS_HOME을 확인하세요.\n');
  process.exitCode = 1;
}
