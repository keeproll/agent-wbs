import type { Launch } from '../cli/isolation.ts';

/**
 * ①·CI 검사 명령(main pipeline.yaml의 argv) 하나의 실행 계획(조정자 결정 1).
 * - 명령·인자는 배열 그대로다. shell 문자열을 만들지 않는다.
 * - 환경 변수는 `CI=1`과 언어·시간대만 넣는다. Runner의 토큰·HOME·PATH는 넣지 않는다.
 *   전용 계정 계층은 이 중 허용 목록(`CI_ENV_NAMES`)만 래퍼 ci-run에 넘기고, 래퍼가 Agent 계정 환경을 새로 만든다.
 * - 실제 실행은 `Execution.command`가 격리 계층의 `command`로 감싸 Agent 계정·사용자 scope에서 한다.
 */
export function ciLaunch(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Launch {
  const [file, ...args] = argv;
  if (!file) throw new Error('검사 명령이 비었습니다.');
  return {
    file, args, cwd, stdin: '',
    env: { CI: '1', ...(env.LANG && { LANG: env.LANG }), ...(env.LC_ALL && { LC_ALL: env.LC_ALL }), ...(env.TZ && { TZ: env.TZ }) },
  };
}
