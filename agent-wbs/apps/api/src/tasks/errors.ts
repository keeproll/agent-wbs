import { errorBody } from '@awbs/shared';
import { ERROR_STATUS, type ErrorCode, type InputError } from '@awbs/shared/api';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import { validationErrors } from '../platform/errors.ts';
import { redact } from '../platform/redact.ts';

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: '입력이 올바르지 않습니다.',
  TASK_NOT_FOUND: 'Task를 찾을 수 없습니다.',
  PROJECT_NOT_FOUND: '프로젝트를 찾을 수 없습니다.',
  WBS_NODE_NOT_FOUND: 'Task를 둘 Work Package를 찾을 수 없습니다.',
  DEPENDENCY_NOT_FOUND: '선행 관계를 찾을 수 없습니다.',
  NOT_FOUND: '요청한 항목을 찾을 수 없습니다.',
  VERSION_CONFLICT: '다른 곳에서 먼저 바뀌어 화면의 내용이 최신이 아닙니다.',
  DEPENDENCY_SELF: '자기 자신을 선행 Task로 지정할 수 없습니다.',
  DEPENDENCY_DUPLICATE: '이미 등록된 선행 관계입니다.',
  DEPENDENCY_CYCLE: '이 선행 관계를 추가하면 순환 의존성이 생깁니다.',
  TASK_HAS_SUCCESSORS: '후속 Task가 있어 삭제할 수 없습니다.',
  INVALID_TRANSITION: '현재 상태에서는 할 수 없는 요청입니다.',
  ACTIVE_TASK_BLOCKED: '진행 중인 Task가 새로 차단되므로 선행 관계를 추가할 수 없습니다.',
  SPLIT_JUDGEMENT_REQUIRED: '분할 기준 판단(규칙 5·7·9)이 유효한 충족이 아니라 착수 승인을 보류합니다.',
};
const FIXES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: '표시된 항목을 고친 뒤 다시 저장하세요.',
  VERSION_CONFLICT: '최신 내용을 다시 불러와 변경 사항을 확인한 뒤 다시 저장하세요.',
  DEPENDENCY_CYCLE: '순환 경로의 관계 중 하나를 빼거나 다른 선행 Task를 고르세요.',
  TASK_HAS_SUCCESSORS: '후속 Task의 선행 관계를 먼저 삭제하세요.',
  ACTIVE_TASK_BLOCKED: '이미 충족된 선행만 추가하거나 변경 제안(CP)으로 처리하세요.',
  SPLIT_JUDGEMENT_REQUIRED: 'Planning에서 규칙 5·7·9 판단을 다시 받은 뒤 승인하세요.',
  INVALID_TRANSITION: 'Task의 현재 상태를 다시 불러와 확인하세요.',
};

/** Task 업무 오류. 공통 오류 형식에 입력 오류 목록(`errors[]`)과 동작 이름을 함께 싣는다. */
export class TaskError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly errors: InputError[];
  constructor(code: ErrorCode, details: Record<string, unknown> = {}, errors: InputError[] = [], message?: string) {
    super(message ?? MESSAGES[code] ?? '요청을 처리할 수 없습니다.');
    this.code = code;
    this.details = details;
    this.errors = errors;
  }
}

/**
 * 이 범위(Task 라우트)의 오류 처리. Task 오류와 형식 검증 오류만 직접 답하고,
 * 그 밖의 오류(인증·세대·멱등·DB)는 공통 처리기(platform)로 넘긴다.
 */
export function installTaskErrors(scope: FastifyInstance, actions: ReadonlyMap<string, string>): void {
  scope.setErrorHandler((error, request, reply) => {
    const action = actions.get(`${request.method} ${request.routeOptions.url ?? ''}`) ?? 'Task 처리';
    const failure = error as { validation?: FastifySchemaValidationError[] };
    if (!(error instanceof TaskError) && !failure.validation) throw error;
    // 형식 오류의 항목 변환은 공통 규칙(platform)을 그대로 쓰고, 동작 이름·조치 안내만 Task 것으로 붙인다.
    const task = error instanceof TaskError ? error : new TaskError('VALIDATION_FAILED', {}, validationErrors(failure.validation ?? []));
    return reply.code(ERROR_STATUS[task.code]).send(errorBody({
      code: task.code, message: task.message, action, fix: FIXES[task.code] ?? '입력과 현재 상태를 확인한 뒤 다시 시도하세요.',
      errors: task.errors, details: redact(task.details) as Record<string, unknown>, requestId: request.id,
    }));
  });
}
