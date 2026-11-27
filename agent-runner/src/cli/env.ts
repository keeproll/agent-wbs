import type { Agent } from '../api/generated/client.ts';
import { cliEnvironment } from '../cli-update/registry.ts';

/** 각 CLI가 설정·로그인 정보를 찾는 폴더 변수. 다른 CLI의 폴더는 넘기지 않는다. */
const OWN_HOME = { Codex: 'CODEX_HOME', Claude: 'CLAUDE_CONFIG_DIR' } as const satisfies Record<Agent, string>;

/**
 * Agent 세션에 넘기는 환경 변수. 준비 점검·CLI 업데이트와 같은 allowlist(`cliEnvironment`)를 단일 출처로 쓴다.
 * - 허용 목록에 있는 이름만 넘기므로 Runner·GitHub 토큰, SSH agent, `AWBS_*`, API 키는 남지 않는다(architecture §4, G §9.5-4-1).
 * - CLI 자체 자동 업데이트는 끈다. 버전은 Runner만 바꾼다(architecture §5.1).
 * - 다른 CLI의 설정 폴더는 빼서, 한 Agent가 다른 Agent의 로그인 정보를 보지 않게 한다.
 * 로그인 정보를 어디까지 나눌지(전용 사용자·컨테이너)는 Q-08 결정에 따라 격리 계층이 정한다.
 */
export function sessionEnv(agent: Agent, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const others = new Set<string>(Object.entries(OWN_HOME).filter(([other]) => other !== agent).map(([, name]) => name));
  return Object.fromEntries(Object.entries(cliEnvironment(env)).filter(([name]) => !others.has(name)));
}
