import type { Agent } from '../api/generated/client.ts';

/** CLI 1회 실행 계획. 실행(프로세스 그룹·강제 종료)은 exec 계층(M5-02)이 한다. */
export interface Launch {
  file: string;
  /** 명령과 인자를 배열로 따로 넘긴다. shell 문자열을 만들지 않는다(architecture §4 「명령 실행」). */
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** 지시문. 인자 대신 표준 입력으로 넘겨 프로세스 목록(ps)에 드러나지 않고 길이 제한도 피한다. */
  stdin: string;
}

/**
 * 실행 격리 계층(Q-08). owner 결정 전이라 갈아끼울 수 있는 경계로만 둔다.
 * - `flags`: CLI 자체 sandbox·권한 모드 옵션(예: Codex `sandbox_mode`, Claude `--permission-mode`).
 *   관측 등급 조합의 「옵션」에 들어간다(`sessionOptions`).
 * - `wrap`: 완성된 실행 계획을 감싼다(예: 전용 OS 사용자로 실행, 세션별 컨테이너 안에서 실행).
 * 왜 둘로 나누나: 선택지 A(같은 사용자 + CLI sandbox)는 옵션만, B·C(전용 사용자·컨테이너)는 실행 방법 자체를 바꾸기 때문이다.
 */
export interface IsolationLayer {
  readonly name: string;
  flags(agent: Agent): readonly string[];
  wrap(launch: Launch, agent: Agent): Launch;
}

export class IsolationUndecidedError extends Error {
  readonly code = 'isolation_undecided';
  constructor() {
    super('실행 격리 수준(Q-08)이 정해지지 않아 실제 실행 계획을 만들지 않습니다. 시험은 fake 격리 계층을 넘기세요.');
  }
}

/** 기본값. Q-08 결정 전에는 실제 실행을 만들지 않는다(architecture §4 「실행 격리」: 확정 전에는 fake 실행만). */
export const PENDING_ISOLATION: IsolationLayer = {
  name: 'pending-q08',
  flags: () => [],
  wrap: () => {
    throw new IsolationUndecidedError();
  },
};
