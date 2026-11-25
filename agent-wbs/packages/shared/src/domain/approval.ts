export interface ApprovalInput {
  purpose: string;
  doneCond: string;
  ac: readonly unknown[];
  checklist: readonly unknown[];
  outputs: readonly { required: boolean }[];
  assignee: 'Claude' | 'Codex' | null;
  verifier: 'Claude' | 'Codex' | null;
}

// contracts §2.5: request and approval both check the current stored specification.
export function approvalReasons(spec: ApprovalInput): string[] {
  const reasons: string[] = [];
  if (!spec.purpose.trim()) reasons.push('작업 목적이 필요합니다.');
  if (!spec.doneCond.trim()) reasons.push('완료 조건이 필요합니다.');
  if (!spec.ac.length) reasons.push('Acceptance Criteria가 1개 이상 필요합니다.');
  if (!spec.checklist.length) reasons.push('체크리스트가 1개 이상 필요합니다.');
  if (!spec.outputs.some(output => output.required)) reasons.push('필수 산출물이 1개 이상 필요합니다.');
  if (!spec.assignee) reasons.push('담당 Agent 지정이 필요합니다.');
  if (!spec.verifier) reasons.push('검증 Agent 지정이 필요합니다.');
  return reasons;
}
