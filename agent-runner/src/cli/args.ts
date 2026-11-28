import { isAbsolute } from 'node:path';
import type { Agent } from '../api/generated/client.ts';
import { cliArguments } from '../cli-update/registry.ts';
import { sessionEnv } from './env.ts';
import { PENDING_ISOLATION, type IsolationLayer, type Launch } from './isolation.ts';

export type { Launch } from './isolation.ts';

/** 세션 1회의 실행 요청. 모델·Effort는 서버 `run-grade` 응답 값(CLI 값) 그대로다. */
export interface RunSpec {
  model: string;
  /** CLI Effort 값(예: `high`). 공통 단계 숫자가 아니다. */
  effort: string;
  /** 세션 worktree. 절대 경로. */
  cwd: string;
  prompt: string;
  /** 이어서 실행할 세션 ID(Claude session_id, Codex thread_id). */
  resume?: string;
  /**
   * 이 모델에 대해 Runner가 보고한 CLI Effort 값(`/runner/models`의 `efforts`).
   * 주면 그 안에 있는지도 확인한다. null은 「미확인」이라 쓰지 않는다(owner Q-06).
   */
  modelEfforts?: readonly string[] | null;
  /** 횟수 제한 검증에서는 CLI가 별도 유료 하위 세션을 열지 못하게 한다. */
  noSubagents?: boolean;
  readOnly?: boolean;
}

export type CliArgumentCode = 'effort_unmapped' | 'effort_unsupported' | 'effort_unconfirmed' | 'model_invalid' | 'resume_invalid' | 'cwd_invalid' | 'prompt_empty';

export class CliArgumentError extends Error {
  readonly code: CliArgumentCode;
  constructor(code: CliArgumentCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * owner Q-06 규칙: low~max만 공통 1~5로 매핑된다. 다른 이름(`ultra` 등)은 미매핑이라 쓰지 않는다.
 * 모델별 매핑표는 서버가 가진다(run-grade가 이미 판정). Runner는 마지막 방어로 이름만 다시 확인한다.
 */
export const APPROVED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// 첫 글자를 영숫자로 묶어 `--옵션`처럼 해석될 값을 막는다.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** hook을 쓰지 않는다(G §6.7 확정). Claude는 한 번의 실행에서 프로젝트·사용자 설정의 hook보다 우선하는 `--settings`로 끈다. */
const CLAUDE_FIXED = ['-p', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}'];
/** Codex는 `hooks` 기능을 끈다(`--disable hooks` = `-c features.hooks=false`). */
const CODEX_FIXED = ['--json', '--disable', 'hooks'];

function validate(spec: RunSpec): void {
  if (!(APPROVED_EFFORTS as readonly string[]).includes(spec.effort)) {
    throw new CliArgumentError('effort_unmapped', `승인되지 않은 Effort 값입니다(owner Q-06: ${APPROVED_EFFORTS.join('·')}만 사용).`);
  }
  if (spec.modelEfforts === null) throw new CliArgumentError('effort_unconfirmed', '이 모델의 Effort 지원이 미확인이라 쓰지 않습니다(owner Q-06).');
  if (spec.modelEfforts && !spec.modelEfforts.includes(spec.effort)) {
    throw new CliArgumentError('effort_unsupported', '이 모델이 보고한 Effort 값에 없는 단계입니다.');
  }
  if (!MODEL.test(spec.model)) throw new CliArgumentError('model_invalid', '모델 ID 형식이 아닙니다.');
  if (spec.resume !== undefined && !SESSION.test(spec.resume)) throw new CliArgumentError('resume_invalid', '재개할 세션 ID 형식이 아닙니다.');
  if (!isAbsolute(spec.cwd)) throw new CliArgumentError('cwd_invalid', '작업 폴더는 절대 경로여야 합니다.');
  if (spec.prompt.trim() === '') throw new CliArgumentError('prompt_empty', '지시문이 비어 있습니다.');
}

function agentArgs(agent: Agent, spec: RunSpec, isolation: IsolationLayer): string[] {
  const iso = [...isolation.flags(agent)];
  if (agent === 'Claude') {
    return [...CLAUDE_FIXED, ...iso, ...(spec.noSubagents ? ['--disallowedTools', 'Agent,Task'] : []), ...(spec.readOnly ? ['--tools', 'Read,Glob,Grep'] : []), '--model', spec.model, '--effort', spec.effort, ...(spec.resume ? ['--resume', spec.resume] : [])];
  }
  // `exec resume`에는 -C·--sandbox가 없다. 그래서 작업 폴더는 프로세스 cwd로, sandbox는 격리 계층의 `-c` 설정으로 넘긴다.
  // 지시문은 `-`로 표준 입력에서 읽게 한다.
  return [
    'exec', ...(spec.resume ? ['resume'] : []), ...CODEX_FIXED, ...iso,
    ...(spec.noSubagents ? ['-c', 'features.multi_agent=false'] : []), ...(spec.readOnly ? ['-c', 'sandbox_mode="read-only"'] : []),
    '--model', spec.model, '-c', `model_reasoning_effort="${spec.effort}"`,
    ...(spec.resume ? [spec.resume] : []), '-',
  ];
}

/**
 * Claude `-p --output-format stream-json` / Codex `exec --json` 실행 계획을 만든다.
 * CLI 업데이트 끔 인자(`cliArguments`)와 세션 env allowlist를 준비 점검과 같은 출처에서 쓴다.
 */
export function buildLaunch(
  agent: Agent,
  binary: string,
  spec: RunSpec,
  { env, isolation = PENDING_ISOLATION }: { env: NodeJS.ProcessEnv; isolation?: IsolationLayer },
): Launch {
  validate(spec);
  const launch: Launch = {
    file: binary,
    args: [...cliArguments(agent, agentArgs(agent, spec, isolation))],
    env: sessionEnv(agent, env),
    cwd: spec.cwd,
    stdin: spec.prompt,
  };
  return isolation.wrap(launch, agent);
}

/** 실행 종류. 새 실행과 재개는 다른 관측 등급 조합이다(G §6.7은 재개를 따로 검증할 항목으로 둔다). */
export type RunKind = 'new' | 'resume';

/**
 * 관측 등급 조합(CLI·버전·모델·**옵션**)의 옵션 문자열. readiness `cliProfiles`와 서버 `cliGrades`에 이 값을 쓴다.
 * - 모델·Effort·지시문·세션 ID처럼 실행마다 바뀌는 값은 넣지 않는다.
 * - 실행 종류(`kind`)는 넣는다. 새 실행만 검증된 조합에 재개가 검증됨으로 붙지 않게 하기 위해서다(리뷰 4).
 *   예: Codex 새 실행 `exec --json …`, 재개 `exec resume --json …`. Claude 재개는 끝에 `--resume`.
 * - 격리 옵션이 바뀌면 조합도 바뀐다(G §6.7 검증 조건).
 */
export function sessionOptions(agent: Agent, isolation: IsolationLayer, kind: RunKind, noSubagents = false): string {
  const iso = isolation.flags(agent);
  const words = agent === 'Claude'
    ? [...CLAUDE_FIXED, ...iso, ...(kind === 'resume' ? ['--resume'] : [])]
    : ['exec', ...(kind === 'resume' ? ['resume'] : []), ...CODEX_FIXED, ...iso];
  if (noSubagents) words.push(...(agent === 'Claude' ? ['--disallowedTools', 'Agent,Task'] : ['-c', 'features.multi_agent=false']));
  return words.join(' ');
}
