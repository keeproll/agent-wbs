import { approvalReasons, type ApprovalInput } from '@awbs/shared';

/** 공통 판정(approvalReasons)의 사유 순서와 같은 순서의 입력 경로 */
const PATHS = ['overview.purpose', 'overview.doneCond', 'ac', 'checklist', 'outputs', 'assigneeAgent', 'verifierAgent'] as const;
const PROBES: readonly ApprovalInput[] = PATHS.map((_, index) => ({
  purpose: index === 0 ? '' : 'x', doneCond: index === 1 ? '' : 'x', ac: index === 2 ? [] : [1], checklist: index === 3 ? [] : [1],
  outputs: index === 4 ? [] : [{ required: true }], assignee: index === 5 ? null : 'Claude', verifier: index === 6 ? null : 'Codex',
}));
// 사유 문구를 한 번씩 만들어 경로와 짝짓는다. 문구가 바뀌어도 짝이 어긋나지 않는다.
const PATH_OF = new Map(PROBES.map((probe, index) => [approvalReasons(probe)[0] ?? '', PATHS[index] ?? '']));

/** 착수 승인 요청·승인의 필수 항목 검사 결과를 400 `errors[]` 모양으로 바꾼다. */
export function approvalErrors(input: ApprovalInput) {
  return approvalReasons(input).map((message) => ({ path: PATH_OF.get(message) ?? 'task', rule: 'required', message }));
}
