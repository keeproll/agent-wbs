import { describe, expectTypeOf, it } from 'vitest';
import type { BodyOf, OperationOf, ParamsOf } from '../src/shared/api/contract.ts';

// typecheck(W typecheck)가 이 파일을 검사한다. 실행 시험은 형식만 통과한다.
describe('계약 타입: .map으로 만든 요청도 이름으로 고른다(M3-05에서 발견한 never 결함)', () => {
  it('approve·apply·submit·reject·request-changes의 경로와 본문', () => {
    expectTypeOf<OperationOf<'approveProposal'>['method']>().toEqualTypeOf<'POST'>();
    expectTypeOf<ParamsOf<'applyProposal'>>().toEqualTypeOf<Record<'id', string>>();
    expectTypeOf<ParamsOf<'submitProposal'>>().toEqualTypeOf<Record<'id', string>>();
    expectTypeOf<BodyOf<'rejectProposal'>>().toHaveProperty('updatedAt');
    expectTypeOf<BodyOf<'approveProposal'>>().toHaveProperty('previewHash');
  });
  it('정확한 이름의 요청은 이전처럼 하나만 고른다', () => {
    expectTypeOf<OperationOf<'getTask'>['path']>().toEqualTypeOf<'/api/tasks/:taskKey'>();
  });
});
