import { checklistSummary } from './checklist.ts';
import type { ChecklistItem, CodeBasis, Verification, VerificationResult } from './types.ts';

export interface TaskCheck extends CodeBasis {
  result: 'PASS' | 'FAIL';
}

export interface Integration {
  result: 'PASS' | 'FAIL';
  qaHeadSha: string;
  headSha: string;
  baseSha: string;
  pipelineSha: string;
  treeSha: string;
  // M7 must mechanically verify the clean H -> H' merge before setting this.
  qaBasisPreserved: boolean;
}

export function verificationCurrent(
  basis: CodeBasis, verification: Verification, integration: Integration | null = null,
): boolean {
  const sameHead = verification.headSha === basis.headSha || (
    integration?.result === 'PASS' && integration.qaBasisPreserved &&
    integration.qaHeadSha === verification.headSha && integration.headSha === basis.headSha
  );
  return sameHead && !verification.invalidated &&
    verification.specRevision === basis.specRevision && verification.inputVersion === basis.inputVersion;
}

export interface GateInput {
  checklist: readonly Pick<ChecklistItem, 'required' | 'done'>[];
  outputs: readonly { name: string; required: boolean; delivered: boolean }[];
  basis: CodeBasis;
  verification: Verification | null;
  taskCheck: TaskCheck | null;
  unresolvedBlockingDefects: number;
  planningApprovedAt: string | null;
  integration: Integration | null;
}

export interface GateCondition {
  key: 'checklist' | 'outputs' | 'verification' | 'defects' | 'approval';
  result: VerificationResult;
  reason: string;
}

export function completionGate(input: GateInput): GateCondition[] {
  const checklist = checklistSummary(input.checklist);
  const requiredOutputs = input.outputs.filter(output => output.required);
  const missingOutputs = requiredOutputs.filter(output => !output.delivered);
  const verification = input.verification;
  const taskCheck = input.taskCheck;
  let verificationResult: VerificationResult = 'BLOCKED';
  let verificationReason = '현재 코드·명세·입력에 유효한 검증이 필요합니다.';
  if (verification && verificationCurrent(input.basis, verification, input.integration)) {
    if (verification.result === 'FAIL') {
      verificationResult = 'FAIL';
      verificationReason = '최근 QA FAIL — 재작업 후 재검증 필요';
    } else if (verification.result === 'PASS' && taskCheck &&
      taskCheck.headSha === input.basis.headSha && taskCheck.specRevision === input.basis.specRevision &&
      taskCheck.inputVersion === input.basis.inputVersion) {
      verificationResult = taskCheck.result;
      verificationReason = taskCheck.result === 'PASS' ? '최근 검증과 ① Task 검사 PASS' : '① Task 검사 FAIL';
    }
  }
  return [
    { key: 'checklist', result: checklist.total && !checklist.requiredLeft ? 'PASS' : 'FAIL',
      reason: !checklist.total ? '체크리스트 미등록' :
        checklist.requiredLeft ? `필수 항목 ${checklist.requiredLeft}건 미완료` : '필수 항목 모두 완료' },
    { key: 'outputs', result: requiredOutputs.length && !missingOutputs.length ? 'PASS' : 'FAIL',
      reason: !requiredOutputs.length ? '필수 산출물 미지정' : missingOutputs.length ?
        `미제출: ${missingOutputs.map(output => output.name).join(', ')}` : '필수 산출물 모두 제출' },
    { key: 'verification', result: verificationResult, reason: verificationReason },
    { key: 'defects', result: input.unresolvedBlockingDefects === 0 ? 'PASS' : 'FAIL',
      reason: input.unresolvedBlockingDefects === 0 ? '미해결 차단 결함 없음' :
        `차단 결함 ${input.unresolvedBlockingDefects}건 미해결` },
    { key: 'approval', result: input.planningApprovedAt ? 'PASS' : 'BLOCKED',
      reason: input.planningApprovedAt ? '팀장 착수 승인 완료' : '팀장 착수 승인 대기' },
  ];
}

export interface CompletionInput extends GateInput {
  currentBaseSha: string;
  currentPipelineSha: string;
  merge: { mergeSha: string; headSha: string; baseSha: string; treeSha: string } | null;
}

export function canComplete(input: CompletionInput): boolean {
  const { integration, merge, verification } = input;
  return completionGate(input).every(condition => condition.result === 'PASS') &&
    integration?.result === 'PASS' && verification !== null &&
    integration.qaHeadSha === verification.headSha && integration.headSha === input.basis.headSha &&
    integration.baseSha === input.currentBaseSha && integration.pipelineSha === input.currentPipelineSha &&
    merge !== null && merge.mergeSha.length > 0 && merge.headSha === integration.headSha &&
    merge.baseSha === integration.baseSha && merge.treeSha === integration.treeSha;
}
