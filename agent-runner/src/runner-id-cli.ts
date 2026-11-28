/**
 * Runner 식별자(runnerId) 확인 명령(M8-06).
 *   pnpm -C agent-runner runner-id
 *
 * 하는 일: `AWBS_HOME/state/runner.json`의 runnerId를 표준 출력에 한 줄로 낸다.
 * - 상태 파일이 없으면 Runner가 처음 시작할 때와 똑같이 상태를 만든다(State.open). 그래서 이 값은 나중에 Runner가 쓰는 값과 같다.
 * - 있는 상태 파일의 runnerId는 바꾸지 않는다. Runner 시작과 같은 열기 절차만 거친다.
 * - Runner가 켜져 있으면 데이터 폴더 잠금 때문에 멈춘다(종료 코드 3). Runner를 끈 뒤 다시 실행한다.
 * 왜: Runner 토큰은 이 식별자 하나에 묶인다. 다른 이름으로 발급하면 서버가 `FORBIDDEN_PRINCIPAL`(403)로 거부한다.
 * 토큰이 필요 없다. 비밀값을 읽거나 출력하지 않는다.
 */
import { isAbsolute } from 'node:path';
import { resolveHome } from './config.ts';
import { State, StateLockError } from './state/state.ts';

const home = resolveHome(process.env);
if (!isAbsolute(home)) {
  process.stderr.write('AWBS_HOME은 절대 경로여야 합니다.\n');
  process.exit(2);
}
try {
  const state = await State.open(home);
  try {
    process.stdout.write(`${state.snapshot.runnerId}\n`);
  } finally {
    await state.close();
  }
  process.stderr.write(`데이터 폴더: ${home}\n`);
} catch (error) {
  if (error instanceof StateLockError) {
    process.stderr.write(`${error.message} Runner를 멈춘 뒤 다시 실행하세요(systemctl --user stop awbs-runner.service).\n`);
    process.exit(3);
  }
  process.stderr.write(`상태를 열지 못했습니다: ${(error as Error).message}\n`);
  process.exit(1);
}
