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
  let previousMain = -1;
  const chain = proof.chain ?? [proof];
  if (proof.chain && chain.length < 2) return fail();
  for (const step of chain) {
    const main = observed.indexOf(step.parents[1] ?? '');
    if (!step.preserved || step.additionalChanges || step.qaHeadSha !== previous || step.parents.length !== 2 ||
      step.parents[0] !== previous || step.autoMergeTreeSha !== step.headTreeSha ||
      proof.chain && main <= previousMain) return fail();
    previous = step.headSha;
    previousMain = main;
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

/** Git의 자식→부모 순서와 H′ 연결을 확인한다. main 부모와 끊긴 커밋은 Task 근거가 아니다. */
export function checkMergeCommits(commits: { commit:string;parents:string[] }[], parents: string[]) {
  const [base,head] = parents;
  const byCommit = new Map(commits.map((c,index) => [c.commit,{ ...c,index }]));
  if (!base || !head || byCommit.size !== commits.length || byCommit.has(base) || commits[0]?.commit !== head ||
    commits.some((c,i) => c.parents.some(p => (byCommit.get(p)?.index ?? Infinity) <= i))) throw new PlatformError('VALIDATION_FAILED');
  const reached = new Set<string>(), pending = [head];
  while (pending.length) {
    const row = byCommit.get(pending.pop() ?? '');
    if (!row || reached.has(row.commit)) continue;
    reached.add(row.commit);
    pending.push(...row.parents);
  }
  if (reached.size !== commits.length) throw new PlatformError('VALIDATION_FAILED');
}
