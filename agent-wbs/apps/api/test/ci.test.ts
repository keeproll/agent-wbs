import { expect, test } from 'vitest';
import { preservedHead, assertCiTransition } from '../src/ci/proof.ts';

const qa = 'a'.repeat(40), base = 'b'.repeat(40), head = 'c'.repeat(40), tree = 'd'.repeat(40);
const proof = { qaHeadSha:qa,headSha:head,preserved:true,parents:[qa,base],autoMergeTreeSha:tree,headTreeSha:tree,additionalChanges:false };

test('H→H′는 부모 H·A, 자동 병합 tree, 추가 변경 없음까지 일치해야 QA 근거를 잇는다', () => {
  expect(preservedHead(qa,head,base,tree,proof)).toEqual({ qaHeadSha:qa,headSha:head,preserved:true });
  expect(preservedHead(qa,qa,base,tree)).toBeNull();
  for (const changed of [{ parents:[base,qa] },{ parents:[qa,base,head] },{ autoMergeTreeSha:qa },{ headTreeSha:qa },
    { additionalChanges:true },{ preserved:false },{ qaHeadSha:base },{ headSha:qa }]) {
    expect(() => preservedHead(qa,head,base,tree,{ ...proof,...changed })).toThrow();
  }
  expect(() => preservedHead(qa,head,base,tree)).toThrow();
});

test('CI 실행은 순서대로 진행하고 최종 결과를 다른 결과로 바꾸지 않는다', () => {
  for (const [before,after] of [['queued','run'],['run','pass'],['run','fail'],['run','skip'],['pass','pass']] as const) {
    expect(() => assertCiTransition(before,after)).not.toThrow();
  }
  for (const [before,after] of [['queued','pass'],['pass','fail'],['fail','run'],['skip','queued'],['run','queued']] as const) {
    expect(() => assertCiTransition(before,after)).toThrow();
  }
});
