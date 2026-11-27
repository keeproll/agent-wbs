import { PlatformError } from '../platform/errors.ts';

/**
 * Runner가 보고한 PR 번호가 그 시도의 agent 브랜치 PR인지 head 이름으로 대조한다(M5·M7 통합 조정자 결정 1).
 * 왜: 서버는 git·GitHub를 읽지 않는다. 다른 Task 브랜치의 PR 번호로 통합 job이 만들어지면 엉뚱한 PR을 병합한다.
 * PR을 보고하지 않으면(둘 다 없음) 아무것도 하지 않는다. 한쪽만 오거나 브랜치가 다르면 400이다.
 */
export function checkPullRequest(body: { pr?: number; prHead?: string }, branch: string | null): number | undefined {
  if (body.pr === undefined && body.prHead === undefined) return undefined;
  const error = (message: string) => new PlatformError('VALIDATION_FAILED', {}, [{ path: 'prHead', rule: 'pull_request', message }]);
  if (body.pr === undefined || body.prHead === undefined) throw error('PR 번호와 head 브랜치 이름은 함께 보내야 합니다.');
  if (!branch || body.prHead !== branch) throw error('PR의 head 브랜치가 이 시도의 브랜치와 다릅니다.');
  return body.pr;
}
