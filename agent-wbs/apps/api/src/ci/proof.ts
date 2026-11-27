import type { HeadSync } from '@awbs/shared';
import { PlatformError } from '../platform/errors.ts';

export interface HeadProof extends HeadSync {
  parents: string[];
  autoMergeTreeSha: string;
  headTreeSha: string;
  additionalChanges: boolean;
  chain?: Omit<HeadProof,'chain'>[];
}

/** Runner의 git 관측을 저장된 H·A·검사 tree와 대조해 QA 근거를 잇는다. */
export function preservedHead(qa: string, head: string, base: string, tree: string, proof?: HeadProof | null, observed: readonly string[] = []): HeadSync | null {
  if (qa === head) return null;
  const fail = () => { throw new PlatformError('GATE_NOT_PASSED'); };
  if (!proof?.preserved || proof.qaHeadSha !== qa || proof.headSha !== head || proof.additionalChanges) return fail();
  let previous = qa;
  const chain = proof.chain ?? [proof];
  if (proof.chain && chain.length < 2) return fail();
  for (const step of chain) {
    if (!step.preserved || step.additionalChanges || step.qaHeadSha !== previous || step.parents.length !== 2 ||
      step.parents[0] !== previous || step.autoMergeTreeSha !== step.headTreeSha ||
      proof.chain && !observed.includes(step.parents[1] ?? '')) return fail();
    previous = step.headSha;
  }
  const last = chain.at(-1);
  if (!last || previous !== head || last.parents[1] !== base || last.headTreeSha !== tree || proof.autoMergeTreeSha !== tree ||
    proof.headTreeSha !== tree || JSON.stringify(proof.parents) !== JSON.stringify(last.parents)) return fail();
  return { qaHeadSha:qa,headSha:head,preserved:true };
}

export function assertCiTransition(before: string, after: string) {
  if (before === after || before === 'queued' && after === 'run' || before === 'run' && ['pass','fail','skip'].includes(after)) return;
  throw new PlatformError('INVALID_TRANSITION');
}
