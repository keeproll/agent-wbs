import { Value } from 'typebox/value';
import { OPERATIONS } from './index.ts';
import type { TSchema } from 'typebox';

/**
 * 서버가 job을 큐에 넣기 전에 payload가 계약(claimJob 응답의 ClaimedJob)과 맞는지 검사한다.
 * Runner는 claim 응답으로 이 payload를 받으므로, 저장할 때 맞춰 두지 않으면 계약대로 만든 소비자가 처리하지 못한다(M2-08 리뷰 지적 1).
 * 문제가 없으면 빈 배열, 있으면 `경로: 메시지` 목록.
 */
export function jobPayloadErrors(kind: string, payload: unknown): string[] {
  const claim = OPERATIONS.find((op) => op.id === 'claimJob');
  const job = (claim?.responses[200] as { properties?: { job?: { anyOf?: TSchema[] } } } | undefined)?.properties?.job;
  const branch = job?.anyOf?.find((item) => (item as { properties?: { kind?: { enum?: string[]; const?: string } } }).properties?.kind?.enum?.includes(kind)
    || (item as { properties?: { kind?: { const?: string } } }).properties?.kind?.const === kind);
  const schema = (branch as { properties?: { payload?: TSchema } } | undefined)?.properties?.payload;
  if (!schema) return [`알 수 없는 job 종류: ${kind}`];
  return [...Value.Errors(schema, payload)].map((error) => `${(error as { instancePath?: string }).instancePath || '/'}: ${error.message}`);
}
