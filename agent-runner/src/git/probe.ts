import type { ReadinessItem } from '../readiness/checks.ts';
import type { RunCommand } from '../readiness/command.ts';

type Check = Omit<ReadinessItem, 'key'>;

/**
 * 준비 점검 `repo`(작업 저장소 접근) 항목. M4-03 git 안전 계층이 기대는 운영체제 기능을 확인한다(M4-03 최종 확인 §3 연결 조건).
 *
 * - `/proc`: 작업 폴더 잠금의 주인 기록(`/proc/<pid>/stat`의 시작 값)과 부팅 번호(`/proc/sys/kernel/random/boot_id`)에 쓴다.
 *   없으면 작업 폴더를 만들거나 지울 수 없으므로 fail이다.
 * - `flock`(util-linux): 강제 종료로 남은 잠금을 자동 회수할 때 쓴다.
 *   없으면 회수만 실패하고 잠금은 보존되므로(실행은 가능) warn이다.
 */
export async function checkGitHost(run: RunCommand, readFile: (path: string) => Promise<string>): Promise<Check> {
  let proc: boolean;
  try {
    const boot = (await readFile('/proc/sys/kernel/random/boot_id')).trim();
    const stat = await readFile('/proc/self/stat');
    proc = boot !== '' && stat.includes(')');
  } catch {
    proc = false;
  }
  if (!proc) {
    return { status: 'fail', detail: '/proc를 읽을 수 없어 작업 폴더 잠금을 확인할 수 없음', fix: 'Linux(WSL2)의 /proc가 마운트된 환경에서 Runner를 실행하세요.' };
  }
  const r = await run('flock', ['--version']);
  const version = r.code === 0 ? /(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout)?.[1] : undefined;
  if (!version) {
    return { status: 'warn', detail: '/proc 확인됨 · flock 없음 — 강제 종료로 남은 잠금을 자동 회수하지 못함(잠금은 보존)', fix: 'util-linux 패키지(flock)를 설치하세요.' };
  }
  return { status: 'ok', detail: `/proc 확인됨 · flock ${version}` };
}
