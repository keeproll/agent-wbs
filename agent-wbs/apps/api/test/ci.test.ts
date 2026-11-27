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


test('결정 16: 관측된 main을 잇는 두 단계 사슬은 원래 QA를 보존하고 중간 변조는 거부한다', () => {
  const nextBase = 'e'.repeat(40), nextHead = 'f'.repeat(40), nextTree = '1'.repeat(40);
  const last = { ...proof,qaHeadSha:head,headSha:nextHead,parents:[head,nextBase],autoMergeTreeSha:nextTree,headTreeSha:nextTree };
  const chain = { ...last,qaHeadSha:qa,chain:[proof,last] };
  expect(preservedHead(qa,nextHead,nextBase,nextTree,chain,[base,nextBase])).toEqual({ qaHeadSha:qa,headSha:nextHead,preserved:true });
  for (const altered of [{ ...proof,headTreeSha:qa },{ ...proof,parents:[qa,qa] },{ ...proof,additionalChanges:true }]) {
    expect(() => preservedHead(qa,nextHead,nextBase,nextTree,{ ...chain,chain:[altered,last] },[base,nextBase])).toThrow();
  }
  expect(() => preservedHead(qa,nextHead,nextBase,nextTree,{ ...chain,chain:[proof,{ ...last,qaHeadSha:qa }] },[base,nextBase])).toThrow();
  expect(() => preservedHead(qa,nextHead,nextBase,nextTree,{ ...chain,parents:[qa,nextBase] },[base,nextBase])).toThrow();
});


test.each(['reverse','repeat'])('리뷰3: 동기화 사슬의 main %s는 거부한다', order => {
  const nextBase='e'.repeat(40), nextHead='f'.repeat(40), nextTree='1'.repeat(40);
  const finalBase=order==='reverse' ? base : nextBase;
  const first={ ...proof,parents:[qa,nextBase] };
  const last={ ...proof,qaHeadSha:head,headSha:nextHead,parents:[head,finalBase],autoMergeTreeSha:nextTree,headTreeSha:nextTree };
  expect(() => preservedHead(qa,nextHead,finalBase,nextTree,{ ...last,qaHeadSha:qa,chain:[first,last] },[base,nextBase])).toThrow();
});
