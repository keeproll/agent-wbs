import type { HeadSync } from '@awbs/shared';
import { PlatformError } from '../platform/errors.ts';

export interface HeadProof extends HeadSync {
  parents: string[];
  autoMergeTreeSha: string;
  headTreeSha: string;
  additionalChanges: boolean;
}

/** Runner의 git 관측을 저장된 H·A·검사 tree와 대조해 QA 근거를 잇는다. */
export function preservedHead(qa: string, head: string, base: string, tree: string, proof?: HeadProof | null): HeadSync | null {
  if (qa === head) return null;
  if (!proof?.preserved || proof.qaHeadSha !== qa || proof.headSha !== head || proof.additionalChanges ||
    proof.parents.length !== 2 || proof.parents[0] !== qa || proof.parents[1] !== base ||
    proof.autoMergeTreeSha !== tree || proof.headTreeSha !== tree) throw new PlatformError('GATE_NOT_PASSED');
  return { qaHeadSha:qa,headSha:head,preserved:true };
}

export function assertCiTransition(before: string, after: string) {
  if (before === after || before === 'queued' && after === 'run' || before === 'run' && ['pass','fail','skip'].includes(after)) return;
  throw new PlatformError('INVALID_TRANSITION');
}
