import { checklistSummary } from './checklist.ts';
import type { ChecklistItem, CodeBasis, Verification, VerificationResult } from './types.ts';

export interface TaskCheck extends CodeBasis {
  result: 'PASS' | 'FAIL';
}

// M7 verifies clean H -> H' mechanically; QA preservation does not depend on ②'s outcome.
export interface HeadSync {
  qaHeadSha: string;
  headSha: string;
  preserved: boolean;
}

export interface Integration {
  result: 'PASS' | 'FAIL';
  qaHeadSha: string;
  headSha: string;
  baseSha: string;
  pipelineSha: string;
  treeSha: string;
}

export function verificationCurrent(
  basis: CodeBasis, verification: Verification, headSync: HeadSync | null = null,
): boolean {
  const sameHead = verification.headSha === basis.headSha || (
    headSync?.preserved === true && headSync.qaHeadSha === verification.headSha && headSync.headSha === basis.headSha
  );
  return sameHead && !verification.invalidated &&
    verification.specRevision === basis.specRevision && verification.inputVersion === basis.inputVersion;
}

export interface GateInput {
  checklist: readonly Pick<ChecklistItem, 'required' | 'done'>[];
  outputs: readonly { name: string; required: boolean; delivered: boolean }[];
  basis: CodeBasis;
  verification: Verification | null;
  verificationState?: 'none' | 'running' | 'completed';
  taskCheck: TaskCheck | null;
  unresolvedBlockingDefects: number;
  planningApprovedAt: string | null;
  headSync: HeadSync | null;
}

export interface GateCondition {
  key: 'checklist' | 'outputs' | 'verification' | 'defects' | 'approval';
  result: VerificationResult;
  reason: string;
}

function verificationCondition(input: GateInput): GateCondition {
  const { verification, taskCheck, basis } = input;
  const blocked = (reason: string): GateCondition => ({ key: 'verification', result: 'BLOCKED', reason });
  if (input.verificationState === 'running') return blocked('검증 진행 중');
  if (!verification) return blocked('검증 미실시');
  if (verification.invalidated) return blocked('검증 근거 무효화 — 재검증 필요');
  if (verification.specRevision !== basis.specRevision) return blocked('명세 변경 — 재검증 필요');
  if (verification.inputVersion !== basis.inputVersion) return blocked('입력 버전 변경 — 재검증 필요');
  if (!verificationCurrent(basis, verification, input.headSync)) return blocked('head SHA 변경 — 재검증 필요');
  if (verification.result === 'BLOCKED') return blocked('검증 BLOCKED — 원인 해결 후 재검증 필요');
  if (verification.result === 'FAIL') return { key: 'verification', result: 'FAIL', reason: '최근 QA FAIL — 재작업 후 재검증 필요' };
  if (!taskCheck) return blocked('① Task 검사 미실시');
  if (taskCheck.headSha !== basis.headSha || taskCheck.specRevision !== basis.specRevision || taskCheck.inputVersion !== basis.inputVersion) {
    return blocked('① Task 검사 근거가 현재 코드·명세·입력과 다름');
  }
  return { key: 'verification', result: taskCheck.result,
    reason: taskCheck.result === 'PASS' ? '최근 검증과 ① Task 검사 PASS' : '① Task 검사 FAIL' };
}

export function completionGate(input: GateInput): GateCondition[] {
  const checklist = checklistSummary(input.checklist);
  const requiredOutputs = input.outputs.filter(output => output.required);
  const missingOutputs = requiredOutputs.filter(output => !output.delivered);
  return [
    { key: 'checklist', result: checklist.total && !checklist.requiredLeft ? 'PASS' : 'FAIL',
      reason: !checklist.total ? '체크리스트 미등록' :
        checklist.requiredLeft ? `필수 항목 ${checklist.requiredLeft}건 미완료` : '필수 항목 모두 완료' },
    { key: 'outputs', result: requiredOutputs.length && !missingOutputs.length ? 'PASS' : 'FAIL',
      reason: !input.outputs.length ? '예상 산출물 미정의' : !requiredOutputs.length ? '필수 산출물 미지정' : missingOutputs.length ?
        `미제출: ${missingOutputs.map(output => output.name).join(', ')}` : '필수 산출물 모두 제출' },
    verificationCondition(input),
    { key: 'defects', result: input.unresolvedBlockingDefects === 0 ? 'PASS' : 'FAIL',
      reason: input.unresolvedBlockingDefects === 0 ? '미해결 차단 결함 없음' : `차단 결함 ${input.unresolvedBlockingDefects}건 미해결` },
    { key: 'approval', result: input.planningApprovedAt ? 'PASS' : 'BLOCKED',
      reason: input.planningApprovedAt ? '팀장 착수 승인 완료' : '팀장 착수 승인 대기' },
  ];
}

export interface IntegrationEntryInput extends GateInput {
  dependenciesMet: boolean;
  baseSha: string;
  pipelineSha: string;
  currentBaseSha: string;
  currentPipelineSha: string;
}

// Check immediately before ②/merge; after a successful merge, main and its pipeline can advance normally.
export function canIntegrate(input: IntegrationEntryInput): boolean {
  return completionGate(input).every(condition => condition.result === 'PASS') && input.dependenciesMet &&
    input.baseSha === input.currentBaseSha && input.pipelineSha === input.currentPipelineSha;
}

export interface CompletionInput extends GateInput {
  // First Runner observation at main A, matched by the server independently of CI run reports.
  basePipelineSha: string;
  integration: Integration | null;
  merge: { mergeSha: string; headSha: string; baseSha: string; treeSha: string } | null;
}

export function completionReasons(input: CompletionInput): string[] {
  const reasons = completionGate(input).filter(condition => condition.result !== 'PASS').map(condition => condition.reason);
  const { integration, merge, verification } = input;
  if (!integration || integration.result !== 'PASS') reasons.push('② 통합 확인 PASS가 필요합니다.');
  if (integration && integration.pipelineSha !== input.basePipelineSha) {
    reasons.push('② 통합 확인의 pipeline SHA가 병합 기준 main 정의와 다릅니다.');
  }
  if (integration && (integration.qaHeadSha !== verification?.headSha || integration.headSha !== input.basis.headSha)) {
    reasons.push('② 통합 확인의 QA/head 근거가 현재 검증과 다릅니다.');
  }
  if (!merge || !merge.mergeSha) reasons.push('실제 PR 병합 확인이 필요합니다.');
  if (merge && integration && (merge.headSha !== integration.headSha || merge.baseSha !== integration.baseSha || merge.treeSha !== integration.treeSha)) {
    reasons.push('실제 병합 head/base/tree가 검사한 병합본과 다릅니다.');
  }
  return reasons;
}

export function canComplete(input: CompletionInput): boolean {
  return completionReasons(input).length === 0;
}
