import { errorBody } from '@awbs/shared';
import { ERROR_STATUS, type ErrorCode } from '@awbs/shared/api';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import { validationErrors } from '../platform/errors.ts';
import { redact, redactText } from '../platform/redact.ts';
import { JcsError } from './hash.ts';

/** 400 `errors[]` 한 줄. path는 본문 안의 위치(예: `tasks.0.wpRef`)다. */
export interface InputError { path: string; rule: string; message: string }

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: '입력이 올바르지 않습니다.',
  NOT_FOUND: '요청한 항목을 찾을 수 없습니다.',
  PROJECT_NOT_FOUND: '등록된 프로젝트가 없습니다.',
  PROJECT_EXISTS: '이미 등록된 프로젝트가 있습니다. 프로젝트는 하나만 등록합니다.',
  CLEANUP_PENDING: '초기화 뒤 Runner 정리가 아직 끝나지 않았습니다.',
  INVALID_TRANSITION: '현재 단계에서는 할 수 없는 요청입니다.',
  VERSION_CONFLICT: '다른 곳에서 먼저 바뀌어 화면의 내용이 최신이 아닙니다.',
  DECISIONS_PENDING: '아직 승인·반려하지 않은 기술 결정이 있습니다.',
  SPLIT_JUDGEMENT_REQUIRED: '분할 기준 판단(규칙 5·7·9)이 유효한 충족이 아닌 Task가 있어 초기 WBS 승인을 보류합니다.',
  INPUT_UNCHANGED: '이미 입력 버전으로 고정한 커밋입니다.',
  LEASE_LOST: '작업 임대가 끝났거나 다른 Runner로 넘어갔습니다.',
};
const FIXES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: '표시된 항목을 고친 뒤 다시 보내세요.',
  PROJECT_EXISTS: '기존 프로젝트를 이어서 쓰거나, 처음부터 다시 하려면 프로젝트 초기화를 먼저 하세요.',
  CLEANUP_PENDING: 'Runner를 연결해 정리 명령을 끝낸 뒤 다시 시도하세요.',
  VERSION_CONFLICT: '최신 상태를 다시 불러와 확인한 뒤 다시 시도하세요.',
  DECISIONS_PENDING: '대기 중인 기술 결정을 모두 승인 또는 반려한 뒤 확정하세요.',
  SPLIT_JUDGEMENT_REQUIRED: '재분석을 요청해 Planning이 규칙 5·7·9를 다시 판단한 초안으로 승인하세요.',
  INPUT_UNCHANGED: '새 커밋을 push한 뒤 다시 분석하세요.',
  LEASE_LOST: '보고를 멈추고 작업을 다시 받으세요.',
};

/** 프로젝트 업무 오류. 공통 오류 형식에 입력 오류 목록(`errors[]`)과 사용자용 문구를 함께 싣는다. */
export class ProjectError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly errors: InputError[];
  readonly fix: string | undefined;
  constructor(code: ErrorCode, options: { details?: Record<string, unknown>; errors?: InputError[]; message?: string; fix?: string } = {}) {
    super(options.message ?? MESSAGES[code] ?? '요청을 처리할 수 없습니다.');
    this.code = code;
    this.details = options.details ?? {};
    this.errors = options.errors ?? [];
    this.fix = options.fix;
  }
}

/**
 * 프로젝트 라우트 범위의 오류 처리. 프로젝트 오류와 형식 검증 오류만 직접 답하고,
 * 그 밖의 오류(인증·세대·멱등·DB)는 공통 처리기(platform)로 넘긴다.
 */
export function installProjectErrors(scope: FastifyInstance, action: (method: string, url: string) => string): void {
  scope.setErrorHandler((error, request, reply) => {
    if (error instanceof JcsError) error = new ProjectError('VALIDATION_FAILED', { errors: [{ path: 'body', rule: 'JCS', message: error.message }] });
    const failure = error as { validation?: FastifySchemaValidationError[] };
    if (!(error instanceof ProjectError) && !failure.validation) throw error;
    // 형식 검증 오류의 경로·규칙 변환은 공통 처리(platform validationErrors)를 그대로 쓴다(리뷰 8).
    const problem = error instanceof ProjectError ? error : new ProjectError('VALIDATION_FAILED', { errors: validationErrors(failure.validation ?? []) });
    return reply.code(ERROR_STATUS[problem.code]).send(errorBody({
      code: problem.code, message: redactText(problem.message), action: action(request.method, request.routeOptions.url ?? ''),
      fix: redactText(problem.fix ?? FIXES[problem.code] ?? '현재 상태를 다시 불러와 확인한 뒤 다시 시도하세요.'),
      errors: redact(problem.errors) as InputError[], details: redact(problem.details) as Record<string, unknown>, requestId: request.id,
    }));
  });
}
